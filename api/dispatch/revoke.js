import process from 'node:process';
import { LarkApiError, LarkClient } from '../../lib/lark/client.js';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../../lib/dispatch/ingest.js';

const client = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

function normalizeMessageIds(body) {
  const values = Array.isArray(body?.message_ids) ? body.message_ids : [body?.message_id];
  const messageIds = [...new Set(values.map((value) => String(value || '').trim()))];
  if (messageIds.length < 1 || messageIds.length > 30 || messageIds.some((id) => !/^om_[A-Za-z0-9]+$/.test(id))) {
    throw new DispatchIngestError('INVALID_MESSAGE_IDS', 'message_id 格式不正确或数量超限');
  }
  return messageIds;
}

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
    const messageIds = normalizeMessageIds(body);
    const revoked = [];
    for (const messageId of messageIds) {
      await client.deleteMessage(messageId);
      revoked.push(messageId);
    }
    console.info(JSON.stringify({ module: 'bess-dispatch-revoke', stage: 'revoked', message_ids: revoked }));
    return res.status(200).json({ ok: true, revoked_message_ids: revoked });
  } catch (error) {
    const status = error instanceof DispatchIngestError ? error.status : 502;
    const code = error instanceof DispatchIngestError
      ? error.code
      : error instanceof LarkApiError ? error.code : 'REVOKE_FAILED';
    console.error(JSON.stringify({
      module: 'bess-dispatch-revoke', stage: 'failed', error_code: code,
      ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
    }));
    return res.status(status).json({ ok: false, error_code: code });
  }
}
