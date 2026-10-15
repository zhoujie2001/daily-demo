import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../../lib/dispatch/supabase-store.js';
import { runDispatchOutbox } from '../../lib/dispatch/outbox-worker.js';
import { runHandoffReconciliation } from '../../lib/dispatch/api/handoff-reconcile.js';
import { runPendingWritebacks } from '../../lib/dispatch/api/writeback-retry.js';
import { runBasePull } from '../../lib/dispatch/api/pull-base.js';

function matches(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDispatchRecoveryHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  cleanup = (store, now) => store.cleanupExpired(now),
  recoverBasePull = async (store) => (await runBasePull({ store, enforceHistoryIsolation: true })).body,
  recoverHandoffs = (store) => runHandoffReconciliation({ store, limit: 20 }),
  recoverOutbox = (store) => runDispatchOutbox({ store, limit: 3 }),
  recoverWritebacks = (store) => runPendingWritebacks({ store, limit: 20 }),
  secret = process.env.CRON_SECRET,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const actual = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || !matches(actual, secret)) return res.status(401).json({ error: 'Unauthorized' });

    const store = storeFactory();
    const results = {};
    // This is the single Hobby-compatible recovery heartbeat. Each stage is
    // independently bounded so one failure does not suppress later recovery.
    for (const [name, run] of [
      ['cleanup', () => cleanup(store, now())],
      ['basePull', () => recoverBasePull(store)],
      ['handoffs', () => recoverHandoffs(store)],
      ['outbox', () => recoverOutbox(store)],
      ['writebacks', () => recoverWritebacks(store)],
    ]) {
      try {
        results[name] = await run();
      } catch (error) {
        results[name] = { ok: false, error_code: error?.code || `${name.toUpperCase()}_RECOVERY_FAILED` };
      }
    }
    const ok = Object.values(results).every((result) => result?.ok !== false);
    return res.status(ok ? 200 : 207).json({ ok, recovery: results });
  };
}

export default createDispatchRecoveryHandler();
