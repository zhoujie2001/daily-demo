import process from 'node:process';
import { registerQianchuanSource } from '../qianchuan-policy.js';
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient, LarkApiError } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { buildDispatchCardChunkPlans, dispatchChunkSummary, dispatchRootReservation } from '../card-chunks.js';
import { dispatchOperationId } from '../operation.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION, publishDispatchQueueMessage } from '../queue.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { runDurableDispatchHandoff } from '../durable-handoff.js';
import {
  createDispatchStatusCache,
  queuedDispatchStatus,
  readDispatchStatusCache,
  writeDispatchStatusCache,
} from '../status-cache.js';
import { createServerTiming } from '../timing.js';
import { attachDispatchResponseMetadata } from './response-metadata.js';
import {
  DispatchIngestError,
  batchDispatchActionValue,
  dispatchBatchSizeRejection,
  dispatchActionValue,
  dispatchIdempotencyValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
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
const SHUFFLE_DEFAULT_NOTICE_CHATS = Object.freeze([
  'oc_aa1602f07bf35a5fdfd289aff67025a4',
  'oc_2ecc53a432a03f6f81f6a18babe8cda1',
  'oc_99cb9239c03701fe263b870cc26a825c',
  'oc_e1bdb85a89d9f49cb62fd4e3ffebb68e',
  'oc_56debf24fa90e17ea92257c20454d742',
  'oc_38aec46e64a6ebd245c7751271bd770f',
]);
const SHUFFLE_DEFAULT_NOTICE_TEXT = '【派单卡片更新通知】\n明天（2026年10月6日）起，首次初始化今日派单名单时，“打乱人员顺序”将默认不勾选。\n\n- 不勾选：严格按输入顺序轮转\n- 需要随机打乱：请手动勾选“打乱人员顺序”\n\n已初始化的当日名单不受影响。';

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
  publishDispatch = publishDispatchQueueMessage,
  publishTimeoutMs = 2_500,
  defer = waitUntil,
  statusCache = createDispatchStatusCache(),
  storeFactory = () => createSupabaseDispatchStore(),
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
      if (body?.action === 'send_shuffle_default_notice_20261006') {
        if (Object.keys(body).length !== 1) throw new DispatchIngestError('INVALID_SCHEMA', '派单改动通知请求不接受额外字段');
        const messages = await Promise.all(SHUFFLE_DEFAULT_NOTICE_CHATS.map((chatId) => client.sendMessage({
          receiveId: chatId,
          msgType: 'text',
          content: { text: SHUFFLE_DEFAULT_NOTICE_TEXT },
          uuid: `shuffle-unchecked-261006-${chatId.slice(-8)}`,
        })));
        timing.flush();
        return res.status(200).json({
          ok: true,
          messages: messages.map((message, index) => ({ chat_id: SHUFFLE_DEFAULT_NOTICE_CHATS[index], message_id: message.message_id })),
        });
      }

      const isBatch = Array.isArray(body?.items);
      const dryRun = body?.dry_run === true;
      const idempotencyFields = isBatch
        ? normalizeBatchDispatchIngest(body, { splitCards: true }).fieldsList
        : [normalizeDispatchIngest(body).fields];
      const dispatchBody = body;
      const skippedItems = [];
      const allSkipped = false;
      const sourceContext = body?.source_context && typeof body.source_context === 'object'
        ? body.source_context : {};
      const sourceRecordId = String(body?.source_record_id || sourceContext.source_record_id || '').slice(0, 128);
      const source = String(req.headers?.['x-bess-source'] || sourceContext.source || 'unknown').slice(0, 64);

      let chatId;
      let fieldsList;
      let batchId;
      let card;
      let batchNormalized;
      if (isBatch) {
        const normalized = normalizeBatchDispatchIngest(allSkipped ? body : dispatchBody, { splitCards: true });
        batchNormalized = normalized;
        ({ chatId, batchId } = normalized);
        fieldsList = allSkipped ? [] : normalized.fieldsList;
        if (!allSkipped && fieldsList.length <= 20) {
          card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), {
            cardTitle: normalized.cardTitle, batchId, period: normalized.period,
            cardLayout: normalized.cardLayout,
          });
        }
      } else {
        const normalized = normalizeDispatchIngest(dispatchBody);
        if (normalized.fields.sourceBatchId) throw new DispatchIngestError('QIANCHUAN_BATCH_ACTION_REQUIRED', '千川 v2 必须通过批次入口提交');
        chatId = normalized.chatId;
        fieldsList = allSkipped ? [] : [normalized.fields];
        batchId = `single:${normalized.fields.requestId}`;
        if (!allSkipped) card = buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields));
      }

      const fingerprint = createHash('sha256')
        .update(JSON.stringify(idempotencyFields.map(dispatchIdempotencyValue)))
        .digest('hex');
      const requestIds = (allSkipped ? idempotencyFields : fieldsList).map((item) => item.requestId);
      const operation = dispatchOperationId(chatId, batchId);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const chunkPlans = isBatch && !allSkipped
        ? buildDispatchCardChunkPlans(batchNormalized, { source, sourceRecordId, expiresAt })
        : [];
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
        ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
        expires_at: expiresAt,
      };
      if (dryRun) {
        log('info', 'dry_run', { source, batch_id: batchId, operation_id: operation, request_count: requestIds.length });
        timing.flush();
        return res.status(200).json({
          ok: true, status: 'DRY_RUN_OK',
          batch_id: batchId, operation_id: operation, request_ids: requestIds,
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          ...(chunkPlans.length ? { chunks: chunkPlans.map(dispatchChunkSummary) } : {}),
          ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
        });
      }

      const store = storeFactory();
      await registerQianchuanSource(store, batchNormalized, now());
      if (chunkPlans.length > 0) {
        if (typeof store.reserveDispatchIngestRoot !== 'function') {
          throw Object.assign(new Error('原始派单批次幂等预留尚未配置'), {
            code: 'DISPATCH_ROOT_RESERVATION_UNAVAILABLE', status: 503,
          });
        }
        const root = dispatchRootReservation(batchNormalized, chunkPlans);
        const rootReservation = await store.reserveDispatchIngestRoot({
          ...root, expiresAt, now: now(),
        });
        if (rootReservation.outcome === 'PAYLOAD_CONFLICT') {
          log('warn', 'root_payload_conflict', { source, batch_id: batchId, request_count: requestIds.length });
          timing.flush();
          return res.status(409).json({
            ok: false, error_code: 'PAYLOAD_CONFLICT',
            message: '同批次号已绑定不同的需求内容或拆卡规划',
            batch_id: batchId,
          });
        }
      }

      if (chunkPlans.length > 1) {
        const acceptances = await Promise.all(chunkPlans.map((plan) => runDurableDispatchHandoff({
          store,
          registration: {
            chatId, batchId: plan.batchId, fingerprint: plan.fingerprint,
            requestIds: plan.requestIds, operationId: plan.operationId,
            card: plan.card, queueMessage: plan.queueMessage, source, sourceRecordId,
            expiresAt, now: now(),
          },
          publishDispatch, publishTimeoutMs, defer, now,
        })));
        const conflictIndex = acceptances.findIndex((item) => item.kind === 'CONFLICT');
        if (conflictIndex >= 0) {
          const plan = chunkPlans[conflictIndex];
          log('warn', 'payload_conflict', { source, batch_id: batchId, chunk_batch_id: plan.batchId, operation_id: plan.operationId });
          timing.flush();
          return res.status(409).json({
            ok: false, error_code: 'PAYLOAD_CONFLICT', message: '同批次号已存在不同的请求内容',
            batch_id: batchId, chunk_batch_id: plan.batchId, operation_id: plan.operationId,
            chunks: chunkPlans.map(dispatchChunkSummary),
          });
        }
        const chunks = chunkPlans.map((plan, index) => ({
          ...dispatchChunkSummary(plan),
          durable_status: acceptances[index].handoff.status,
          reused: acceptances[index].kind === 'REUSED',
        }));
        // Handoff registration is not a delivery receipt. In particular a
        // replayed SENT handoff does not include message_id. Only the worker
        // and authoritative status reads may populate split delivery caches;
        // otherwise this request can erase a concurrent worker's SENT receipt.
        const dead = acceptances.findIndex((item) => item.kind === 'DEAD');
        const unknown = acceptances.findIndex((item) => item.kind === 'UNKNOWN');
        if (dead >= 0) {
          timing.flush();
          return res.status(200).json({
            ok: false, accepted: false, status: 'FAILED', dead_letter: true,
            error_code: acceptances[dead].handoff.error_code || 'OUTBOX_DELIVERY_FAILED',
            batch_id: batchId, request_ids: requestIds, chunks,
          });
        }
        if (unknown >= 0) {
          const timedOut = acceptances[unknown].error?.code === 'DISPATCH_QUEUE_TIMEOUT';
          timing.flush();
          return res.status(timedOut ? 503 : 202).json({
            ok: !timedOut, accepted: !timedOut, accepted_unknown: true, status: 'QUEUING',
            durable_status: 'ACCEPTED_UNKNOWN', recovery: 'NEEDS_RECONCILIATION',
            error_code: acceptances[unknown].error?.code || 'HANDOFF_CONFIRM_FAILED',
            batch_id: batchId, request_ids: requestIds, chunks,
          });
        }
        const allSent = acceptances.every((item) => item.handoff.status === 'SENT');
        timing.flush();
        return res.status(allSent ? 200 : 202).json({
          ok: true, accepted: true, status: allSent ? 'SENT' : 'QUEUED',
          durable_status: allSent ? 'SENT' : 'QUEUED', recovery: 'CONFIRMED',
          batch_id: batchId, request_ids: requestIds, chunks,
          operation_ids: chunks.map((chunk) => chunk.operation_id),
          ...(chunks.every((chunk) => chunk.reused) ? { reused: true } : {}),
          ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
        });
      }

      const publishStartedAt = Date.now();
      const acceptance = await runDurableDispatchHandoff({
        store,
        registration: {
          chatId, batchId, fingerprint, requestIds, operationId: operation,
          card, queueMessage, source, sourceRecordId, expiresAt, now: now(),
        },
        publishDispatch,
        publishTimeoutMs,
        defer,
        now,
      });
      const { handoff } = acceptance;

      if (acceptance.kind === 'CONFLICT') {
        log('warn', 'payload_conflict', { source, batch_id: batchId, operation_id: operation });
        timing.flush();
        return res.status(409).json({
          ok: false, error_code: 'PAYLOAD_CONFLICT',
          message: '同批次号已存在不同的请求内容',
          batch_id: batchId, operation_id: handoff.operation_id,
        });
      }

      if (acceptance.kind === 'DEAD') {
        timing.flush();
        return res.status(200).json({
          ok: false, accepted: false, status: 'FAILED', dead_letter: true,
          error_code: 'OUTBOX_DELIVERY_FAILED',
          batch_id: batchId, operation_id: handoff.operation_id,
          request_ids: requestIds,
          ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
          reused: true,
        });
      }

      if (acceptance.kind === 'REUSED') {
        log('info', 'handoff_reused', { source, batch_id: batchId, status: handoff.status });
        const cachedStatus = await readDispatchStatusCache(statusCache, { chatId, batchId });
        if (!cachedStatus) {
          await writeDispatchStatusCache(statusCache, {
            chatId, batchId,
            value: { found: true, status: handoff.status, operation_id: handoff.operation_id, request_ids: requestIds },
          });
        }
        const isSent = handoff.status === 'SENT';
        const acceptedUnknown = ['HANDOFF_PENDING', 'ACCEPTED_UNKNOWN'].includes(handoff.status);
        timing.measure('queue', publishStartedAt);
        timing.flush();
        return res.status(isSent ? 200 : 202).json({
          ok: true, accepted: true, status: isSent ? 'SENT' : 'QUEUED',
          batch_id: batchId, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          operation_id: handoff.operation_id,
          ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
          reused: true,
          durable_status: handoff.status,
          ...(acceptedUnknown ? { accepted_unknown: true, recovery: 'NEEDS_RECONCILIATION' } : { recovery: 'CONFIRMED' }),
        });
      }

      if (acceptance.kind === 'UNKNOWN') {
        const timedOut = acceptance.error?.code === 'DISPATCH_QUEUE_TIMEOUT';
        log('warn', timedOut ? 'queue_timeout' : 'queue_confirm_unknown', {
          source, batch_id: batchId, operation_id: operation,
          error_code: acceptance.error?.code || 'HANDOFF_CONFIRM_FAILED',
        });
        timing.measure('queue', publishStartedAt);
        timing.flush();
        return res.status(timedOut ? 503 : 202).json({
          ok: !timedOut, accepted: !timedOut, accepted_unknown: true, status: 'QUEUING',
          durable_status: 'ACCEPTED_UNKNOWN', recovery: 'NEEDS_RECONCILIATION',
          error_code: acceptance.error?.code || 'HANDOFF_CONFIRM_FAILED',
          batch_id: batchId, operation_id: operation, request_ids: requestIds,
          ...(isBatch ? {} : { request_id: requestIds[0] }),
          skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
          ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
        });
      }

      const published = acceptance.published;
      log('info', 'queue_accepted', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_count: requestIds.length,
        queue_message_id: published?.message_id || '',
        deduplicated: Boolean(published?.deduplicated),
        duration_ms: Date.now() - publishStartedAt,
      });
      timing.measure('queue', publishStartedAt);

      const cacheStartedAt = Date.now();
      const cachedStatus = published?.deduplicated
        ? await readDispatchStatusCache(statusCache, { chatId, batchId })
        : null;
      if (!published?.deduplicated || !cachedStatus) {
        await writeDispatchStatusCache(statusCache, {
          chatId, batchId,
          value: queuedDispatchStatus({ operationId: operation, requestIds }),
        });
      }
      timing.measure('cache', cacheStartedAt);
      timing.flush();
      return res.status(202).json({
        ok: true, accepted: true, status: 'QUEUED',
        durable_status: 'QUEUED', recovery: 'CONFIRMED',
        batch_id: batchId, request_ids: requestIds,
        ...(isBatch ? {} : { request_id: requestIds[0] }),
        skipped_request_ids: skippedItems.map((item) => String(item?.request_id || '')),
        operation_id: operation,
        ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
        ...(published?.message_id ? { queue_message_id: published.message_id } : {}),
        ...(published?.deduplicated ? { reused: true } : {}),
      });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code : error instanceof LarkApiError ? error.code : error?.code || 'INGEST_FAILED';
      const rejection = dispatchBatchSizeRejection(error);
      log('error', 'failed', { error_code: code, ...rejection });
      timing.flush();
      return res.status(status).json({ ok: false, error_code: code, ...rejection });
    }
  };
}

export default createDispatchSendHandler();
