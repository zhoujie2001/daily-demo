import process from 'node:process';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { publishDispatchQueueMessage } from '../queue.js';
import { classifyDispatchHandoff } from '../handoff-recovery.js';

export const HANDOFF_RECONCILE_MAX_ATTEMPTS = 6;
export const HANDOFF_RECONCILE_DELAY_MS = 10 * 60_000;

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function queueReconciledBaseWriteback(store, handoff, current) {
  const { chatId, context = {} } = handoff;
  const recordId = String(context.queueMessage?.source_record_id || '');
  if (!recordId || typeof store.recordWritebackFailure !== 'function') return;
  await store.recordWritebackFailure({
    chatId,
    batchId: String(context.batchId || ''),
    recordId,
    operationId: String(context.operationId || ''),
    errorCode: 'HANDOFF_RECONCILED',
    now: current,
    nextRetryAt: current,
  });
}

export async function runHandoffReconciliation({
  store = createSupabaseDispatchStore(),
  publishDispatch = publishDispatchQueueMessage,
  now = () => new Date(),
  maxAttempts = HANDOFF_RECONCILE_MAX_ATTEMPTS,
  limit = 20,
} = {}) {
  const current = now();
  const handoffs = await store.listHandoffsToReconcile({ now: current, limit });
  const results = [];

  for (const handoff of handoffs) {
    const { chatId, context = {} } = handoff;
    const batchId = String(context.batchId || '');
    const operationId = String(context.operationId || '');
    const attempt = Math.max(0, Number(context.reconcileAttempt || 0));
    try {
      const status = await store.getIngestBatchStatus({ chatId, batchId });
      const recovery = classifyDispatchHandoff(handoff, status);
      if (recovery.classification === 'CONFIRMED') {
        await queueReconciledBaseWriteback(store, handoff, current);
        results.push({
          batchId, ok: true, status: status.status, recovered: true,
          operation_id: operationId, recovery: recovery.classification,
        });
        continue;
      }

      // Crossing the publish boundary without a durable acceptance result is
      // ambiguous. Queue idempotency is useful after a proven rejection, but it
      // is not evidence that an arbitrary replay is safe. Leave the operation
      // unchanged for delayed confirmation/manual reconciliation.
      if (recovery.classification === 'NEEDS_RECONCILIATION') {
        results.push({
          batchId, ok: true, status: recovery.status,
          operation_id: operationId, recovery: recovery.classification,
          reason: recovery.reason, republished: false,
        });
        continue;
      }

      const persistedMessage = context.queueMessage;
      const replayable = recovery.publish_allowed;

      if (!replayable || attempt >= maxAttempts) {
        await store.markDispatchHandoffReconciliationDead({
          chatId, batchId, operationId,
          errorCode: replayable ? 'HANDOFF_RECONCILE_ATTEMPTS_EXHAUSTED' : 'HANDOFF_RECONCILE_EVIDENCE_INVALID',
          now: current,
        });
        results.push({ batchId, ok: false, status: 'RECONCILIATION_DEAD', dead_letter: true });
        continue;
      }

      // Re-publication always uses the persisted logical message and operation id.
      // Queue idempotency plus the durable outbox/consumer lease makes this a replay,
      // not a new batch/card. The DB claim also bounds ambiguous retries.
      const claim = await store.claimDispatchHandoffPublish({
        chatId, batchId, operationId,
        fingerprint: context.fingerprint, card: context.card, now: current,
        maxReconcileAttempts: maxAttempts,
      });
      if (!claim.claimed) {
        results.push({ batchId, ok: true, status: status.status, republished: false });
        continue;
      }

      const workerToken = claim.workerToken;
      const queueMessage = claim.queueMessage || persistedMessage;
      try {
        await publishDispatch(queueMessage);
      } catch (error) {
        if (error?.code === 'DISPATCH_QUEUE_TIMEOUT') {
          await store.markDispatchHandoffUnknown({
            chatId, batchId, workerToken, now: current,
            nextReconcileAt: new Date(current.getTime() + HANDOFF_RECONCILE_DELAY_MS),
          });
        } else {
          await store.markDispatchHandoffRejected({
            chatId, batchId, operationId, fingerprint: context.fingerprint,
            card: context.card, workerToken,
            errorCode: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE', now: current,
            nextReconcileAt: new Date(current.getTime() + HANDOFF_RECONCILE_DELAY_MS),
          });
        }
        throw error;
      }
      try {
        await store.confirmDispatchHandoff({ chatId, batchId, operationId, workerToken, now: now() });
      } catch (error) {
        await store.markDispatchHandoffUnknown({
          chatId, batchId, workerToken, now: now(),
          nextReconcileAt: new Date(current.getTime() + HANDOFF_RECONCILE_DELAY_MS),
        });
        throw error;
      }
      await queueReconciledBaseWriteback(store, handoff, now());
      results.push({ batchId, ok: true, status: 'QUEUED', republished: true, operation_id: operationId });
    } catch (error) {
      results.push({ batchId, ok: false, error_code: error?.code || 'RECONCILE_FAILED' });
    }
  }

  return { ok: true, handoffs: results.length, results };
}

export function createHandoffReconcileHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  publishDispatch = publishDispatchQueueMessage,
  secret = process.env.CRON_SECRET,
  now = () => new Date(),
  maxAttempts = HANDOFF_RECONCILE_MAX_ATTEMPTS,
} = {}) {
  return async function handler(req, res) {
    if (req?.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const result = await runHandoffReconciliation({
        store: storeFactory(), publishDispatch, now, maxAttempts,
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(503).json({ ok: false, error_code: error?.code || 'RECONCILE_UNAVAILABLE' });
    }
  };
}

export default createHandoffReconcileHandler();
