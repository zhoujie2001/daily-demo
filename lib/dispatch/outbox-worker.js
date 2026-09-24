import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { LarkClient } from '../lark/client.js';
import { createSupabaseDispatchStore } from './supabase-store.js';
import { createDispatchStatusCache, writeDispatchStatusCache } from './status-cache.js';

const defaultClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

function log(level, stage, fields = {}) {
  console[level](JSON.stringify({ module: 'bess-dispatch-outbox', stage, ...fields }));
}

function retryDelaySeconds(attempt) {
  return Math.min(900, Math.max(5, 5 * (2 ** Math.max(0, attempt - 1))));
}

function queueError(code, message, { acknowledge = false } = {}) {
  return Object.assign(new Error(message), { code, acknowledge });
}

export async function runDispatchOutbox({
  store = createSupabaseDispatchStore(),
  client = defaultClient,
  workerToken = randomUUID(),
  limit = 5,
  leaseSeconds = 45,
  maxAttempts = 8,
  target,
  now = () => new Date(),
  statusCache = createDispatchStatusCache(),
} = {}) {
  const claimStartedAt = Date.now();
  const claim = target && typeof store.claimDispatchOutboxBatch === 'function'
    ? store.claimDispatchOutboxBatch.bind(store)
    : store.claimDispatchOutbox.bind(store);
  const claimed = await claim({
    workerToken, limit, leaseSeconds, maxAttempts, now: now(),
    ...(target ? { chatId: target.chatId, batchId: target.batchId } : {}),
  });
  const claimDurationMs = Date.now() - claimStartedAt;
  const results = [];
  for (const task of claimed) {
    const startedAt = Date.now();
    let larkDurationMs = 0;
    let completionDurationMs = 0;
    try {
      // operation_id is persisted before this call and reused for every recovery.
      // Lark's uuid makes a repeated recovery the same logical send, not a blind duplicate.
      const larkStartedAt = Date.now();
      const message = await client.sendMessage({
        receiveId: task.chat_id,
        msgType: 'interactive',
        content: task.card,
        uuid: task.operation_id,
      });
      larkDurationMs = Date.now() - larkStartedAt;
      if (!message?.message_id) throw Object.assign(new Error('Lark response missing message_id'), { code: 'LARK_MESSAGE_ID_MISSING' });
      const completionStartedAt = Date.now();
      await store.completeDispatchOutbox({
        formMessageId: task.form_message_id,
        workerToken,
        operationId: task.operation_id,
        messageId: message.message_id,
        completedAt: now(),
      });
      completionDurationMs = Date.now() - completionStartedAt;
      await writeDispatchStatusCache(statusCache, {
        chatId: task.chat_id, batchId: task.batch_id,
        value: {
          found: true, status: 'SENT', operation_id: task.operation_id,
          message_id: message.message_id, request_ids: task.request_ids,
          retryable: false,
        },
      });
      log('info', 'delivered', {
        batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
        message_id: message.message_id, attempt: task.attempt, duration_ms: Date.now() - startedAt,
        claim_duration_ms: claimDurationMs, lark_duration_ms: larkDurationMs,
        completion_duration_ms: completionDurationMs,
      });
      results.push({ ok: true, batch_id: task.batch_id, chat_id: task.chat_id, message_id: message.message_id });
    } catch (error) {
      const dead = Number(task.attempt || 0) >= maxAttempts;
      let retryRecorded = false;
      try {
        await store.retryDispatchOutbox({
          formMessageId: task.form_message_id,
          workerToken,
          operationId: task.operation_id,
          errorCode: error?.code || 'OUTBOX_DELIVERY_FAILED',
          nextRetryAt: new Date(now().getTime() + retryDelaySeconds(task.attempt) * 1000),
          dead,
        });
        retryRecorded = true;
      } catch (stateError) {
        log('error', 'retry_state_write_failed', {
          batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
          error_code: stateError?.code || 'OUTBOX_STATE_WRITE_FAILED',
        });
      }
      if (retryRecorded) {
        await writeDispatchStatusCache(statusCache, {
          chatId: task.chat_id, batchId: task.batch_id,
          value: {
            found: true, status: dead ? 'DEAD' : 'RETRY',
            operation_id: task.operation_id, request_ids: task.request_ids,
            error_code: error?.code || 'OUTBOX_DELIVERY_FAILED', retryable: !dead,
            attempt: task.attempt,
          },
        });
      }
      log('error', dead ? 'dead_lettered' : 'delivery_failed', {
        batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
        error_code: error?.code || 'OUTBOX_DELIVERY_FAILED', attempt: task.attempt,
        duration_ms: Date.now() - startedAt,
        claim_duration_ms: claimDurationMs, lark_duration_ms: larkDurationMs,
        completion_duration_ms: completionDurationMs,
      });
      results.push({ ok: false, batch_id: task.batch_id, chat_id: task.chat_id, dead, error_code: error?.code || 'OUTBOX_DELIVERY_FAILED' });
    }
  }
  return { ok: true, claimed: claimed.length, results };
}

