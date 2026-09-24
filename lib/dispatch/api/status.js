import process from 'node:process';
import { waitUntil } from '@vercel/functions';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import { dispatchOperationId } from '../operation.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { runDispatchOutbox } from '../outbox-worker.js';
import {
  createDispatchStatusCache,
  readDispatchStatusCache,
  writeDispatchStatusCache,
} from '../status-cache.js';
import { createServerTiming } from '../timing.js';
import { attachDispatchResponseMetadata } from './response-metadata.js';

const UNRESOLVED_STATUSES = Object.freeze(['QUEUED', 'RETRY', 'PROCESSING']);

export function createDispatchStatusHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  defer = waitUntil,
  runWorker = (store, target) => runDispatchOutbox({ store, target }),
  statusCache = createDispatchStatusCache(),
} = {}) {
  return async function handler(req, res) {
    const timing = createServerTiming(res);
    const metadata = attachDispatchResponseMetadata(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      timing.flush();
      return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        timing.flush();
        return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' });
      }
    }

    try {
      const authStartedAt = Date.now();
      verifyDispatchIngestSignature({
        body,
        timestamp: req.headers?.['x-bess-timestamp'],
        signature: req.headers?.['x-bess-signature'],
        secret: process.env.BESS_DISPATCH_INGEST_SECRET,
      });
      timing.measure('auth', authStartedAt);

      const chatId = String(body?.chat_id || '').trim();
      const suppliedBatchId = String(body?.batch_id || '').trim();
      const requestId = String(body?.request_id || '').trim();
      const batchId = suppliedBatchId || (requestId ? `single:${requestId}` : '');
      if (!chatId || !batchId) {
        throw new DispatchIngestError('INVALID_SCHEMA', '缺少 chat_id，以及 batch_id 或 request_id');
      }

      const cacheStartedAt = Date.now();
      let status = await readDispatchStatusCache(statusCache, { chatId, batchId });
      timing.measure('cache', cacheStartedAt);
      const servedFromCache = Boolean(status);
      let store;
      if (status) {
        metadata.setStatusSource('runtime-cache');
      } else {
        store = storeFactory();
        const databaseStartedAt = Date.now();
        status = await store.getIngestBatchStatus({ chatId, batchId });
        timing.measure('database', databaseStartedAt);
        metadata.setStatusSource('supabase');
        if (status.found) {
          await writeDispatchStatusCache(statusCache, { chatId, batchId, value: status });
        }
      }
      if (!status.found) {
        // A missing durable ledger row cannot prove that a queue publish was
        // accepted. Reporting QUEUED here creates a permanent phantom operation
        // after publish loss, so expose an explicit non-transient absence instead.
        timing.flush();
        return res.status(200).json({
          ok: true, found: false, status: 'NOT_FOUND', transient: false,
          retryable: false, operation_id: dispatchOperationId(chatId, batchId),
        });
      }
      if (!servedFromCache && status.found && UNRESOLVED_STATUSES.includes(status.status)) {
        // Respond from the bounded ledger read. Recovery runs only in waitUntil:
        // first make an expired lease immediately claimable, then run the same durable worker.
        defer(Promise.resolve()
          .then(() => store || storeFactory())
          .then((recoveryStore) => Promise.resolve()
            .then(() => recoveryStore.nudgeDispatchOutbox({ chatId, batchId }))
            .catch(() => false)
            .then(() => runWorker(recoveryStore, { chatId, batchId })))
          .catch(() => { /* a later status request or the daily cron can retry */ }));
      }
      const deadLetter = status.status === 'DEAD';
      // Preserve recovery compatibility for SENDING rows created by the legacy
      // synchronous sender before queue-based acceptance was deployed.
      const expiredIngestLease = status.status === 'SENDING' && status.retryable === true;
      const completedAsSkipped = status.status === 'SENT' && String(status.message_id || '').startsWith('skipped:');
      const publicStatus = expiredIngestLease
        ? 'FAILED'
        : UNRESOLVED_STATUSES.includes(status.status)
        ? 'SENDING'
        : deadLetter ? 'FAILED' : status.status;
      const publicPayload = completedAsSkipped
        ? Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'message_id'))
        : status;
      timing.flush();
      return res.status(200).json({
        ok: true,
        ...publicPayload,
        ...(publicStatus ? { status: publicStatus } : {}),
        ...(expiredIngestLease && !status.error_code ? { error_code: 'INGEST_LEASE_EXPIRED' } : {}),
        ...(completedAsSkipped ? { skipped: true, skipped_request_ids: status.request_ids || [] } : {}),
        ...(deadLetter ? {
          dead_letter: true,
          terminal_reason: status.error_code || 'OUTBOX_DELIVERY_FAILED',
        } : {}),
      });
    } catch (error) {
      timing.flush();
      if (error instanceof DispatchIngestError) {
        return res.status(error.status || 400).json({ ok: false, error_code: error.code, message: error.message });
      }
      if (error?.code === 'DISPATCH_DB_TIMEOUT') {
        return res.status(503).json({
          ok: false, status: 'UNAVAILABLE', transient: true,
          error_code: 'STATUS_TEMPORARILY_UNAVAILABLE', retry_after_ms: 2_000,
        });
      }
      const status = Number(error?.status || error?.httpStatus || 500);
      return res.status(status).json({ ok: false, error_code: error?.code || 'INTERNAL_ERROR', message: error?.message || 'Internal Error' });
    }
  };
}

export default createDispatchStatusHandler();
