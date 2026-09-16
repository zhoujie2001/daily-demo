import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchStatusCache, queuedDispatchStatus } from '../lib/dispatch/status-cache.js';

function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} };
}

test('Runtime Cache 使用稳定散列键并按终态设置长 TTL', async () => {
  const calls = [];
  const values = new Map();
  const cache = {
    async get(key) { calls.push(['get', key]); return values.get(key); },
    async set(key, value, options) {
      calls.push(['set', key, value, options]);
      values.set(key, value);
    },
  };
  const statusCache = createDispatchStatusCache({ cache, logger: silentLogger() });

  await statusCache.set({
    chatId: 'oc_secret', batchId: 'batch_secret',
    value: { found: true, status: 'SENT', message_id: 'om_1', operation_id: 'op_1' },
  });
  const result = await statusCache.get({ chatId: 'oc_secret', batchId: 'batch_secret' });

  assert.equal(result.status, 'SENT');
  assert.equal(result.message_id, 'om_1');
  assert.equal(calls[0][3].ttl, 86_400);
  assert.equal(calls[0][3].name, 'dispatch-sent');
  assert.doesNotMatch(calls[0][1], /oc_secret|batch_secret/);
  assert.equal(calls[0][1], calls[1][1]);
});

test('Runtime Cache 异常时 fail-open，不阻断 Supabase 回退', async () => {
  const statusCache = createDispatchStatusCache({
    cache: {
      async get() { throw Object.assign(new Error('cache down'), { code: 'CACHE_DOWN' }); },
      async set() { throw Object.assign(new Error('cache down'), { code: 'CACHE_DOWN' }); },
    },
    logger: silentLogger(),
  });

  assert.equal(await statusCache.get({ chatId: 'oc_1', batchId: 'batch_1' }), null);
  assert.equal(await statusCache.set({
    chatId: 'oc_1', batchId: 'batch_1',
    value: { status: 'QUEUED', operation_id: 'op_1' },
  }), false);
});

test('QUEUED 快照明确标记尚未物化且只短暂缓存', async () => {
  const writes = [];
  const statusCache = createDispatchStatusCache({
    cache: { async get() {}, async set(...args) { writes.push(args); } },
    logger: silentLogger(),
  });
  const value = queuedDispatchStatus({ operationId: 'op_queue', requestIds: ['r1'] });
  await statusCache.set({ chatId: 'oc_1', batchId: 'batch_1', value });

  assert.equal(value.found, false);
  assert.equal(value.transient, true);
  assert.equal(writes[0][2].ttl, 15);
});
