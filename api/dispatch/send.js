import process from 'node:process';
import { createHash } from 'node:crypto';
import { LarkClient, LarkApiError } from '../../lib/lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lib/lark/card-renderer.js';
import {
  DispatchIngestError,
  dispatchActionValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  verifyDispatchIngestSignature,
} from '../../lib/dispatch/ingest.js';

const client = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

export default async function handler(req, res) {
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
      const { chatId, fieldsList, cardTitle } = normalizeBatchDispatchIngest(body);
      const card = buildBatchDispatchCard(
        fieldsList,
        fieldsList.map(dispatchActionValue),
        { cardTitle },
      );
      const digest = createHash('sha256')
        .update(fieldsList.map((item) => item.requestId).join(','))
        .digest('hex')
        .slice(0, 24);
      const message = await client.sendMessage({
        receiveId: chatId,
        msgType: 'interactive',
        content: card,
        uuid: `bess-batch-${digest}`,
      });
      console.info(JSON.stringify({
        module: 'bess-dispatch-ingest', stage: 'batch_sent', request_count: fieldsList.length,
        chat_id: chatId, message_id: message.message_id,
      }));
      return res.status(200).json({
        ok: true,
        request_ids: fieldsList.map((item) => item.requestId),
        message_id: message.message_id,
      });
    }
    const { chatId, fields } = normalizeDispatchIngest(body);
    const card = buildInitialDispatchCard(fields, dispatchActionValue(fields));
    const message = await client.sendMessage({
      receiveId: chatId,
      msgType: 'interactive',
      content: card,
      uuid: `bess-ingest-${fields.requestId}`.slice(0, 50),
    });
    console.info(JSON.stringify({
      module: 'bess-dispatch-ingest', stage: 'sent', request_id: fields.requestId,
      chat_id: chatId, message_id: message.message_id,
    }));
    return res.status(200).json({ ok: true, request_id: fields.requestId, message_id: message.message_id });
  } catch (error) {
    const status = error instanceof DispatchIngestError ? error.status : 502;
    const code = error instanceof DispatchIngestError
      ? error.code
      : error instanceof LarkApiError ? error.code : 'INGEST_FAILED';
    console.error(JSON.stringify({
      module: 'bess-dispatch-ingest', stage: 'failed', error_code: code,
      ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
    }));
    return res.status(status).json({ ok: false, error_code: code });
  }
}
