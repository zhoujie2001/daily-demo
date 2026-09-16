import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../../../lib/dispatch/supabase-store.js';
import { runDispatchOutbox } from '../../../lib/dispatch/outbox-worker.js';

function matches(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.CRON_SECRET;
  const actual = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !matches(actual, expected)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const store = createSupabaseDispatchStore();
    await store.cleanupExpired(new Date());
    // Normal delivery is queue-driven. This public daily Cron is only a
    // bounded backstop for an already-persisted outbox row.
    const recovery = await runDispatchOutbox({ store, limit: 1 });
    return res.status(200).json({ ok: true, recovery });
  } catch {
    return res.status(503).json({ error: 'Cleanup unavailable' });
  }
}
