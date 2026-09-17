import { createDispatchSendHandler } from '../../lib/dispatch/api/send.js';
import { createDispatchStatusHandler } from '../../lib/dispatch/api/status.js';
import { createDispatchStatusBatchHandler } from '../../lib/dispatch/api/status-batch.js';
import { createDispatchRevokeHandler } from '../../lib/dispatch/api/revoke.js';
import { createGate0ProbeHandler } from '../../lib/gate0/api/probe.js';
import { createAutomationSendHandler } from '../../lib/dispatch/api/automation-send.js';

const HANDLERS = Object.freeze({
  send: createDispatchSendHandler,
  status: createDispatchStatusHandler,
  'status-batch': createDispatchStatusBatchHandler,
  'automation-probe': createGate0ProbeHandler,
  'automation-send': createAutomationSendHandler,
  revoke: createDispatchRevokeHandler,
  // Temporary debug echo endpoint — remove after Gate 1 verification
  'automation-echo': () => (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    return res.status(200).json({
      ok: true,
      echo: true,
      body_type: typeof req.body,
      body_keys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : null,
      dispatch_payload_type: typeof req.body?.dispatch_payload,
      dry_run_type: typeof req.body?.dry_run,
      dry_run_value: req.body?.dry_run,
      raw_length: raw?.length,
      raw_preview: raw?.slice(0, 1000),
    });
  },
});

export default async function handler(req, res) {
  // Vercel dynamic routes expose the segment under req.query
  const action = String(req?.query?.action || '').trim();
  const factory = HANDLERS[action];
  if (!factory) return res.status(404).json({ ok: false, error_code: 'NOT_FOUND' });
  return factory()(req, res);
}
