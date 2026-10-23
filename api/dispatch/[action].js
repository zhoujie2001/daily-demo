import { createDispatchSendHandler } from '../../lib/dispatch/api/send.js';
import { createDispatchStatusHandler } from '../../lib/dispatch/api/status.js';
import { createDispatchStatusBatchHandler } from '../../lib/dispatch/api/status-batch.js';
import { createDispatchRevokeHandler } from '../../lib/dispatch/api/revoke.js';
import { createGate0ProbeHandler } from '../../lib/gate0/api/probe.js';
import { createAutomationSendHandler } from '../../lib/dispatch/api/automation-send.js';
import { createBasePullHandler } from '../../lib/dispatch/api/pull-base.js';
import { createHandoffReconcileHandler } from '../../lib/dispatch/api/handoff-reconcile.js';
import { createHandoffRecoveryHandler } from '../../lib/dispatch/api/handoff-recovery.js';
import { createWritebackRetryHandler } from '../../lib/dispatch/api/writeback-retry.js';

const HANDLERS = Object.freeze({
  send: createDispatchSendHandler,
  status: createDispatchStatusHandler,
  'status-batch': createDispatchStatusBatchHandler,
  'automation-probe': createGate0ProbeHandler,
  'automation-send': createAutomationSendHandler,
  'pull-base': createBasePullHandler,
  'handoff-reconcile': createHandoffReconcileHandler,
  'handoff-recovery': createHandoffRecoveryHandler,
  'writeback-retry': createWritebackRetryHandler,
  revoke: createDispatchRevokeHandler,
});

export default async function handler(req, res) {
  // Vercel dynamic routes expose the segment under req.query
  const action = String(req?.query?.action || '').trim();
  const factory = HANDLERS[action];
  if (!factory) return res.status(404).json({ ok: false, error_code: 'NOT_FOUND' });
  return factory()(req, res);
}
