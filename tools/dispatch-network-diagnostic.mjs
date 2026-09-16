#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const METRIC_MARKER = '__BESS_DIAG__';

function parseArgs(argv) {
  const result = { samples: 50, timeoutSeconds: 8, endpoints: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (['--custom', '--vercel', '--preview'].includes(value)) {
      result.endpoints.push({ name: value.slice(2), url: next }); index += 1;
    } else if (value === '--samples') { result.samples = Number(next); index += 1; }
    else if (value === '--timeout') { result.timeoutSeconds = Number(next); index += 1; }
    else if (value === '--status-chat-id') { result.chatId = next; index += 1; }
    else if (value === '--status-batch-id') { result.batchId = next; index += 1; }
    else if (value === '--help') { result.help = true; }
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function usage() {
  return `Usage: node tools/dispatch-network-diagnostic.mjs \\
  --custom https://www.littlearisa88.com \\
  --vercel https://<production>.vercel.app \\
  --preview https://<preview>.vercel.app [--samples 50] [--timeout 8] \\
  [--status-chat-id oc_xxx --status-batch-id existing-batch]\n\nBy default the script performs read-only GET probes. To probe /api/dispatch/status,\nset both status arguments and BESS_DISPATCH_INGEST_SECRET in the environment.`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function stats(values) {
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function summarize(rows) {
  const successful = rows.filter((row) => row.ok);
  const timings = (field) => stats(successful.map((row) => row[field]).filter(Number.isFinite));
  const group = (field) => Object.fromEntries([...new Set(rows.map((row) => row[field]))].map((value) => [
    value,
    summarize(rows.filter((row) => row[field] === value)),
  ]));
  const summary = {
    samples: rows.length,
    success_rate: rows.length ? successful.length / rows.length : 0,
    timeout_rate: rows.length ? rows.filter((row) => row.timeout).length / rows.length : 0,
    total_ms: timings('total_ms'),
    dns_ms: timings('dns_ms'),
    connect_ms: timings('connect_ms'),
    tls_ms: timings('tls_ms'),
    ttfb_ms: timings('ttfb_ms'),
  };
  if (new Set(rows.map((row) => row.ip_family)).size > 1) summary.by_ip_family = group('ip_family');
  if (new Set(rows.map((row) => row.requested_http_version)).size > 1) summary.by_http_version = group('requested_http_version');
  return summary;
}

async function probe(endpoint, variant, options, index) {
  const useStatus = Boolean(options.chatId && options.batchId);
  const body = useStatus ? { chat_id: options.chatId, batch_id: options.batchId } : null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = new URL(useStatus ? '/api/dispatch/status' : '/', endpoint.url).toString();
  const format = `${METRIC_MARKER}{"http_status":%{http_code},"dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"total":%{time_total},"remote_ip":"%{remote_ip}","http_version":"%{http_version}"}`;
  const args = [
    '--silent', '--show-error', '--output', '/dev/null', '--write-out', format,
    '--connect-timeout', '3', '--max-time', String(options.timeoutSeconds),
    variant.ipFamily === 'ipv4' ? '--ipv4' : '--ipv6',
    variant.httpVersion === 'http1.1' ? '--http1.1' : '--http2',
    '--header', `X-Bess-Request-Id: diag-${randomUUID()}`,
  ];
  if (useStatus) {
    const secret = process.env.BESS_DISPATCH_INGEST_SECRET;
    if (!secret) throw new Error('BESS_DISPATCH_INGEST_SECRET is required for status probes');
    const signature = createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
    args.push(
      '--request', 'POST',
      '--header', 'Content-Type: application/json',
      '--header', `X-Bess-Timestamp: ${timestamp}`,
      '--header', `X-Bess-Signature: sha256=${signature}`,
      '--data-binary', JSON.stringify(body),
    );
  }
  args.push(url);
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: (options.timeoutSeconds + 2) * 1000 });
    const marker = stdout.lastIndexOf(METRIC_MARKER);
    const metrics = JSON.parse(stdout.slice(marker + METRIC_MARKER.length));
    return {
      endpoint: endpoint.name,
      sample: index + 1,
      ip_family: variant.ipFamily,
      requested_http_version: variant.httpVersion,
      http_status: metrics.http_status,
      ok: metrics.http_status >= 200 && metrics.http_status < 500,
      timeout: false,
      dns_ms: metrics.dns * 1000,
      connect_ms: Math.max(0, (metrics.connect - metrics.dns) * 1000),
      tls_ms: Math.max(0, (metrics.tls - metrics.connect) * 1000),
      ttfb_ms: metrics.ttfb * 1000,
      total_ms: metrics.total * 1000,
      remote_ip: metrics.remote_ip,
      http_version: metrics.http_version,
    };
  } catch (error) {
    return {
      endpoint: endpoint.name,
      sample: index + 1,
      ip_family: variant.ipFamily,
      requested_http_version: variant.httpVersion,
      ok: false,
      timeout: error?.killed === true || error?.code === 'ETIMEDOUT' || /timed out/i.test(String(error?.stderr || error?.message)),
      total_ms: Date.now() - startedAt,
      error_class: String(error?.code || error?.name || 'CURL_ERROR').slice(0, 80),
    };
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
if (options.endpoints.length !== 3 || !Number.isInteger(options.samples) || options.samples < 50) {
  console.error(usage());
  throw new Error('Exactly three endpoints and at least 50 samples per endpoint are required');
}
if (Boolean(options.chatId) !== Boolean(options.batchId)) {
  throw new Error('--status-chat-id and --status-batch-id must be supplied together');
}

const variants = [
  { ipFamily: 'ipv4', httpVersion: 'http1.1' },
  { ipFamily: 'ipv4', httpVersion: 'http2' },
  { ipFamily: 'ipv6', httpVersion: 'http1.1' },
  { ipFamily: 'ipv6', httpVersion: 'http2' },
];
const output = {};
for (const endpoint of options.endpoints) {
  const rows = [];
  for (let index = 0; index < options.samples; index += 1) {
    rows.push(await probe(endpoint, variants[index % variants.length], options, index));
  }
  output[endpoint.name] = { url: endpoint.url, summary: summarize(rows), samples: rows };
}
console.log(JSON.stringify({ generated_at: new Date().toISOString(), read_only: true, endpoints: output }, null, 2));
