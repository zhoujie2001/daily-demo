import process from 'node:process';
import { createHash } from 'node:crypto';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';

const TARGET_DAY = '2026-10-05';
const TARGET_SCOPE = 'ad';

function clean(value) { return String(value || '').trim(); }
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

async function supabaseRequest(path, options = {}) {
  const baseUrl = clean(process.env.SUPABASE_URL).replace(/\/+$/, '');
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!baseUrl || !key) throw new Error('SUPABASE_NOT_CONFIGURED');
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`SUPABASE_${response.status}`);
  return { body, headers: response.headers };
}

async function getState(scope) {
  const result = await supabaseRequest(`bess_dispatch_daily_state?day_key=eq.${TARGET_DAY}&scope=eq.${encodeURIComponent(scope)}&select=*&limit=1`);
  return Array.isArray(result.body) ? (result.body[0] || null) : null;
}

async function getAssignmentCount(scope) {
  const result = await supabaseRequest(`bess_dispatch_assignments?day_key=eq.${TARGET_DAY}&scope=eq.${encodeURIComponent(scope)}&select=request_id`, {
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  const match = String(result.headers.get('content-range') || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : (Array.isArray(result.body) ? result.body.length : null);
}

export function createResetAdRosterOnceHandler() {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' }); }
    }
    try {
      verifyDispatchIngestSignature({
        body,
        timestamp: req.headers?.['x-bess-timestamp'],
        signature: req.headers?.['x-bess-signature'],
        secret: process.env.BESS_DISPATCH_INGEST_SECRET,
      });
      if (body?.day_key !== TARGET_DAY || body?.scope !== TARGET_SCOPE || body?.confirm !== 'RESET_AD_ROSTER_ONCE') {
        return res.status(400).json({ ok: false, error_code: 'TARGET_NOT_ALLOWED' });
      }

      const beforeAd = await getState(TARGET_SCOPE);
      const beforeAssignments = await getAssignmentCount(TARGET_SCOPE);
      const guardBefore = {
        default: fingerprint(await getState('default')),
        game_agent: fingerprint(await getState('game_agent')),
      };
      const deleted = await supabaseRequest(`bess_dispatch_daily_state?day_key=eq.${TARGET_DAY}&scope=eq.${TARGET_SCOPE}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      const afterAd = await getState(TARGET_SCOPE);
      const afterAssignments = await getAssignmentCount(TARGET_SCOPE);
      const guardAfter = {
        default: fingerprint(await getState('default')),
        game_agent: fingerprint(await getState('game_agent')),
      };
      const result = {
        ok: afterAd === null && afterAssignments === 0 && guardBefore.default === guardAfter.default && guardBefore.game_agent === guardAfter.game_agent,
        target: { day_key: TARGET_DAY, scope: TARGET_SCOPE },
        before: {
          state_exists: beforeAd !== null,
          roster_count: Array.isArray(beforeAd?.roster) ? beforeAd.roster.length : 0,
          assignment_count: beforeAssignments,
        },
        delete: { deleted_state_rows: Array.isArray(deleted.body) ? deleted.body.length : null },
        after: { state_exists: afterAd !== null, roster_count: 0, assignment_count: afterAssignments },
        isolation_guard: {
          default_unchanged: guardBefore.default === guardAfter.default,
          game_agent_unchanged: guardBefore.game_agent === guardAfter.game_agent,
        },
      };
      console.info(JSON.stringify({ module: 'reset-ad-roster-once', ...result }));
      return res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : 502;
      const code = error instanceof DispatchIngestError ? error.code : clean(error?.message) || 'RESET_FAILED';
      console.error(JSON.stringify({ module: 'reset-ad-roster-once', ok: false, error_code: code }));
      return res.status(status).json({ ok: false, error_code: code });
    }
  };
}

export default createResetAdRosterOnceHandler();
