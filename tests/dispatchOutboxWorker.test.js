import assert from 'node:assert/strict';
import test from 'node:test';
import { runDispatchOutbox } from '../lib/dispatch/outbox-worker.js';

function task(overrides = {}) {
  return {
    form_message_id: 'bi_1', chat_id: 'oc_1', batch_id: 'batch_1',
    operation_id: 'bess-outbox-stable', request_ids: ['r1'], card: { schema: '2.0' }, attempt: 1,
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
