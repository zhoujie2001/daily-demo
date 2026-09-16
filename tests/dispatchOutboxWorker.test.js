import assert from 'node:assert/strict';
import test from 'node:test';
import { processDispatchQueueMessage, runDispatchOutbox } from '../lib/dispatch/outbox-worker.js';

function task(overrides = {}) {
  return {
    form_message_id: 'bi_1', chat_id: 'oc_1', batch_id: 'batch_1',
    operation_id: 'bess-outbox-stable', request_ids: ['r1'], card: { schema: '2.0' }, attempt: 1,
    ...overrides,
  };
}

function queueMessage(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'dispatch',
    chat_id: 'oc_1',
    batch_id: 'batch_1',
    fingerprint: 'fingerprint_1',
    operation_id: 'bess-outbox-stable',
    request_ids: ['r1'],
    card: { schema: '2.0' },
    source: 'test',
    expires_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

test('worker 使用持久 operation_id 并提交 message_id', async () => {
  const calls = [];
  const store = {
    async claimDispatchOutbox() { return [task()]; },
    async completeDispatchOutbox(payload) { calls.push(payload); return { completed: true }; },
    async retryDispatchOutbox() { throw new Error('must not retry'); },
  };
  const client = { async sendMessage(payload) { assert.equal(payload.uuid, 'bess-outbox-stable'); return { message_id: 'om_1' }; } };
  const result = await runDispatchOutbox({ store, client, workerToken: 'worker-1' });
  assert.equal(result.results[0].ok, true);
  assert.equal(calls[0].messageId, 'om_1');
  assert.equal(calls[0].operationId, 'bess-outbox-stable');
});

test('Lark 成功但 complete 超时后稳定 uuid 可安全恢复', async () => {
  const uuids = [];
  let run = 0;
  const store = {
    async claimDispatchOutbox() { run += 1; return [task({ attempt: run })]; },
    async completeDispatchOutbox() {
      if (run === 1) throw Object.assign(new Error('db timeout'), { code: 'DISPATCH_DB_TIMEOUT' });
      return { completed: true };
    },
    async retryDispatchOutbox() { return { updated: true }; },
  };
  const client = { async sendMessage({ uuid }) { uuids.push(uuid); return { message_id: 'om_same' }; } };
  const first = await runDispatchOutbox({ store, client, workerToken: 'worker-1' });
  const second = await runDispatchOutbox({ store, client, workerToken: 'worker-2' });
  assert.equal(first.results[0].ok, false);
  assert.equal(second.results[0].ok, true);
  assert.deepEqual(uuids, ['bess-outbox-stable', 'bess-outbox-stable']);
});

test('worker 终止或租约过期后由新 worker 接管且不共享 token', async () => {
  const claims = [];
  const store = {
    async claimDispatchOutbox(payload) { claims.push(payload); return claims.length === 1 ? [] : [task({ attempt: 2 })]; },
    async completeDispatchOutbox({ workerToken }) { assert.equal(workerToken, 'worker-new'); return { completed: true }; },
    async retryDispatchOutbox() { return { updated: true }; },
  };
  const client = { async sendMessage() { return { message_id: 'om_recovered' }; } };
  assert.equal((await runDispatchOutbox({ store, client, workerToken: 'worker-old' })).claimed, 0);
  assert.equal((await runDispatchOutbox({ store, client, workerToken: 'worker-new' })).results[0].ok, true);
  assert.notEqual(claims[0].workerToken, claims[1].workerToken);
});

test('达到 attempt 上限进入 dead-letter', async () => {
  let retry;
  const store = {
    async claimDispatchOutbox() { return [task({ attempt: 8 })]; },
    async completeDispatchOutbox() { throw new Error('must not complete'); },
    async retryDispatchOutbox(payload) { retry = payload; return { updated: true }; },
  };
  const client = { async sendMessage() { throw Object.assign(new Error('bad'), { code: 'LARK_BAD' }); } };
  const result = await runDispatchOutbox({ store, client, workerToken: 'worker-1', maxAttempts: 8 });
  assert.equal(result.results[0].dead, true);
  assert.equal(retry.dead, true);
  assert.equal(retry.errorCode, 'LARK_BAD');
});

test('空 claim 保证重复 worker 不会重复发送', async () => {
  let sends = 0;
  const store = { async claimDispatchOutbox() { return []; } };
  const client = { async sendMessage() { sends += 1; } };
  const result = await runDispatchOutbox({ store, client, workerToken: 'worker-duplicate' });
  assert.equal(result.claimed, 0);
  assert.equal(sends, 0);
});

test('队列消费者先持久化 outbox，再用稳定 uuid 发卡并落账', async () => {
  const calls = [];
  const store = {
    async enqueueDispatchOutbox(payload) {
      calls.push(['enqueue', payload]);
      return { outcome: 'ACCEPTED', status: 'QUEUED', operation_id: payload.operationId };
    },
    async claimDispatchOutboxBatch({ chatId, batchId }) {
      calls.push(['claim', { chatId, batchId }]);
      return [task()];
    },
    async completeDispatchOutbox(payload) { calls.push(['complete', payload]); return { completed: true }; },
    async retryDispatchOutbox() { throw new Error('must not retry'); },
  };
  const client = {
    async sendMessage({ uuid }) {
      assert.equal(uuid, 'bess-outbox-stable');
      calls.push(['send']);
      return { message_id: 'om_queue_1' };
    },
  };

  const result = await processDispatchQueueMessage(queueMessage(), { store, client });
  assert.equal(result.ok, true);
  assert.equal(result.message_id, 'om_queue_1');
  assert.deepEqual(calls.map(([name]) => name), ['enqueue', 'claim', 'send', 'complete']);
});

test('队列重放命中已完成账本时不再发卡', async () => {
  let sends = 0;
  const store = {
    async enqueueDispatchOutbox() {
      return { outcome: 'COMPLETE', status: 'SENT', message_id: 'om_existing' };
    },
  };
  const result = await processDispatchQueueMessage(queueMessage(), {
    store,
    client: { async sendMessage() { sends += 1; } },
  });
  assert.equal(result.reused, true);
  assert.equal(result.message_id, 'om_existing');
  assert.equal(sends, 0);
});

test('Supabase 入 outbox 超时时抛出错误交给 Vercel Queue 持久重试', async () => {
  const error = Object.assign(new Error('slow database'), { code: 'DISPATCH_DB_TIMEOUT' });
  await assert.rejects(
    processDispatchQueueMessage(queueMessage(), {
      store: { async enqueueDispatchOutbox() { throw error; } },
      client: { async sendMessage() { throw new Error('must not send'); } },
    }),
    (actual) => actual === error,
  );
});

test('全量过滤的 skip 队列任务提交稳定伪 message_id 且不发卡', async () => {
  let completed;
  let sends = 0;
  const store = {
    async claimIngestBatch() { return { outcome: 'CLAIMED', lease_expires_at: '2026-09-16T12:00:00.000Z' }; },
    async completeIngestBatch(payload) { completed = payload; },
  };
  const result = await processDispatchQueueMessage(queueMessage({ kind: 'skip', card: null }), {
    store,
    client: { async sendMessage() { sends += 1; } },
  });
  assert.equal(result.skipped, true);
  assert.equal(completed.messageId, 'skipped:bess-outbox-stable');
  assert.equal(sends, 0);
});

test('无效或冲突的队列消息标记 acknowledge，避免毒消息无限重试', async () => {
  await assert.rejects(
    processDispatchQueueMessage(queueMessage({ schema_version: 99 }), { store: {} }),
    (error) => error.code === 'INVALID_DISPATCH_QUEUE_MESSAGE' && error.acknowledge === true,
  );
  await assert.rejects(
    processDispatchQueueMessage(queueMessage(), {
      store: { async enqueueDispatchOutbox() { return { outcome: 'CONFLICT' }; } },
    }),
    (error) => error.code === 'BATCH_ID_CONFLICT' && error.acknowledge === true,
  );
});
