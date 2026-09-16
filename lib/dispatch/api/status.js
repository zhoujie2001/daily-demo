import process from 'node:process';
import { waitUntil } from '@vercel/functions';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { runDispatchOutbox } from '../outbox-worker.js';

const UNRESOLVED_STATUSES = Object.freeze(['QUEUED', 'RETRY', 'PROCESSING']);

export function createDispatchStatusHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  defer = waitUntil,
  runWorker = (store, target) => runDispatchOutbox({ store, target }),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' }); }
    }

    try {
      verifyDispatchIngestSignature({
        body,
        timestamp: req.headers?.['x-bess-timestamp'],
        signature: req.headers?.['x-bess-signature'],
        secret: process.env.BESS_DISPATCH_INGEST_SECRET,
      });

      const chatId = String(body?.chat_id || '').trim();
      const suppliedBatchId = String(body?.batch_id || '').trim();
      const requestId = String(body?.request_id || '').trim();
      const batchId = suppliedBatchId || (requestId ? `single:${requestId}` : '');
      if (!chatId || !batchId) {
        throw new DispatchIngestError('INVALID_SCHEMA', '缺少 chat_id，以及 batch_id 或 request_id');
      }

      const store = storeFactory();
      const status = await store.getIngestBatchStatus({ chatId, batchId });
      if (status.found && UNRESOLVED_STATUSES.includes(status.status)) {
        // Respond from the bounded ledger read. Recovery runs only in waitUntil:
        // first make an expired lease immediately claimable, then run the same durable worker.
        defer(Promise.resolve()
          .then(() => store.nudgeDispatchOutbox({ chatId, batchId }))
          .catch(() => false)
          .then(() => runWorker(store, { chatId, batchId }))
          .catch(() => { /* a later status request or the daily cron can retry */ }));
      }
      const deadLetter = status.status === 'DEAD';
      const completedAsSkipped = status.status === 'SENT' && String(status.message_id || '').startsWith('skipped:');
      const publicStatus = UNRESOLVED_STATUSES.includes(status.status)
        ? 'SENDING'
        : deadLetter ? 'FAILED' : status.status;
      const publicPayload = completedAsSkipped
        ? Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'message_id'))
        : status;
      return res.status(200).json({
        ok: true,
        ...publicPayload,
        ...(publicStatus ? { status: publicStatus } : {}),
        ...(completedAsSkipped ? { skipped: true, skipped_request_ids: status.request_ids || [] } : {}),
        ...(deadLetter ? {
          dead_letter: true,
          terminal_reason: status.error_code || 'OUTBOX_DELIVERY_FAILED',
        } : {}),
      });
    } catch (error) {
      if (error instanceof DispatchIngestError) {
        return res.status(error.status || 400).json({ ok: false, error_code: error.code, message: error.message });
      }
      const status = Number(error?.status || error?.httpStatus || 500);
      return res.status(status).json({ ok: false, error_code: error?.code || 'INTERNAL_ERROR', message: error?.message || 'Internal Error' });
    }
  };
}

export default createDispatchStatusHandler();
