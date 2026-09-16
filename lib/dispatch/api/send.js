import process from 'node:process';
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient, LarkApiError } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { enrichLocalPromoRejectReasons } from '../reject-reason-enrichment.js';
import { dispatchOperationId } from '../operation.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION, publishDispatchQueueMessage } from '../queue.js';
import { createDispatchStatusCache, queuedDispatchStatus, writeDispatchStatusCache } from '../status-cache.js';
import { createServerTiming } from '../timing.js';
import { attachDispatchResponseMetadata } from './response-metadata.js';
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

async function enrichRejectReasonsWithinDeadline({
  chatId, items, client, enrichRejectReasons, timeoutMs, source,
}) {
  if (!Array.isArray(items) || items.length === 0 || timeoutMs <= 0) return [];
  // Never pass the request body to a lookup that may settle after the response.
  // A clone prevents a late Sheets response from mutating the card/fingerprint
  // after queue acceptance has already been decided.
  const lookupItems = structuredClone(items);
  let timer;
  const lookup = Promise.resolve()
    .then(() => enrichRejectReasons({ chatId, items: lookupItems, client, log }))
    .then((requestIds) => ({ requestIds, lookupItems }));
  const result = await Promise.race([
    lookup,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (result.timedOut) {
    log('warn', 'local_promo_reject_reason_lookup_timeout', {
      source, chat_id: chatId, timeout_ms: timeoutMs,
    });
    return [];
  }
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.reject_reason === undefined && result.lookupItems[index]?.reject_reason !== undefined) {
      items[index].reject_reason = result.lookupItems[index].reject_reason;
    }
  }
  return result.requestIds;
}

// Retained for callers and telemetry that still send the historical wait hint.
// Durable queue acceptance is always asynchronous; the hint no longer changes execution.
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

