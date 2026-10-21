import process from 'node:process';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { publishDispatchQueueMessage } from '../queue.js';
import { classifyDispatchHandoff } from '../handoff-recovery.js';

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function input(req) {
  const source = req?.method === 'GET' ? req.query : req.body;
  return {
    chatId: String(source?.chat_id || '').trim(),
    batchId: String(source?.batch_id || '').trim(),
    operationId: String(source?.operation_id || '').trim(),
    action: String(source?.recovery_action || '').trim(),
  };
}

export async function probeDispatchHandoff({ store, chatId, batchId }) {
  const handoff = await store.getDispatchHandoff({ chatId, batchId });
  if (!handoff.found) return { ok: true, found: false, classification: 'NOT_FOUND' };
  const status = await store.getIngestBatchStatus({ chatId, batchId });
  return { ok: true, found: true, ...classifyDispatchHandoff(handoff, status) };
}

export async function recoverDispatchHandoff({
  store, chatId, batchId, operationId, publishDispatch = publishDispatchQueueMessage, now = () => new Date(),
}) {
  const handoff = await store.getDispatchHandoff({ chatId, batchId });
  if (!handoff.found) return { httpStatus: 404, body: { ok: false, error_code: 'HANDOFF_NOT_FOUND' } };
  const status = await store.getIngestBatchStatus({ chatId, batchId });
  const recovery = classifyDispatchHandoff(handoff, status);
  if (!operationId || operationId !== recovery.operation_id) {
    return { httpStatus: 409, body: { ok: false, error_code: 'OPERATION_ID_MISMATCH', ...recovery } };
  }
  if (recovery.classification === 'CONFIRMED') {
    return { httpStatus: 200, body: { ok: true, found: true, reused: true, ...recovery } };
  }
  if (!recovery.publish_allowed) {
    return { httpStatus: 409, body: { ok: false, error_code: 'HANDOFF_RECONCILIATION_REQUIRED', ...recovery } };
  }

  const context = handoff.context;
  const claim = await store.claimDispatchHandoffPublish({
    chatId, batchId, operationId, fingerprint: context.fingerprint,
    card: context.card, now: now(),
  });
  if (!claim.claimed) {
    const latest = await probeDispatchHandoff({ store, chatId, batchId });
    return { httpStatus: 202, body: { ...latest, reused: true, publish_claimed: false } };
  }

  try {
    await publishDispatch(claim.queueMessage || context.queueMessage);
  } catch (error) {
    await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken: claim.workerToken, now: now() });
    return {
      httpStatus: 202,
      body: {
        ok: true, found: true, status: 'ACCEPTED_UNKNOWN', classification: 'NEEDS_RECONCILIATION',
        reason: 'RECOVERY_PUBLISH_OUTCOME_UNKNOWN', accepted_unknown: true,
        operation_id: operationId, error_code: error?.code || 'QUEUE_PUBLISH_UNKNOWN',
      },
    };
  }

  try {
    await store.confirmDispatchHandoff({ chatId, batchId, operationId, workerToken: claim.workerToken, now: now() });
  } catch (error) {
    await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken: claim.workerToken, now: now() });
    return {
      httpStatus: 202,
      body: {
        ok: true, found: true, status: 'ACCEPTED_UNKNOWN', classification: 'NEEDS_RECONCILIATION',
        reason: 'QUEUE_ACCEPTED_CONFIRMATION_DELAYED', accepted_unknown: true,
        operation_id: operationId, error_code: error?.code || 'HANDOFF_CONFIRM_FAILED',
      },
    };
  }
  return {
    httpStatus: 202,
    body: { ok: true, found: true, status: 'QUEUED', classification: 'CONFIRMED', operation_id: operationId },
  };
}

export function createHandoffRecoveryHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  publishDispatch = publishDispatchQueueMessage,
  secret = process.env.CRON_SECRET,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req?.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    }
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error_code: 'UNAUTHORIZED' });
    const values = input(req);
    if (!values.chatId || !values.batchId) {
      return res.status(400).json({ ok: false, error_code: 'INVALID_RECOVERY_TARGET' });
    }
    try {
      const store = storeFactory();
      if (req.method === 'GET') {
        return res.status(200).json(await probeDispatchHandoff({ store, ...values }));
      }
      if (values.action !== 'retry_if_safe') {
        return res.status(400).json({ ok: false, error_code: 'INVALID_RECOVERY_ACTION' });
      }
      const result = await recoverDispatchHandoff({ store, publishDispatch, now, ...values });
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      return res.status(error?.status || 503).json({ ok: false, error_code: error?.code || 'HANDOFF_RECOVERY_UNAVAILABLE' });
    }
  };
}

export default createHandoffRecoveryHandler();
