import process from 'node:process';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { publishDispatchQueueMessage } from '../queue.js';

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function createHandoffReconcileHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  publishDispatch = publishDispatchQueueMessage,
  secret = process.env.CRON_SECRET,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (req?.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    // Vercel production must never expose a cron when its secret is absent.
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const store = storeFactory();
    const current = now();
    const handoffs = await store.listHandoffsToReconcile({ now: current });
    const results = [];

    for (const handoff of handoffs) {
      const { chatId, context = {} } = handoff;
      const batchId = String(context.batchId || '');
      try {
        const status = await store.getIngestBatchStatus({ chatId, batchId });
        if (['SENT', 'QUEUED', 'RETRY', 'PROCESSING', 'DEAD'].includes(status.status)) {
          results.push({ batchId, ok: true, status: status.status, recovered: true });
          continue;
        }

        // Unknown acceptance is replayable only with persisted proof of a synchronous
        // rejection. Both pending and replay paths must win the same publish lease.
        const authoritative = context.authoritativeNonAcceptance === true;
        const identityMatches = status.operation_id === context.operationId
          && context.operationId && context.fingerprint;
        const replayable = status.status === 'HANDOFF_PENDING'
          || (status.status === 'ACCEPTED_UNKNOWN' && authoritative && identityMatches);
        const persistedMessage = context.queueMessage;

        if (!replayable || !persistedMessage || typeof persistedMessage !== 'object'
            || !context.card || typeof store.claimDispatchHandoffPublish !== 'function') {
          if (status.status === 'ACCEPTED_UNKNOWN' && !authoritative) {
            const nextReconcileAt = new Date(current.getTime() + 10 * 60_000);
            await store.markDispatchHandoffUnknown({ chatId, batchId, now: current, nextReconcileAt });
          }
          results.push({ batchId, ok: true, status: status.status, republished: false });
          continue;
        }

        const claim = await store.claimDispatchHandoffPublish({
          chatId, batchId, operationId: context.operationId,
          fingerprint: context.fingerprint, card: context.card, now: current,
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
            await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken, now: current });
          } else {
            await store.markDispatchHandoffRejected({
              chatId, batchId, operationId: context.operationId,
              fingerprint: context.fingerprint, card: context.card, workerToken,
              errorCode: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE', now: current,
            });
          }
          throw error;
        }
        try {
          await store.confirmDispatchHandoff({
            chatId, batchId, operationId: context.operationId, workerToken, now: now(),
          });
        } catch (error) {
          await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken, now: now() });
          throw error;
        }
        results.push({ batchId, ok: true, status: 'QUEUED', republished: true });
      } catch (error) {
        results.push({ batchId, ok: false, error_code: error?.code || 'RECONCILE_FAILED' });
      }
    }

    return res.status(200).json({ ok: true, handoffs: results.length, results });
  };
}

export default createHandoffReconcileHandler();
