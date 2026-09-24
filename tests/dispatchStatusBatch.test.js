import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createDispatchStatusBatchHandler } from '../lib/dispatch/api/status-batch.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';

const SECRET = 'batch-status-secret';
const NOW = Math.floor(Date.now() / 1000);

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest('hex');
}

async function invoke(body, options = {}, headers = {}) {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  const handler = createDispatchStatusBatchHandler(options);
  await handler({
    method: 'POST',
    body,
    headers: {
      'x-bess-timestamp': String(NOW),
      'x-bess-signature': `sha256=${signature(body)}`,
      ...headers,
    },
  }, response);
  return result;
}

const missCache = {
  async get() { return null; },
  async set() { return true; },
};

test('batch status 沿用签名鉴权并返回诊断响应头', async () => {
  const body = { items: [{ chat_id: 'oc_a', batch_id: 'batch_a' }] };
  const result = await invoke(body, {
    statusCache: missCache,
    storeFactory: () => ({
      async getIngestBatchStatuses() { return [{ chat_id: 'oc_a', batch_id: 'batch_a', found: true, status: 'SENT', message_id: 'om_a' }]; },
    }),
  }, { 'x-bess-request-id': 'caller-request-1' });

  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].message_id, 'om_a');
  assert.equal(result.headers['X-Bess-Request-Id'], 'caller-request-1');
  assert.equal(result.headers['X-Bess-Status-Source'], 'supabase');
  for (const phase of ['auth', 'cache', 'database', 'queue', 'total']) {
    assert.match(result.headers['Server-Timing'], new RegExp(`${phase};dur=`));
  }
});

test('batch status 拒绝无效签名', async () => {
  const body = { items: [{ chat_id: 'oc_a', batch_id: 'batch_a' }] };
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await createDispatchStatusBatchHandler({ statusCache: missCache })({
    method: 'POST', body, headers: { 'x-bess-timestamp': String(NOW), 'x-bess-signature': 'sha256=bad' },
  }, response);
  assert.equal(result.status, 401);
  assert.equal(result.body.error_code, 'INVALID_SIGNATURE');
});

test('batch status 限制最多 20 个条目', async () => {
  const body = { items: Array.from({ length: 21 }, (_, index) => ({ chat_id: 'oc_a', batch_id: `batch_${index}` })) };
  const result = await invoke(body, { statusCache: missCache });
  assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'TOO_MANY_ITEMS');
});

test('batch status 去重相同 chat_id 与 batch_id 且单项无效不拖垮整批', async () => {
  const body = { items: [
    { chat_id: 'oc_a', batch_id: 'batch_a' },
    { chat_id: 'oc_a', batch_id: 'batch_a' },
    { chat_id: '', batch_id: 'bad' },
  ] };
  let queried;
  const result = await invoke(body, {
    statusCache: missCache,
    storeFactory: () => ({
      async getIngestBatchStatuses(items) {
        queried = items;
        return [{ chat_id: 'oc_a', batch_id: 'batch_a', found: true, status: 'SENT', message_id: 'om_a' }];
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(queried.map(({ chatId, batchId }) => ({ chatId, batchId })), [{ chatId: 'oc_a', batchId: 'batch_a' }]);
  assert.equal(result.body.items.length, 2);
  assert.equal(result.body.items[0].status, 'SENT');
  assert.equal(result.body.items[1].error_code, 'INVALID_ITEM_SCHEMA');
});

test('runtime cache 全命中时完全不创建 Supabase store', async () => {
  const body = { items: [
    { chat_id: 'oc_a', batch_id: 'batch_a' },
    { chat_id: 'oc_b', batch_id: 'batch_b' },
  ] };
  let storeCreated = 0;
  const result = await invoke(body, {
    statusCache: {
      async get({ batchId }) { return { found: true, status: 'SENT', message_id: `om_${batchId}` }; },
      async set() { throw new Error('must not write cache hits'); },
    },
    storeFactory() { storeCreated += 1; throw new Error('must not access Supabase'); },
  });

  assert.equal(result.status, 200);
  assert.equal(storeCreated, 0);
  assert.equal(result.headers['X-Bess-Status-Source'], 'runtime-cache');
  assert.deepEqual(result.body.items.map((item) => item.source), ['runtime-cache', 'runtime-cache']);
});

test('Supabase 批量读取失败被隔离为逐项可重试结果', async () => {
  const body = { items: [
    { chat_id: 'oc_a', batch_id: 'batch_a' },
    { chat_id: 'oc_b', batch_id: 'batch_b' },
  ] };
  const result = await invoke(body, {
    statusCache: missCache,
    storeFactory: () => ({
      async getIngestBatchStatuses() { throw Object.assign(new Error('db timeout'), { code: 'DISPATCH_DB_TIMEOUT' }); },
    }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items.map((item) => item.error_code), [
    'STATUS_TEMPORARILY_UNAVAILABLE',
    'STATUS_TEMPORARILY_UNAVAILABLE',
  ]);
  assert.ok(result.body.items.every((item) => item.retryable === true));
});

test('响应头不回显签名、密钥或完整批次内容', async () => {
  const sensitiveBatch = 'batch-secret-value-that-must-not-leak';
  const body = { items: [{ chat_id: 'oc_a', batch_id: sensitiveBatch }] };
  const result = await invoke(body, {
    statusCache: {
      async get() { return { found: true, status: 'SENT', message_id: 'om_a' }; },
    },
  });
  const serializedHeaders = JSON.stringify(result.headers);
  assert.doesNotMatch(serializedHeaders, /batch-secret-value-that-must-not-leak/);
  assert.doesNotMatch(serializedHeaders, /batch-status-secret/);
  assert.doesNotMatch(serializedHeaders, /x-bess-signature/i);
});
