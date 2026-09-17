import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

const PROBE_SCHEMA_VERSION = 1;
const MAX_BODY_BYTES = 8 * 1024;
const PROBE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{8,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function safeEqualText(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function errorResponse(res, status, errorCode) {
  return res.status(status).json({ ok: false, status: 'REJECTED', error_code: errorCode });
}

export function createGate0ProbeHandler({
  secret = process.env.GATE0_AUTOMATION_PROBE_SECRET,
  now = () => new Date(),
} = {}) {
  return async function gate0ProbeHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req?.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return errorResponse(res, 405, 'METHOD_NOT_ALLOWED');
    }
    if (!secret) return errorResponse(res, 503, 'PROBE_NOT_CONFIGURED');

    const body = req?.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || jsonSize(body) > MAX_BODY_BYTES) {
      return errorResponse(res, 400, 'INVALID_SCHEMA');
    }

    const providedSecret = req?.headers?.['x-gate0-token'] || body.automation_token;
    if (!safeEqualText(providedSecret, secret)) {
      return errorResponse(res, 401, 'INVALID_PROBE_TOKEN');
    }

    const schemaVersion = Number(body.schema_version);
    const probeId = String(body.probe_id || '').trim();
    const sourceRecordId = String(body.source_record_id || '').trim();
    const payloadHash = String(body.payload_hash || '').trim().toLowerCase();
    const sentAt = String(body.sent_at || '').trim();
    const sentAtMs = Date.parse(sentAt);

    if (schemaVersion !== PROBE_SCHEMA_VERSION
      || !PROBE_ID_RE.test(probeId)
      || !RECORD_ID_RE.test(sourceRecordId)
      || !SHA256_RE.test(payloadHash)
      || !Number.isFinite(sentAtMs)) {
      return errorResponse(res, 400, 'INVALID_SCHEMA');
    }

    const ackId = `gate0-${createHash('sha256')
      .update(`${probeId}:${sourceRecordId}:${payloadHash}`)
      .digest('hex')
      .slice(0, 24)}`;

    return res.status(200).json({
      ok: true,
      status: 'ACKNOWLEDGED',
      probe_id: probeId,
      source_record_id: sourceRecordId,
      payload_hash: payloadHash,
      ack_id: ackId,
      received_at: now().toISOString(),
    });
  };
}
