import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';
import { runDispatchOutbox } from '../lib/dispatch/outbox-worker.js';

const SECRET = 'dispatch-status-test-secret';
const NOW = Math.floor(Date.now() / 1000);

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest('hex');
}

async function invoke(body, store, handlerOptions = {}) {
  const result = { headers: {} };
  Object.defineProperty(result, 'deferred', { value: [], enumerable: false });
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  const handler = createDispatchStatusHandler({
    storeFactory: () => store,
    defer(promise) { result.deferred.push(promise); },
    ...handlerOptions,
  });
  await handler({
    method: 'POST',
    body,
    headers: {
      'x-bess-timestamp': String(NOW),
      'x-bess-signature': `sha256=${signature(body)}`,
    },
  }, response);
  return result;
}

test('队列已接受但账本尚未物化时返回短轮询提示', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_missing' },
    { async getIngestBatchStatus() { return { found: false }; } },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.found, false);
  assert.equal(result.body.status, 'QUEUED');
  assert.equal(result.body.transient, true);
  assert.equal(result.body.retry_after_ms, 2_000);
  assert.match(result.body.operation_id, /^bess-outbox-/);
});

test('Supabase 状态查询超时返回可重试 503，不误报业务失败', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_db_timeout' },
    {
      async getIngestBatchStatus() {
        throw Object.assign(new Error('slow Supabase'), { code: 'DISPATCH_DB_TIMEOUT' });
      },
    },
  );

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    ok: false,
    status: 'UNAVAILABLE',
    transient: true,
    error_code: 'STATUS_TEMPORARILY_UNAVAILABLE',
    retry_after_ms: 2_000,
  });
});

test('持久化批次完成后返回 SENT 和 message_id', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_sent' },
    {
      async getIngestBatchStatus({ chatId, batchId }) {
        assert.equal(chatId, 'oc_test');
        assert.equal(batchId, 'batch_sent');
        return { found: true, status: 'SENT', message_id: 'om_sent' };
      },
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    found: true,
    status: 'SENT',
    message_id: 'om_sent',
  });
});


test('单条 status 使用 request_id 派生稳定批次主键且只查询本地账本', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  let query;
  const startedAt = Date.now();
  const result = await invoke(
    { chat_id: 'oc_test', request_id: '762999' },
    {
      async getIngestBatchStatus(value) {
        query = value;
        return { found: true, status: 'FAILED', retryable: true, error_code: 'LARK_TIMEOUT' };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(query, { chatId: 'oc_test', batchId: 'single:762999' });
  assert.equal(result.body.status, 'FAILED');
  assert.ok(Date.now() - startedAt < 100);
});


test('status 将 outbox 中间态映射为 SENDING 并仅执行数据库 nudge', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  let nudged;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_processing' },
    {
      async getIngestBatchStatus() { return { found: true, status: 'PROCESSING', operation_id: 'op_1', attempt: 2 }; },
      async nudgeDispatchOutbox(value) { nudged = value; return true; },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'SENDING');
  assert.equal(result.body.operation_id, 'op_1');
  await Promise.all(result.deferred);
  assert.deepEqual(nudged, { chatId: 'oc_test', batchId: 'batch_processing' });
});

test('status 已读到状态后 nudge 超时仍返回结果', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_retry' },
    {
      async getIngestBatchStatus() { return { found: true, status: 'RETRY', error_code: 'LARK_TIMEOUT' }; },
      async nudgeDispatchOutbox() { throw Object.assign(new Error('slow db'), { code: 'DISPATCH_DB_TIMEOUT' }); },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'SENDING');
  assert.equal(result.body.error_code, 'LARK_TIMEOUT');
});

test('status 保持有效的同步 SENDING 租约且不误触 outbox', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_active_sending' },
    {
      async getIngestBatchStatus() {
        return {
          found: true, status: 'SENDING', retryable: false,
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async nudgeDispatchOutbox() { throw new Error('must not nudge synchronous SENDING'); },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'SENDING');
  assert.equal(result.body.retryable, false);
  assert.equal(result.deferred.length, 0);
});

test('status 将过期的同步 SENDING 映射为可安全补偿的 FAILED', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_expired_sending' },
    {
      async getIngestBatchStatus() {
        return {
          found: true, status: 'SENDING', retryable: true,
          lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
          request_ids: ['r1'],
        };
      },
      async nudgeDispatchOutbox() { throw new Error('must not nudge synchronous SENDING'); },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'FAILED');
  assert.equal(result.body.retryable, true);
  assert.equal(result.body.error_code, 'INGEST_LEASE_EXPIRED');
  assert.deepEqual(result.body.request_ids, ['r1']);
  assert.equal(result.deferred.length, 0);
});


