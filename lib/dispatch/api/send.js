import process from 'node:process';
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient, LarkApiError } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { enrichLocalPromoRejectReasons } from '../reject-reason-enrichment.js';
import {
  DispatchIngestError,
  auditLocalPromoRejectReasons,
  batchDispatchActionValue,
  dispatchActionValue,
  hasLocalPromoRejectReasonField,
  LOCAL_PROMO_CHAT_ID,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  shouldSkipLocalPromoDispatch,
  verifyDispatchIngestSignature,
} from '../ingest.js';

const defaultClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

const BUDDY_INTRO_CHAT_ID = 'oc_aa1602f07bf35a5fdfd289aff67025a4';
const BUDDY_INTRO_BUSINESS_CHATS = Object.freeze([
  Object.freeze({ chatId: 'oc_99cb9239c03701fe263b870cc26a825c', uuid: 'bess-buddy-intro-v1-local-promo' }),
  Object.freeze({ chatId: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', uuid: 'bess-buddy-intro-v1-qianchuan' }),
]);

export function buildBuddyIntroCard() {
  const section = (title, content, color = 'blue') => ({
    tag: 'column_set', flex_mode: 'none',
    columns: [{
      tag: 'column', width: 'weighted', weight: 1, background_style: `${color}-50`, padding: '12px', vertical_spacing: '4px',
      elements: [
        { tag: 'markdown', content: `**<font color='${color}'>${title}</font>**` },
        { tag: 'markdown', content },
      ],
    }],
  });
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: '自我介绍｜排单 Buddy' } },
    header: {
      title: { tag: 'plain_text', content: '自我介绍' }, subtitle: { tag: 'plain_text', content: '排单 Buddy' },
      template: 'blue', icon: { tag: 'standard_icon', token: 'myai_colorful' },
    },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px',
      elements: [
        section('我能干什么', '• 接收批量派单需求\n• 根据每日排班名单分配执行人\n• 按千川、本地推和存量等业务规则轮转\n• 将负责人写回对应台账并回读核验\n• 更新派单卡片，汇总展示处理结果'),
        section('我的工作逻辑', '我以每日排班名单为基础，结合不同业务的轮转方向和台账中最近一次有效负责人，计算下一位执行人。派单使用批次与需求双层幂等：成功项不会重复处理，失败项可以单独重试。写回后还会重新读取台账，确认负责人填写正确。', 'violet'),
        section('我在什么情况下出现', '当 BESS 监控发现新增需求、完成二次确认并成功写入台账后，我会在对应业务群中发送派单卡片。没有新增需求、需求被过滤、写表失败或流程异常时，我不会发起派单。'),
        section('使用方式', '1. 在派单卡片中点击“批量自动派单”\n2. 当天首次使用时，按提示提交真实姓名排班名单\n3. 我会自动完成轮转计算、负责人写回和卡片更新\n4. 如有失败项，可再次点击进行补偿重试', 'grey'),
      ],
    },
  };
}

function log(level, stage, fields = {}) {
  console[level](JSON.stringify({ module: 'bess-dispatch-ingest', stage, ...fields }));
}

// Retained for callers and telemetry that still send the historical wait hint.
// New dispatches complete synchronously; the hint no longer changes execution.
export function resolveSyncWaitMs(req) {
  try {
    const url = new URL(req?.url || '', 'http://localhost');
    if (url.searchParams.get('wait') === '0') return -1;
    if (url.searchParams.get('wait') === '1') return 1;
  } catch { /* ignored */ }
  const value = String(req?.headers?.['x-bess-wait'] || '').trim().toLowerCase();
  if (value === 'async') return -1;
  if (value === 'sync') return 1;
  return 0;
}

function operationId(chatId, batchId) {
  return `bess-outbox-${createHash('sha256').update(`${chatId}:${batchId}`).digest('hex').slice(0, 32)}`;
}

async function completionAlreadyCommitted(store, payload) {
  if (typeof store?.getIngestBatchStatus !== 'function') return false;
  try {
    const status = await store.getIngestBatchStatus({ chatId: payload.chatId, batchId: payload.batchId });
    return status?.status === 'SENT' && status?.message_id === payload.messageId;
  } catch {
    return false;
  }
}

// This retry is intentionally limited to the idempotent completion CAS. It
// always uses the same fingerprint, lease and Lark message_id; unrelated writes
// and claim RPCs are never retried here.
async function completeIngestWithRetry(store, payload, retryDelays = [250]) {
  let lastError;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await store.completeIngestBatch(payload);
    } catch (error) {
      lastError = error;
      if (error?.code === 'INGEST_CLAIM_LOST' && await completionAlreadyCommitted(store, payload)) {
        return { reconciled: true };
      }
      if (attempt < retryDelays.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
    }
  }
  if (await completionAlreadyCommitted(store, payload)) return { reconciled: true };
  throw lastError;
}

