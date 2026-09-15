import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { LarkClient } from '../lark/client.js';
import { createSupabaseDispatchStore } from './supabase-store.js';

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

export async function runDispatchOutbox({
  store = createSupabaseDispatchStore(),
  client = defaultClient,
  workerToken = randomUUID(),
  limit = 5,
  leaseSeconds = 45,
  maxAttempts = 8,
  now = () => new Date(),
} = {}) {
  const claimed = await store.claimDispatchOutbox({
    workerToken, limit, leaseSeconds, maxAttempts, now: now(),
  });
  const results = [];
  for (const task of claimed) {
    const startedAt = Date.now();
    try {
      // operation_id is persisted before this call and reused for every recovery.
      // Lark's uuid makes a repeated recovery the same logical send, not a blind duplicate.
      const message = await client.sendMessage({
        receiveId: task.chat_id,
        msgType: 'interactive',
        content: task.card,
        uuid: task.operation_id,
      });
      if (!message?.message_id) throw Object.assign(new Error('Lark response missing message_id'), { code: 'LARK_MESSAGE_ID_MISSING' });
      await store.completeDispatchOutbox({
        formMessageId: task.form_message_id,
        workerToken,
        operationId: task.operation_id,
        messageId: message.message_id,
        completedAt: now(),
      });
      log('info', 'delivered', {
        batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
        message_id: message.message_id, attempt: task.attempt, duration_ms: Date.now() - startedAt,
      });
      results.push({ ok: true, batch_id: task.batch_id, chat_id: task.chat_id, message_id: message.message_id });
    } catch (error) {
      const dead = Number(task.attempt || 0) >= maxAttempts;
      try {
        await store.retryDispatchOutbox({
          formMessageId: task.form_message_id,
          workerToken,
          operationId: task.operation_id,
          errorCode: error?.code || 'OUTBOX_DELIVERY_FAILED',
          nextRetryAt: new Date(now().getTime() + retryDelaySeconds(task.attempt) * 1000),
          dead,
        });
      } catch (stateError) {
        log('error', 'retry_state_write_failed', {
          batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
          error_code: stateError?.code || 'OUTBOX_STATE_WRITE_FAILED',
        });
      }
      log('error', dead ? 'dead_lettered' : 'delivery_failed', {
        batch_id: task.batch_id, chat_id: task.chat_id, operation_id: task.operation_id,
        error_code: error?.code || 'OUTBOX_DELIVERY_FAILED', attempt: task.attempt,
        duration_ms: Date.now() - startedAt,
      });
      results.push({ ok: false, batch_id: task.batch_id, chat_id: task.chat_id, dead, error_code: error?.code || 'OUTBOX_DELIVERY_FAILED' });
    }
  }
  return { ok: true, claimed: claimed.length, results };
}