test('status 将 DEAD 映射为旧契约 FAILED 并保留 dead-letter 原因', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_dead' },
    {
      async getIngestBatchStatus() {
        return { found: true, status: 'DEAD', error_code: 'LARK_REJECTED', attempt: 8 };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'FAILED');
  assert.equal(result.body.dead_letter, true);
  assert.equal(result.body.terminal_reason, 'LARK_REJECTED');
  assert.equal(result.body.error_code, 'LARK_REJECTED');
  assert.equal(result.deferred.length, 0);
});

test('低流量中断任务由重复 status 后台恢复且只发送一次', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const row = {
    status: 'PROCESSING', workerToken: 'abandoned-worker',
    operationId: 'bess-outbox-low-traffic', attempt: 1,
  };
  let sends = 0;
  let releaseSend;
  const store = {
    async getIngestBatchStatus() {
      return {
        found: true, status: row.status, operation_id: row.operationId,
        message_id: row.messageId || '', attempt: row.attempt,
      };
    },
    async nudgeDispatchOutbox() {
      if (row.status !== 'PROCESSING') return false;
      row.status = 'RETRY'; row.workerToken = null;
      return true;
    },
    async claimDispatchOutboxBatch({ chatId, batchId, workerToken }) {
      assert.equal(chatId, 'oc_test');
      assert.equal(batchId, 'batch_low');
      if (!['QUEUED', 'RETRY'].includes(row.status)) return [];
      row.status = 'PROCESSING'; row.workerToken = workerToken; row.attempt += 1;
      return [{
        form_message_id: 'bi_low', chat_id: 'oc_test', batch_id: 'batch_low',
        operation_id: row.operationId, request_ids: ['r1'], card: { schema: '2.0' }, attempt: row.attempt,
      }];
    },
    async completeDispatchOutbox({ workerToken, messageId }) {
      assert.equal(workerToken, row.workerToken);
      row.status = 'SENT'; row.messageId = messageId;
      return { completed: true };
    },
    async retryDispatchOutbox() { throw new Error('must not retry'); },
  };
  const client = {
    async sendMessage({ uuid }) {
      sends += 1;
      assert.equal(uuid, row.operationId);
      await new Promise((resolve) => { releaseSend = resolve; });
      return { message_id: 'om_low_once' };
    },
  };
  const runWorker = (targetStore, target) => runDispatchOutbox({ store: targetStore, client, target });

  const [first, second] = await Promise.all([
    invoke({ chat_id: 'oc_test', batch_id: 'batch_low' }, store, { runWorker }),
    invoke({ chat_id: 'oc_test', batch_id: 'batch_low' }, store, { runWorker }),
  ]);
  assert.equal(first.body.status, 'SENDING');
  assert.equal(second.body.status, 'SENDING');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(row.status, 'PROCESSING');
  releaseSend();
  await Promise.all([...first.deferred, ...second.deferred]);
  assert.equal(sends, 1);

  const final = await invoke({ chat_id: 'oc_test', batch_id: 'batch_low' }, store, { runWorker });
  assert.equal(final.body.status, 'SENT');
  assert.equal(final.body.message_id, 'om_low_once');
  assert.equal(final.deferred.length, 0);
});


test('status 将持久化的全量过滤终态返回为 skipped 且不暴露伪 message_id', async () => {
  const response = await invoke(
    { chat_id: 'oc_a', batch_id: 'batch_skipped' },
    {
      async getIngestBatchStatus() {
        return {
          found: true,
          status: 'SENT',
          message_id: 'skipped:bess-outbox-abc',
          request_ids: ['760104'],
          retryable: false,
        };
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'SENT');
  assert.equal(response.body.skipped, true);
  assert.deepEqual(response.body.skipped_request_ids, ['760104']);
  assert.equal(Object.hasOwn(response.body, 'message_id'), false);
});
