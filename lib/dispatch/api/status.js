import process from 'node:process';
import { waitUntil } from '@vercel/functions';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import {
  isAcceptedQueuedStatus,
  isUnresolvedDispatchStatus,
  toPublicDispatchStatus,
} from '../public-status.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { runDispatchOutbox } from '../outbox-worker.js';
import {
  createDispatchStatusCache,
  readDispatchStatusCache,
  writeDispatchStatusCache,
} from '../status-cache.js';
import { createServerTiming } from '../timing.js';
import { attachDispatchResponseMetadata } from './response-metadata.js';

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
      const cachedStatus = await readDispatchStatusCache(statusCache, { chatId, batchId });
      timing.measure('cache', cacheStartedAt);
      const acceptedQueueCache = isAcceptedQueuedStatus(cachedStatus, { chatId, batchId });
      if (acceptedQueueCache) {
        // This receipt is written only after the queue accepted the publish.
        // Keep `found=false` for the durable ledger while exposing a retryable
        // accepted state until the worker materializes or completes the batch.
        metadata.setStatusSource('runtime-cache');
        timing.flush();
        return res.status(200).json(toPublicDispatchStatus(cachedStatus, {
          chatId, batchId, source: 'runtime-cache', httpStatus: 200,
        }));
      }

      let status = cachedStatus;
      let servedFromCache = false;
      let store;
      if (status?.found) {
        servedFromCache = true;
        metadata.setStatusSource('runtime-cache');
      } else {
        // A non-positive cache entry is not proof of absence unless it carries
        // the explicit accepted receipt above. Verify it against the durable ledger.
        store = storeFactory();
        const databaseStartedAt = Date.now();
        status = await store.getIngestBatchStatus({ chatId, batchId });
        timing.measure('database', databaseStartedAt);
        metadata.setStatusSource('supabase');
        if (status.found) {
          await writeDispatchStatusCache(statusCache, { chatId, batchId, value: status });
        }
      }
      if (!servedFromCache && status.found && isUnresolvedDispatchStatus(status)) {
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
      timing.flush();
      return res.status(200).json(toPublicDispatchStatus(status, {
        chatId,
        batchId,
        source: servedFromCache ? 'runtime-cache' : 'supabase',
        httpStatus: 200,
      }));
    } catch (error) {
      timing.flush();
      if (error instanceof DispatchIngestError) {
        const httpStatus = error.status || 400;
        metadata.setStatusSource('request-validation');
        return res.status(httpStatus).json({
          ok: false,
          error_code: error.code,
          error_detail: error.message,
          message: error.message,
          status_source: 'request-validation',
          http_status: httpStatus,
        });
      }
      if (error?.code === 'DISPATCH_DB_TIMEOUT') {
        metadata.setStatusSource('supabase');
        return res.status(503).json({
          ok: false, status: 'UNAVAILABLE', transient: true,
          error_code: 'STATUS_TEMPORARILY_UNAVAILABLE',
          error_detail: error?.message || 'Dispatch status database query timed out.',
          retry_after_ms: 2_000,
          status_source: 'supabase',
          http_status: 503,
        });
      }
      const status = Number(error?.status || error?.httpStatus || 500);
      metadata.setStatusSource('handler');
      return res.status(status).json({
        ok: false,
        error_code: error?.code || 'INTERNAL_ERROR',
        error_detail: error?.message || 'Internal Error',
        message: error?.message || 'Internal Error',
        status_source: 'handler',
        http_status: status,
      });
    }
  };
}

export default createDispatchStatusHandler();
