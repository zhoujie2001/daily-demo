import process from 'node:process';
import { createHash } from 'node:crypto';
import { LarkClient, LarkApiError } from '../../lib/lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lib/lark/card-renderer.js';
import { createSupabaseDispatchStore } from '../../lib/dispatch/supabase-store.js';
import {
  DispatchIngestError,
  batchDispatchActionValue,
  dispatchActionValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  shouldSkipLocalPromoDispatch,
  verifyDispatchIngestSignature,
} from '../../lib/dispatch/ingest.js';

const defaultClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

function log(level, stage, fields = {}) {
  console[level](JSON.stringify({ module: 'bess-dispatch-ingest', stage, ...fields }));
}

export function createDispatchSendHandler({
  client = defaultClient,
  storeFactory = () => createSupabaseDispatchStore(),
  now = () => new Date(),
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
      if (Array.isArray(body?.items)) {
        const skippedItems = body.items.filter((item) => shouldSkipLocalPromoDispatch(body.chat_id, item));
        const dispatchBody = skippedItems.length
          ? { ...body, items: body.items.filter((item) => !shouldSkipLocalPromoDispatch(body.chat_id, item)) }
          : body;
        if (dispatchBody.items.length === 0) {
          return res.status(200).json({
            ok: true, skipped: true, skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          });
        }
        const { chatId, fieldsList, cardTitle, batchId, period } = normalizeBatchDispatchIngest(dispatchBody);
        const fingerprint = createHash('sha256').update(JSON.stringify(fieldsList)).digest('hex');
        const source = String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64);
        const store = storeFactory();
        const claim = await store.claimIngestBatch({
          chatId, batchId, fingerprint,
          requestIds: fieldsList.map((item) => item.requestId),
          now: now(),
          expiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        log('info', 'idempotency_checked', {
          source, batch_id: batchId, chat_id: chatId,
          request_fingerprint: fingerprint, idempotency_outcome: claim.outcome,
        });
        if (claim.outcome === 'CONFLICT') {
          return res.status(409).json({ ok: false, error_code: 'BATCH_ID_CONFLICT' });
        }
        if (claim.outcome === 'IN_FLIGHT') {
          return res.status(202).json({ ok: true, batch_id: batchId, status: 'SENDING' });
        }
        if (claim.outcome === 'COMPLETE') {
          return res.status(200).json({
            ok: true, batch_id: batchId, request_ids: fieldsList.map((item) => item.requestId),
            message_id: claim.message_id, reused: true,
          });
        }
        const card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), { cardTitle, batchId, period });
        const messageUuid = `bess-batch-${createHash('sha256').update(`${chatId}:${batchId}`).digest('hex').slice(0, 32)}`;
        const message = await client.sendMessage({ receiveId: chatId, msgType: 'interactive', content: card, uuid: messageUuid });
        await store.completeIngestBatch({ chatId, batchId, fingerprint, messageId: message.message_id, completedAt: now() });
        log('info', 'batch_sent', {
          source, batch_id: batchId, request_count: fieldsList.length, chat_id: chatId,
          message_id: message.message_id, request_fingerprint: fingerprint,
        });
        return res.status(200).json({
          ok: true, batch_id: batchId, request_ids: fieldsList.map((item) => item.requestId),
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          message_id: message.message_id,
        });
      }
      if (shouldSkipLocalPromoDispatch(body?.chat_id, body)) {
        return res.status(200).json({ ok: true, skipped: true, skipped_request_ids: [String(body?.request_id || '')] });
      }
      const { chatId, fields } = normalizeDispatchIngest(body);
      const card = buildInitialDispatchCard(fields, dispatchActionValue(fields));
      const message = await client.sendMessage({
        receiveId: chatId, msgType: 'interactive', content: card,
        uuid: `bess-ingest-${fields.requestId}`.slice(0, 50),
      });
      log('info', 'sent', { source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64), request_id: fields.requestId, chat_id: chatId, message_id: message.message_id });
      return res.status(200).json({ ok: true, request_id: fields.requestId, message_id: message.message_id });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code : error instanceof LarkApiError ? error.code : error?.code || 'INGEST_FAILED';
      log('error', 'failed', {
        error_code: code,
        ...(error instanceof LarkApiError ? {
          method: error.method || '', endpoint: error.endpoint, request_id: error.requestId || '',
          code: error.apiCode ?? null, msg: error.apiMessage || '', log_id: error.logId || '', http_status: error.httpStatus,
        } : {}),
      });
      return res.status(status).json({ ok: false, error_code: code });
    }
  };
}

export default createDispatchSendHandler();
