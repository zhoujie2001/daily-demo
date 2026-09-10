import { createDispatchSendHandler } from '../../lib/dispatch/api/send.js';
import { createDispatchStatusHandler } from '../../lib/dispatch/api/status.js';
import { createDispatchRevokeHandler } from '../../lib/dispatch/api/revoke.js';

const HANDLERS = Object.freeze({
  send: createDispatchSendHandler,
  status: createDispatchStatusHandler,
  revoke: createDispatchRevokeHandler,
});

export default async function handler(req, res) {
  // Vercel dynamic routes expose the segment under req.query
  const action = String(req?.query?.action || '').trim();
  const factory = HANDLERS[action];
  if (!factory) return res.status(404).json({ ok: false, error_code: 'NOT_FOUND' });
  return factory()(req, res);
}
