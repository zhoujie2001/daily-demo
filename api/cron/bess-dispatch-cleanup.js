import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../../../lib/dispatch/supabase-store.js';

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
    await createSupabaseDispatchStore().cleanupExpired(new Date());
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: 'Cleanup unavailable' });
  }
}
