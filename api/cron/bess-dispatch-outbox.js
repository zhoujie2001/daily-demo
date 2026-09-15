import { timingSafeEqual } from 'node:crypto';
import { runDispatchOutbox } from '../../lib/dispatch/outbox-worker.js';

function matches(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
  }
  const expected = process.env.CRON_SECRET;
  const actual = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !matches(actual, expected)) return res.status(401).json({ ok: false, error_code: 'UNAUTHORIZED' });
  try {
    const result = await runDispatchOutbox();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error?.status || 503).json({ ok: false, error_code: error?.code || 'OUTBOX_WORKER_UNAVAILABLE' });
  }
}