export function createDispatchSendHandler({
  client = defaultClient,
  storeFactory = () => createSupabaseDispatchStore(),
  now = () => new Date(),
  enrichRejectReasons = enrichLocalPromoRejectReasons,
  defer = waitUntil,
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
      if (body?.action === 'send_buddy_intro') {
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '自我介绍请求不接受额外字段');
        const message = await client.sendMessage({
          receiveId: BUDDY_INTRO_CHAT_ID, msgType: 'interactive', content: buildBuddyIntroCard(),
          uuid: 'bess-buddy-intro-v1-main-chat',
        });
        return res.status(200).json({ ok: true, message_id: message.message_id });
      }
      if (body?.action === 'send_buddy_intro_business_chats') {
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '业务群自我介绍请求不接受额外字段');
        const messages = await Promise.all(BUDDY_INTRO_BUSINESS_CHATS.map(({ chatId, uuid }) => client.sendMessage({
          receiveId: chatId, msgType: 'interactive', content: buildBuddyIntroCard(), uuid,
        })));
        return res.status(200).json({
          ok: true,
          messages: messages.map((message, index) => ({ chat_id: BUDDY_INTRO_BUSINESS_CHATS[index].chatId, message_id: message.message_id })),
        });
      }

      const isBatch = Array.isArray(body?.items);
      const idempotencyFields = isBatch
        ? normalizeBatchDispatchIngest(body).fieldsList
        : [normalizeDispatchIngest(body).fields];
      let dispatchBody = body;
      let skippedItems = [];
      let allSkipped = false;
      const enrichmentItems = isBatch ? body.items : [body];
      const enrichedRequestIds = await enrichRejectReasons({
        chatId: body?.chat_id,
        items: enrichmentItems,
        client,
        log,
      });
      if (enrichedRequestIds.length) {
        log('info', 'local_promo_reject_reasons_enriched', {
          source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
          chat_id: body?.chat_id,
          request_ids: enrichedRequestIds,
          count: enrichedRequestIds.length,
        });
      }
      if (isBatch) {
        const audit = auditLocalPromoRejectReasons(body.chat_id, body.items);
        if (audit.skipped.length) {
          log('info', 'local_promo_reject_reasons_skipped', {
            source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
            chat_id: body.chat_id, skipped_request_ids: audit.skipped, skipped_count: audit.skipped.length,
          });
        }
        if (audit.missingField.length) {
          // Missing data is audited but never fetched from Sheets in the ingest critical path.
          log('warn', 'local_promo_reject_reason_field_missing', {
            source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
            chat_id: body.chat_id, request_ids: audit.missingField, count: audit.missingField.length,
          });
        }
        skippedItems = body.items.filter((item) => shouldSkipLocalPromoDispatch(body.chat_id, item));
        dispatchBody = skippedItems.length
          ? { ...body, items: body.items.filter((item) => !shouldSkipLocalPromoDispatch(body.chat_id, item)) }
          : body;
        allSkipped = dispatchBody.items.length === 0;
      } else if (shouldSkipLocalPromoDispatch(body?.chat_id, body)) {
        skippedItems = [body];
        allSkipped = true;
      } else if (String(body?.chat_id || '').trim() === LOCAL_PROMO_CHAT_ID && !hasLocalPromoRejectReasonField(body)) {
        log('warn', 'local_promo_reject_reason_field_missing', {
          source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
          chat_id: body?.chat_id, request_ids: [String(body?.request_id || '')], count: 1,
        });
      }

      let chatId;
      let fieldsList;
      let batchId;
      let card;
      if (isBatch) {
        const normalized = normalizeBatchDispatchIngest(allSkipped ? body : dispatchBody);
        ({ chatId, batchId } = normalized);
        fieldsList = allSkipped ? [] : normalized.fieldsList;
        if (!allSkipped) {
          card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), {
            cardTitle: normalized.cardTitle, batchId, period: normalized.period,
          });
        }
      } else {
        const normalized = normalizeDispatchIngest(dispatchBody);
        chatId = normalized.chatId;
        fieldsList = allSkipped ? [] : [normalized.fields];
        batchId = `single:${normalized.fields.requestId}`;
        if (!allSkipped) card = buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields));
      }

      let fingerprint = createHash('sha256').update(JSON.stringify(idempotencyFields)).digest('hex');
      const requestIds = (allSkipped ? idempotencyFields : fieldsList).map((item) => item.requestId);
      const operation = operationId(chatId, batchId);
      const source = String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64);
      const store = storeFactory();
      const claimBatch = (candidateFingerprint) => store.claimIngestBatch({
        chatId,
        batchId,
        fingerprint: candidateFingerprint,
        requestIds,
        now: now(),
        expiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const claimStartedAt = Date.now();
      let claim = await claimBatch(fingerprint);
      if (claim.outcome === 'CONFLICT') {
        const legacyFingerprint = createHash('sha256').update(JSON.stringify(fieldsList)).digest('hex');
        if (legacyFingerprint !== fingerprint) {
          const legacyClaim = await claimBatch(legacyFingerprint);
          if (legacyClaim.outcome !== 'CONFLICT') {
            fingerprint = legacyFingerprint;
            claim = legacyClaim;
          }
        }
      }
      log('info', 'idempotency_checked', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_fingerprint: fingerprint, idempotency_outcome: claim.outcome,
        duration_ms: Date.now() - claimStartedAt,
      });
      if (claim.outcome === 'CONFLICT') {
        return res.status(409).json({ ok: false, error_code: 'BATCH_ID_CONFLICT' });
      }
      const completedAsSkipped = claim.outcome === 'COMPLETE' && String(claim.message_id || '').startsWith('skipped:');
      if (completedAsSkipped) {
        return res.status(200).json({
          ok: true, skipped: true, reused: true, batch_id: batchId,
          skipped_request_ids: requestIds,
        });
      }
      if (allSkipped && ['CLAIMED', 'RESUMED'].includes(claim.outcome)) {
        await store.completeIngestBatch({
          chatId, batchId, fingerprint, requestIds,
          messageId: `skipped:${operation}`,
          expectedLeaseExpiresAt: claim.lease_expires_at,
          completedAt: now(),
        });
        return res.status(200).json({
          ok: true, skipped: true, batch_id: batchId,
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
        });
      }
      if (claim.outcome === 'IN_FLIGHT') {
        return res.status(202).json({
          ok: true, accepted: true, batch_id: batchId, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          operation_id: operation, status: 'SENDING',
        });
      }
      if (claim.outcome === 'COMPLETE') {
        return res.status(200).json({
          ok: true, batch_id: batchId, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          operation_id: operation, message_id: claim.message_id, reused: true,
        });
      }

      let message;
      const deliveryStartedAt = Date.now();
      try {
        message = await client.sendMessage({
          receiveId: chatId,
          msgType: 'interactive',
          content: card,
          uuid: operation,
        });
        if (!message?.message_id) {
          throw Object.assign(new Error('Lark response missing message_id'), {
            code: 'LARK_MESSAGE_ID_MISSING', status: 502,
          });
        }
      } catch (error) {
        try {
          await store.failIngestBatch({
            chatId, batchId, fingerprint, requestIds,
            errorCode: error?.code || 'INGEST_FAILED',
            expectedLeaseExpiresAt: claim.lease_expires_at,
            failedAt: now(),
          });
        } catch (stateError) {
          log('error', 'delivery_failure_state_write_failed', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            error_code: stateError?.code || 'INGEST_STATE_WRITE_FAILED',
          });
        }
        log('error', 'delivery_failed', {
          source, batch_id: batchId, chat_id: chatId, operation_id: operation,
          duration_ms: Date.now() - deliveryStartedAt,
          error_code: error?.code || 'INGEST_FAILED',
        });
        throw error;
      }

      log('info', 'delivery_completed', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        message_id: message.message_id, duration_ms: Date.now() - deliveryStartedAt,
      });
      const completionPayload = {
        chatId, batchId, fingerprint, requestIds,
        messageId: message.message_id,
        expectedLeaseExpiresAt: claim.lease_expires_at,
        completedAt: now(),
      };
      let statePending = false;
      const completionStartedAt = Date.now();
      try {
        await store.completeIngestBatch(completionPayload);
        log('info', 'delivery_state_committed', {
          source, batch_id: batchId, chat_id: chatId, operation_id: operation,
          message_id: message.message_id, duration_ms: Date.now() - completionStartedAt,
        });
      } catch (error) {
        statePending = true;
        log('error', 'delivery_succeeded_state_write_pending', {
          source, batch_id: batchId, chat_id: chatId, operation_id: operation,
          message_id: message.message_id,
          error_code: error?.code || 'INGEST_COMPLETE_FAILED',
          duration_ms: Date.now() - completionStartedAt,
        });
        const reconciliationStartedAt = Date.now();
        const reconciliation = new Promise((resolve) => setTimeout(resolve, 100))
          .then(() => completeIngestWithRetry(store, completionPayload))
          .then(() => log('info', 'delivery_state_reconciled', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            message_id: message.message_id, duration_ms: Date.now() - reconciliationStartedAt,
          }))
          .catch((reconcileError) => log('error', 'delivery_state_reconcile_failed', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            message_id: message.message_id,
            error_code: reconcileError?.code || 'INGEST_COMPLETE_FAILED',
            duration_ms: Date.now() - reconciliationStartedAt,
          }));
        try {
          defer(reconciliation);
        } catch (deferError) {
          log('error', 'delivery_state_reconcile_schedule_failed', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            message_id: message.message_id,
            error_code: deferError?.code || 'WAIT_UNTIL_FAILED',
          });
        }
      }
      log('info', 'sent', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_count: requestIds.length, message_id: message.message_id,
      });
      return res.status(200).json({
        ok: true, batch_id: batchId, request_ids: requestIds,
        ...(isBatch ? {} : { request_id: requestIds[0] }),
        skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
        operation_id: operation,
        message_id: message.message_id,
        ...(statePending ? { state_pending: true } : {}),
      });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code : error instanceof LarkApiError ? error.code : error?.code || 'INGEST_FAILED';
      log('error', 'failed', { error_code: code });
      return res.status(status).json({ ok: false, error_code: code });
    }
  };
}

export default createDispatchSendHandler();
