import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { createSupabaseDispatchStore } from '../supabase-store.js';

const BRANCH = 'fix/dispatch-anchor-consistency';
const PROJECT = 'prj_AmQbJLMoimeuOM9uLQzjznKcxvXv';
const DATABASE = 'https://cusjrnfczwrbmgkihwls.supabase.co';
const SCOPES = Object.freeze(['ad', 'ad_game']);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function isPublicApiKey(key) {
  if (typeof key !== 'string') return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const segments = key.split('.');
    if (segments.length !== 3) return false;
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString()).role === 'anon';
  } catch { return false; }
}

function inspectSnapshot(snapshot, day, scope) {
  const { state, assignments } = snapshot || {};
  if (!state || !Array.isArray(assignments) || assignments.length < 2
    || state.day_key !== day || state.scope !== scope
    || assignments.some((row) => row.day_key !== day || row.scope !== scope)) {
    throw new Error('SNAPSHOT_CONTRACT_MISMATCH');
  }
  for (let i = 1; i < assignments.length; i += 1) {
    const previous = assignments[i - 1];
    const next = assignments[i];
    const previousTime = Date.parse(previous.created_at);
    const nextTime = Date.parse(next.created_at);
    if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)
      || previousTime < nextTime
      || (previousTime === nextTime && BigInt(previous.id) < BigInt(next.id))) {
      throw new Error('SNAPSHOT_ORDER_MISMATCH');
    }
  }
  return { scope, state_found: true, assignment_count: assignments.length,
    day_scope_match: true, descending_order: true };
}

// Temporary PR #110 verification only. Never use the production service-role
// variable. The Data API credential must independently enforce read-only access.
export function createSnapshotProbeHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  return async function snapshotProbe(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = (status, code) => res.status(status).json({ ok: false, error_code: code });
    if (env.VERCEL_ENV !== 'preview' || env.VERCEL_GIT_COMMIT_REF !== BRANCH
      || env.VERCEL_PROJECT_ID !== PROJECT) return reject(404, 'NOT_FOUND');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reject(405, 'METHOD_NOT_ALLOWED');
    }
    const token = env.PR110_SNAPSHOT_READ_TOKEN;
    const expiry = Date.parse(env.PR110_SNAPSHOT_EXPIRES_AT || '');
    const day = env.PR110_SNAPSHOT_DAY;
    const apiKey = env.PR110_SNAPSHOT_API_KEY;
    if (!/^[a-f0-9]{64}$/.test(token || '') || !Number.isFinite(expiry)
      || expiry <= now() || expiry - now() > 2 * 60 * 60 * 1000
      || !/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !isPublicApiKey(apiKey)) {
      return reject(503, 'PROBE_NOT_CONFIGURED');
    }
    if (!safeEqual(req.headers?.['x-pr110-probe-token'], token)) return reject(403, 'FORBIDDEN');
    // No client-selected dates, scopes, SQL, REST resources, or outbound URLs.
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length)) return reject(400, 'INVALID_SCHEMA');
    const readAt = new Date(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(readAt.getTime()) || readAt.toISOString().slice(0, 10) !== day) {
      return reject(503, 'PROBE_NOT_CONFIGURED');
    }
    let reads = 0;
    const readOnlyFetch = async (input, options) => {
      const url = new URL(input);
      if (url.origin !== DATABASE || url.pathname !== '/rest/v1/bess_dispatch_daily_state'
        || options.method !== 'GET' || options.body !== undefined
        || ++reads > SCOPES.length) throw new Error('PROBE_READ_ONLY_VIOLATION');
      return fetchImpl(input, { ...options, redirect: 'error', headers: {
        ...options.headers, 'x-pr110-read-token': token,
      } });
    };
    const store = createSupabaseDispatchStore({ url: DATABASE, serviceRoleKey: apiKey,
      fetchImpl: readOnlyFetch, logger: {}, timeoutMs: 5000 });
    try {
      const checks = [];
      for (const scope of SCOPES) {
        checks.push(inspectSnapshot(await store.getDispatchSnapshot(day, scope, readAt), day, scope));
      }
      return res.status(200).json({ ok: true, status: 'PASS', checks, database_gets: reads,
        environment: 'preview', commit: env.VERCEL_GIT_COMMIT_SHA || null,
        region: env.VERCEL_REGION || null });
    } catch {
      // Do not echo upstream bodies, error messages, row data, or credentials.
      return reject(502, 'SNAPSHOT_VERIFICATION_FAILED');
    }
  };
}