export function createDispatchSendHandler({
  client = defaultClient,
  now = () => new Date(),
  enrichRejectReasons = enrichLocalPromoRejectReasons,
  enrichmentTimeoutMs = 750,
  publishDispatch = publishDispatchQueueMessage,
  publishTimeoutMs = 2_500,
  defer = waitUntil,
  statusCache = createDispatchStatusCache(),
} = {}) {
  return async function handler(req, res) {
    const timing = createServerTiming(res);
    attachDispatchResponseMetadata(req, res, { statusSource: 'queue' });
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
      if (body?.action === 'send_buddy_intro') {
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '自我介绍请求不接受额外字段');
        const message = await client.sendMessage({
          receiveId: BUDDY_INTRO_CHAT_ID, msgType: 'interactive', content: buildBuddyIntroCard(),
          uuid: 'bess-buddy-intro-v1-main-chat',
        });
        timing.flush();
        return res.status(200).json({ ok: true, message_id: message.message_id });
      }
      if (body?.action === 'send_buddy_intro_business_chats') {
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '业务群自我介绍请求不接受额外字段');
        const messages = await Promise.all(BUDDY_INTRO_BUSINESS_CHATS.map(({ chatId, uuid }) => client.sendMessage({
          receiveId: chatId, msgType: 'interactive', content: buildBuddyIntroCard(), uuid,
        })));
        timing.flush();
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
      const source = String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64);
      const enrichmentStartedAt = Date.now();
      const enrichedRequestIds = await enrichRejectReasonsWithinDeadline({
        chatId: body?.chat_id,
        items: enrichmentItems,
        client,
        enrichRejectReasons,
        timeoutMs: enrichmentTimeoutMs,
        source,
      });
      timing.measure('enrich', enrichmentStartedAt);
      if (enrichedRequestIds.length) {
        log('info', 'local_promo_reject_reasons_enriched', {
          source,
          chat_id: body?.chat_id,
          request_ids: enrichedRequestIds,
          count: enrichedRequestIds.length,
        });
      }
      if (isBatch) {
        const audit = auditLocalPromoRejectReasons(body.chat_id, body.items);
        if (audit.skipped.length) {
          log('info', 'local_promo_reject_reasons_skipped', {
            source,
            chat_id: body.chat_id, skipped_request_ids: audit.skipped, skipped_count: audit.skipped.length,
          });
        }
        if (audit.missingField.length) {
          // Missing data is audited but never fetched from Sheets in the ingest critical path.
          log('warn', 'local_promo_reject_reason_field_missing', {
            source,
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
          source,
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

      const fingerprint = createHash('sha256')
        .update(JSON.stringify(idempotencyFields))
        .digest('hex');
      const requestIds = (allSkipped ? idempotencyFields : fieldsList).map((item) => item.requestId);
      const operation = dispatchOperationId(chatId, batchId);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const queueMessage = {
        schema_version: DISPATCH_QUEUE_SCHEMA_VERSION,
        kind: allSkipped ? 'skip' : 'dispatch',
        chat_id: chatId,
        batch_id: batchId,
        fingerprint,
        request_ids: requestIds,
        operation_id: operation,
        card: allSkipped ? null : card,
        source,
        expires_at: expiresAt,
      };
      const publishStartedAt = Date.now();
      const publishPromise = Promise.resolve().then(() => publishDispatch(queueMessage));
      let timer;
      let published;
      try {
        published = await Promise.race([
          publishPromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Queue publish timed out'), {
              code: 'DISPATCH_QUEUE_TIMEOUT', status: 503,
            })), publishTimeoutMs);
          }),
        ]);
      } catch (error) {
        if (error?.code !== 'DISPATCH_QUEUE_TIMEOUT') {
          throw Object.assign(error instanceof Error ? error : new Error('Queue publish failed'), {
            code: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE',
            status: error?.status || 503,
          });
        }
        const latePublish = publishPromise
          .then((result) => log('info', 'queue_publish_reconciled', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            queue_message_id: result?.message_id || '',
            duration_ms: Date.now() - publishStartedAt,
          }))
          .catch((publishError) => log('error', 'queue_publish_reconcile_failed', {
            source, batch_id: batchId, chat_id: chatId, operation_id: operation,
            error_code: publishError?.code || 'DISPATCH_QUEUE_UNAVAILABLE',
            duration_ms: Date.now() - publishStartedAt,
          }));
        try { defer(latePublish); } catch { /* the caller will retry the same operation id */ }
        log('warn', 'queue_publish_timeout', {
          source, batch_id: batchId, chat_id: chatId, operation_id: operation,
          duration_ms: Date.now() - publishStartedAt,
        });
        timing.measure('queue', publishStartedAt);
        timing.flush();
        return res.status(503).json({
          ok: false, accepted_unknown: true, status: 'QUEUING',
          error_code: 'DISPATCH_QUEUE_TIMEOUT', retry_after_ms: 2_000,
          batch_id: batchId, operation_id: operation,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      log('info', 'queue_accepted', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_count: requestIds.length,
        queue_message_id: published?.message_id || '',
        deduplicated: Boolean(published?.deduplicated),
        duration_ms: Date.now() - publishStartedAt,
      });
      timing.measure('queue', publishStartedAt);
      if (!published?.deduplicated) {
        const cacheStartedAt = Date.now();
        await writeDispatchStatusCache(statusCache, {
          chatId, batchId,
          value: queuedDispatchStatus({ operationId: operation, requestIds }),
        });
        timing.measure('cache', cacheStartedAt);
      }
      timing.flush();
      return res.status(202).json({
        ok: true, accepted: true, status: 'QUEUED',
        batch_id: batchId, request_ids: requestIds,
        ...(isBatch ? {} : { request_id: requestIds[0] }),
        skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
        operation_id: operation,
        ...(published?.message_id ? { queue_message_id: published.message_id } : {}),
        ...(published?.deduplicated ? { reused: true } : {}),
      });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code : error instanceof LarkApiError ? error.code : error?.code || 'INGEST_FAILED';
      log('error', 'failed', { error_code: code });
      timing.flush();
      return res.status(status).json({ ok: false, error_code: code });
    }
  };
}

export default createDispatchSendHandler();