export async function processDispatchQueueMessage(message, {
  store,
  client = defaultClient,
  now = () => new Date(),
  statusCache = createDispatchStatusCache(),
} = {}) {
  const chatId = String(message?.chat_id || '').trim();
  const batchId = String(message?.batch_id || '').trim();
  const fingerprint = String(message?.fingerprint || '').trim();
  const operationId = String(message?.operation_id || '').trim();
  const requestIds = Array.isArray(message?.request_ids) ? message.request_ids.map(String) : [];
  const kind = String(message?.kind || 'dispatch');
  if (Number(message?.schema_version) !== 1 || !chatId || !batchId || !fingerprint || !operationId || requestIds.length === 0) {
    throw queueError('INVALID_DISPATCH_QUEUE_MESSAGE', '排单队列消息结构无效', { acknowledge: true });
  }
  const dispatchStore = store || createSupabaseDispatchStore();

  if (kind === 'skip') {
    const claim = await dispatchStore.claimIngestBatch({
      chatId, batchId, fingerprint, requestIds, now: now(), expiresAt: message.expires_at,
    });
    if (claim.outcome === 'CONFLICT') {
      throw queueError('BATCH_ID_CONFLICT', '批次号已绑定不同请求集合', { acknowledge: true });
    }
    if (claim.outcome === 'COMPLETE') return { ok: true, skipped: true, reused: true };
    if (claim.outcome === 'IN_FLIGHT') {
      throw queueError('DISPATCH_SKIP_IN_FLIGHT', '过滤终态仍在提交中');
    }
    await dispatchStore.completeIngestBatch({
      chatId, batchId, fingerprint, requestIds,
      messageId: `skipped:${operationId}`,
      expectedLeaseExpiresAt: claim.lease_expires_at,
      completedAt: now(),
    });
    await writeDispatchStatusCache(statusCache, {
      chatId, batchId,
      value: {
        found: true, status: 'SENT', operation_id: operationId,
        message_id: `skipped:${operationId}`, request_ids: requestIds,
        retryable: false,
      },
    });
    log('info', 'skipped_completed', {
      batch_id: batchId, chat_id: chatId, operation_id: operationId,
      request_count: requestIds.length,
    });
    return { ok: true, skipped: true };
  }

  if (kind !== 'dispatch' || !message?.card) {
    throw queueError('INVALID_DISPATCH_QUEUE_MESSAGE', '排单队列消息缺少卡片', { acknowledge: true });
  }

  const enqueueStartedAt = Date.now();
  const accepted = await dispatchStore.enqueueDispatchOutbox({
    chatId, batchId, fingerprint, requestIds, operationId,
    card: message.card, source: message.source,
    now: now(), expiresAt: message.expires_at,
  });
  log('info', 'ledger_materialized', {
    batch_id: batchId, chat_id: chatId, operation_id: operationId,
    outcome: accepted.outcome, status: accepted.status,
    duration_ms: Date.now() - enqueueStartedAt,
  });
  if (accepted.outcome === 'CONFLICT') {
    throw queueError('BATCH_ID_CONFLICT', '批次号已绑定不同请求集合', { acknowledge: true });
  }
  if (accepted.outcome === 'COMPLETE' || accepted.status === 'SENT') {
    await writeDispatchStatusCache(statusCache, {
      chatId, batchId,
      value: {
        found: true, status: 'SENT', operation_id: accepted.operation_id || operationId,
        message_id: accepted.message_id || '', request_ids: requestIds, retryable: false,
      },
    });
    return { ok: true, reused: true, message_id: accepted.message_id || '' };
  }

  await writeDispatchStatusCache(statusCache, {
    chatId, batchId,
    value: {
      found: true, status: String(accepted.status || 'QUEUED'),
      operation_id: accepted.operation_id || operationId,
      message_id: accepted.message_id || '', request_ids: requestIds,
      error_code: accepted.error_code || '', retryable: false,
    },
  });

  const result = await runDispatchOutbox({ store: dispatchStore, client, target: { chatId, batchId }, now, statusCache });
  const delivery = result.results[0];
  if (delivery?.ok) return delivery;
  if (delivery?.dead) return delivery;
  if (delivery) {
    throw queueError(delivery.error_code || 'OUTBOX_DELIVERY_FAILED', '排单发送将在队列中重试');
  }

  const status = await dispatchStore.getIngestBatchStatus({ chatId, batchId });
  await writeDispatchStatusCache(statusCache, { chatId, batchId, value: status });
  if (status?.status === 'SENT') return { ok: true, reused: true, message_id: status.message_id || '' };
  if (status?.status === 'DEAD') return { ok: false, dead: true, error_code: status.error_code || 'OUTBOX_DELIVERY_FAILED' };
  throw queueError('OUTBOX_NOT_READY', '排单任务尚未取得处理租约');
}
