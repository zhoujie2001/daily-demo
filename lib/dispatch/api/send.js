import process from 'node:process';
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient, LarkApiError } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
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
import { enrichLocalPromoRejectReasons } from '../reject-reason-enrichment.js';

const defaultClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

const BUDDY_INTRO_CHAT_ID = 'oc_aa1602f07bf35a5fdfd289aff67025a4';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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

// 有界同步等待上限：必须低于 Vercel Hobby 10s 函数时限，给 claim/状态写入留余量。
const SYNC_WAIT_MAX_MS = 6000;

/**
 * 解析调用方的同步等待意图：?wait=1（可配 ?wait_ms=）或头 X-Bess-Wait: sync。
 * 返回：>0 需要等待的毫秒数；0 未指定；-1 显式要求异步（?wait=0 或 X-Bess-Wait: async）。
 */
export function resolveSyncWaitMs(req) {
  let explicit = false;
  let optOut = false;
  let requestedMs = SYNC_WAIT_MAX_MS;
  try {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.searchParams.get('wait') === '1') explicit = true;
    if (url.searchParams.get('wait') === '0') optOut = true;
    const custom = Number.parseInt(url.searchParams.get('wait_ms') || '', 10);
    if (Number.isFinite(custom)) requestedMs = custom;
  } catch {
    // malformed URL — treat as unspecified
  }
  const waitHeader = String(req.headers?.['x-bess-wait'] || '').trim().toLowerCase();
  if (waitHeader === 'sync') explicit = true;
  if (waitHeader === 'async') optOut = true;
  if (optOut) return -1;
  if (!explicit) return 0;
  return Math.max(0, Math.min(requestedMs, SYNC_WAIT_MAX_MS));
}

