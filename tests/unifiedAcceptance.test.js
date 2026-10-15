import assert from 'node:assert/strict';
import test from 'node:test';
import { runDurableDispatchHandoff } from '../lib/dispatch/durable-handoff.js';
import { decodeDispatchPayload } from '../lib/dispatch/payload.js';
import { runBasePull } from '../lib/dispatch/api/pull-base.js';

const dispatchPayload = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1',
  batch_id: '20261016-A',
  time_segment: 'A',
  items: [{
    request_id: 'unified-1', request_name: 'unified', business_type: '千川',
    target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
  }],
};

function baseRecord(fields = {}) {
  return {
    record_id: 'rec-unified',
    fields: { automation_status: 'PENDING', dispatch_payload: dispatchPayload, ...fields },
  };
}

function acceptedStore(overrides = {}) {
  return {
    async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
    async confirmDispatchHandoff() { return { updated: true }; },
    async markDispatchHandoffUnknown() { return { updated: true }; },
    async markDispatchHandoffRejected() { return { updated: true }; },
    ...overrides,
  };
}

function pullOptions({ record = baseRecord(), store = acceptedStore(), client: suppliedClient, ...options } = {}) {
  const patches = [];
  const client = suppliedClient || {
    async request(method, path, requestOptions) {
      if (method === 'PATCH') {
        patches.push({ path, options: requestOptions });
        return {};
      }
      return { data: { items: [record] } };
    },
  };
  return {
    patches,
    options: {
      enabled: true, enforceHistoryIsolation: false, appToken: 'app', tableId: 'table', client, store,
      publishDispatch: async () => ({ message_id: 'queue-1' }),
      ...options,
    },
  };
}

test('共享 payload decoder 兼容 object、明文 JSON、Base64 JSON，并对非法输入 fail-closed', () => {
  assert.deepEqual(decodeDispatchPayload(dispatchPayload), dispatchPayload);
  assert.deepEqual(decodeDispatchPayload(JSON.stringify(dispatchPayload)), dispatchPayload);
  assert.deepEqual(decodeDispatchPayload(Buffer.from(JSON.stringify(dispatchPayload)).toString('base64')), dispatchPayload);
  assert.throws(() => decodeDispatchPayload('not-json-or-base64'), { code: 'INVALID_DISPATCH_PAYLOAD' });
  assert.throws(() => decodeDispatchPayload('W10='), { code: 'INVALID_DISPATCH_PAYLOAD' });
});

test('Base64 Pull 绑定 source_record_id 并回写生产字段', async () => {
  let registration;
  const store = acceptedStore({
    async registerDispatchHandoff(value) {
      registration = value;
      return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
    },
  });
  const record = baseRecord({
    dispatch_payload: Buffer.from(JSON.stringify(dispatchPayload)).toString('base64'),
  });
  const fixture = pullOptions({ record, store });
  const result = await runBasePull(fixture.options);

  assert.equal(result.body.results[0].status, 'QUEUED');
  assert.equal(registration.sourceRecordId, 'rec-unified');
  assert.equal(registration.queueMessage.source_record_id, 'rec-unified');
  assert.deepEqual(fixture.patches[0].options.body.fields, {
    automation_status: 'QUEUED',
    operation_id: registration.operationId,
    http_status: 202,
    items_accepted: 1,
    error_detail: '',
  });
});

test('Pull 读取真实 dry_run 字段且绝不 register、publish 或回写', async () => {
  let registerCount = 0;
  let publishCount = 0;
  const fixture = pullOptions({
    record: baseRecord({ dry_run: true }),
    store: acceptedStore({ async registerDispatchHandoff() { registerCount += 1; } }),
    publishDispatch: async () => { publishCount += 1; },
  });
  const result = await runBasePull(fixture.options);
  assert.equal(result.body.results[0].status, 'DRY_RUN_OK');
  assert.equal(registerCount, 0);
  assert.equal(publishCount, 0);
  assert.equal(fixture.patches.length, 0);
});

test('生产历史隔离默认空窗口 fail-closed，边界与白名单可显式放行', async () => {
  let registrations = 0;
  const store = acceptedStore({
    async registerDispatchHandoff() {
      registrations += 1;
      return { outcome: 'REUSED', status: 'QUEUED' };
    },
  });
  const blocked = pullOptions({ store, enforceHistoryIsolation: true });
  const blockedResult = await runBasePull(blocked.options);
  assert.equal(blockedResult.body.results[0].reason, 'HISTORY_ISOLATION_UNCONFIGURED');
  assert.equal(registrations, 0);

  const windowed = pullOptions({ store, enforceHistoryIsolation: true, minBatchId: '20261016-A' });
  await runBasePull(windowed.options);
  const allowlisted = pullOptions({
    record: baseRecord({ dispatch_payload: { ...dispatchPayload, batch_id: 'legacy-batch' } }),
    store, enforceHistoryIsolation: true, recordAllowlist: 'rec-unified',
  });
  await runBasePull(allowlisted.options);
  assert.equal(registrations, 2);
});

test('并发 REUSED handoff 仅 claim 获得者 publish 一次', async () => {
  let claimed = false;
  let publishes = 0;
  const store = acceptedStore({
    async registerDispatchHandoff() { return { outcome: 'REUSED', status: 'HANDOFF_PENDING' }; },
    async claimDispatchHandoffPublish() {
      if (claimed) return { claimed: false };
      claimed = true;
      return { claimed: true, workerToken: 'winner' };
    },
  });
  const registration = {
    chatId: 'chat', batchId: 'batch', operationId: 'operation', fingerprint: 'fingerprint',
    requestIds: ['request'], card: {}, queueMessage: { operation_id: 'operation' },
  };
  await Promise.all([1, 2].map(() => runDurableDispatchHandoff({
    store, registration,
    publishDispatch: async () => { publishes += 1; return { message_id: 'queue' }; },
  })));
  assert.equal(publishes, 1);
});

test('Queue 已接受但账本暂未出现时保持 UNKNOWN，后续请求不盲目重发', async () => {
  let status = 'HANDOFF_PENDING';
  let publishes = 0;
  let resolvePublish;
  const publishPromise = new Promise((resolve) => { resolvePublish = resolve; });
  const store = acceptedStore({
    async registerDispatchHandoff() {
      return status === 'HANDOFF_PENDING'
        ? { outcome: 'ACCEPTED', status }
        : { outcome: 'REUSED', status };
    },
    async markDispatchHandoffUnknown() { status = 'ACCEPTED_UNKNOWN'; return { updated: true }; },
  });
  const registration = {
    chatId: 'chat', batchId: 'batch', operationId: 'operation', fingerprint: 'fingerprint',
    requestIds: ['request'], card: {}, queueMessage: { operation_id: 'operation' },
  };
  const first = await runDurableDispatchHandoff({
    store, registration, publishTimeoutMs: 5, defer: () => {},
    publishDispatch: () => { publishes += 1; return publishPromise; },
  });
  const second = await runDurableDispatchHandoff({
    store, registration,
    publishDispatch: async () => { publishes += 1; },
  });
  assert.equal(first.kind, 'UNKNOWN');
  assert.equal(second.kind, 'REUSED');
  assert.equal(publishes, 1);
  resolvePublish({ message_id: 'accepted-before-timeout' });
});
