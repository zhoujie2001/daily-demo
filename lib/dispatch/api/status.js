import process from 'node:process';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';

export function createDispatchStatusHandler({
  storeFactory = () => createSupabaseDispatchStore(),
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
      const batchId = String(body?.batch_id || '').trim();
      if (!chatId || !batchId) {
        throw new DispatchIngestError('INVALID_SCHEMA', '缺少 chat_id 或 batch_id');
      }

      const store = storeFactory();
      const status = await store.getIngestBatchStatus({ chatId, batchId });
      return res.status(200).json({ ok: true, ...status });
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