export function createDispatchSendHandler({
  client = defaultClient,
  storeFactory = () => createSupabaseDispatchStore(),
  now = () => new Date(),
  defer = waitUntil,
  enrichRejectReasons = (opts) => enrichLocalPromoRejectReasons({ ...opts, client, log }),
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
        // Fixed-purpose branch: callers cannot supply a chat ID or arbitrary card content.
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '自我介绍请求不接受额外字段');
        const message = await client.sendMessage({
          receiveId: BUDDY_INTRO_CHAT_ID,
          msgType: 'interactive',
          content: buildBuddyIntroCard(),
          uuid: 'bess-buddy-intro-v1-main-chat',
        });
        log('info', 'buddy_intro_sent', { chat_id: BUDDY_INTRO_CHAT_ID, message_id: message.message_id });
        return res.status(200).json({ ok: true, message_id: message.message_id });
      }
      if (body?.action === 'send_buddy_intro_business_chats') {
        // The two business chats are fixed here; callers cannot supply additional destinations.
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '业务群自我介绍请求不接受额外字段');
        const messages = await Promise.all(BUDDY_INTRO_BUSINESS_CHATS.map(({ chatId, uuid }) => client.sendMessage({
          receiveId: chatId,
          msgType: 'interactive',
          content: buildBuddyIntroCard(),
          uuid,
        })));
        const messageIds = messages.map((message, index) => ({
          chat_id: BUDDY_INTRO_BUSINESS_CHATS[index].chatId, message_id: message.message_id,
        }));
        log('info', 'buddy_intro_business_chats_sent', { messages: messageIds });
        return res.status(200).json({ ok: true, messages: messageIds });
      }
      const isBatch = Array.isArray(body?.items);
      // 兜底：旧客户端漏传 reject_reason 时，按 item 绑定的台账行回查“拒绝理由”列，
      // 使跳过不依赖上游升级；非本地推群或字段已存在时为空操作，失败 fail-open。
      if (isBatch) {
        await enrichRejectReasons({ chatId: body.chat_id, items: body.items });
      } else {
        await enrichRejectReasons({ chatId: body?.chat_id, items: [body] });
      }
      let dispatchBody = body;
      let skippedItems = [];
      if (isBatch) {
        const audit = auditLocalPromoRejectReasons(body.chat_id, body.items);
        if (audit.skipped.length) {
          log('info', 'local_promo_reject_reasons_skipped', {
            source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
            chat_id: body.chat_id,
            skipped_request_ids: audit.skipped,
            skipped_count: audit.skipped.length,
          });
        }
        if (audit.missingField.length) {
          // 不阻塞投递（拒绝理由可能确实为空），但显式记录契约缺口，防止过滤静默失效。
          log('warn', 'local_promo_reject_reason_field_missing', {
            source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
            chat_id: body.chat_id,
            request_ids: audit.missingField,
            count: audit.missingField.length,
          });
        }
        skippedItems = body.items.filter((item) => shouldSkipLocalPromoDispatch(body.chat_id, item));
        dispatchBody = skippedItems.length
          ? { ...body, items: body.items.filter((item) => !shouldSkipLocalPromoDispatch(body.chat_id, item)) }
          : body;
        if (dispatchBody.items.length === 0) {
          return res.status(200).json({
            ok: true, skipped: true, skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          });
        }
      } else if (shouldSkipLocalPromoDispatch(body?.chat_id, body)) {
        log('info', 'local_promo_reject_reasons_skipped', {
          source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
          chat_id: body?.chat_id,
          skipped_request_ids: [String(body?.request_id || '')],
          skipped_count: 1,
        });
        return res.status(200).json({ ok: true, skipped: true, skipped_request_ids: [String(body?.request_id || '')] });
      } else if (
        String(body?.chat_id || '').trim() === LOCAL_PROMO_CHAT_ID
        && !hasLocalPromoRejectReasonField(body)
      ) {
        log('warn', 'local_promo_reject_reason_field_missing', {
          source: String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64),
          chat_id: body?.chat_id,
          request_ids: [String(body?.request_id || '')],
          count: 1,
        });
      }

      let chatId;
      let fieldsList;
      let batchId;
      let card;
      if (isBatch) {
        const normalized = normalizeBatchDispatchIngest(dispatchBody);
        ({ chatId, fieldsList, batchId } = normalized);
        card = buildBatchDispatchCard(
          fieldsList,
          batchDispatchActionValue(batchId, fieldsList),
          { cardTitle: normalized.cardTitle, batchId, period: normalized.period },
        );
      } else {
        const normalized = normalizeDispatchIngest(dispatchBody);
        chatId = normalized.chatId;
        fieldsList = [normalized.fields];
        batchId = `single:${normalized.fields.requestId}`;
        card = buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields));
      }

      const fingerprint = createHash('sha256').update(JSON.stringify(fieldsList)).digest('hex');
      const source = String(req.headers?.['x-bess-source'] || 'unknown').slice(0, 64);
      const requestIds = fieldsList.map((item) => item.requestId);
      const store = storeFactory();
      const claim = await store.claimIngestBatch({
        chatId, batchId, fingerprint, requestIds,
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
        return res.status(202).json({
          ok: true, accepted: true, batch_id: batchId, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          status: 'SENDING',
        });
      }
      if (claim.outcome === 'COMPLETE') {
        return res.status(200).json({
          ok: true, batch_id: batchId, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          message_id: claim.message_id, reused: true,
        });
      }

      const messageUuid = isBatch
        ? `bess-batch-${createHash('sha256').update(`${chatId}:${batchId}`).digest('hex').slice(0, 32)}`
        : `bess-ingest-${requestIds[0]}`.slice(0, 50);
      const backgroundSend = (async () => {
        const startedAt = Date.now();
        let message;
        try {
          message = await client.sendMessage({ receiveId: chatId, msgType: 'interactive', content: card, uuid: messageUuid });
        } catch (error) {
          const errorCode = error?.code || 'INGEST_FAILED';
          try {
            await store.failIngestBatch({
              chatId, batchId, fingerprint, requestIds, errorCode,
              expectedLeaseExpiresAt: claim.lease_expires_at,
              failedAt: now(),
            });
          } catch (stateError) {
            log('error', 'delivery_failure_state_write_failed', {
              source, batch_id: batchId, chat_id: chatId,
              error_code: stateError?.code || 'INGEST_STATE_WRITE_FAILED',
            });
          }
          log('error', 'send_failed', {
            source, batch_id: batchId, chat_id: chatId, error_code: errorCode,
            background_duration_ms: Date.now() - startedAt,
          });
          return { status: 'FAILED', errorCode };
        }
        let stateError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await store.completeIngestBatch({
              chatId, batchId, fingerprint, requestIds,
              messageId: message.message_id,
              expectedLeaseExpiresAt: claim.lease_expires_at,
              completedAt: now(),
            });
            stateError = null;
            break;
          } catch (error) {
            stateError = error;
            if (attempt < 3) await sleep(attempt * 200);
          }
        }
        if (stateError) {
          log('error', 'delivery_state_write_failed', {
            source, batch_id: batchId, chat_id: chatId, message_id: message.message_id,
            error_code: stateError?.code || 'INGEST_STATE_WRITE_FAILED',
          });
          // 卡片实际已送达，仅状态写入失败：对同步等待方返回 message_id，避免误报超时。
          return { status: 'SENT', messageId: message.message_id, stateWriteFailed: true };
        }
        log('info', 'sent', {
          source, batch_id: batchId, request_count: fieldsList.length, chat_id: chatId,
          message_id: message.message_id, request_fingerprint: fingerprint,
          background_duration_ms: Date.now() - startedAt,
        });
        return { status: 'SENT', messageId: message.message_id };
      })();
      // 始终登记后台任务，保证函数在返回后仍把投递跑完；同步模式下额外有界等待同一 promise。
      defer(backgroundSend.catch(() => {}));
      // 显式 wait 信号优先；本地推群只有旧版同步大盘 buddy 投递（主监控走异步），
      // 故对该群默认启用有界同步等待，兼容尚未升级、仍同步强等 message_id 的旧客户端。
      let syncWaitMs = resolveSyncWaitMs(req);
      if (syncWaitMs === 0 && chatId === LOCAL_PROMO_CHAT_ID) {
        syncWaitMs = SYNC_WAIT_MAX_MS;
      }
      if (syncWaitMs > 0) {
        const outcome = await Promise.race([
          backgroundSend.then((result) => ({ timedOut: false, result })),
          sleep(syncWaitMs).then(() => ({ timedOut: true })),
        ]);
        if (!outcome.timedOut && outcome.result?.status === 'SENT' && outcome.result.messageId) {
          return res.status(200).json({
            ok: true, batch_id: batchId, request_ids: requestIds,
            ...(isBatch ? {} : { request_id: requestIds[0] }),
            skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
            message_id: outcome.result.messageId, sync: true,
          });
        }
        if (!outcome.timedOut && outcome.result?.status === 'FAILED') {
          // 同步等待期内确认失败：直接返回错误，让调用方立即补偿/告警，而不是傻等轮询。
          return res.status(502).json({ ok: false, error_code: outcome.result.errorCode || 'INGEST_FAILED' });
        }
        log('warn', 'sync_wait_timeout_fallback_202', {
          source, batch_id: batchId, chat_id: chatId, sync_wait_ms: syncWaitMs,
        });
      }
      return res.status(202).json({
        ok: true, accepted: true, batch_id: batchId, request_ids: requestIds,
        ...(isBatch ? {} : { request_id: requestIds[0] }),
        skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
        status: 'SENDING',
      });
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
