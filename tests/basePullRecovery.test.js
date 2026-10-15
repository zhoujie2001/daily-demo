import assert from 'node:assert/strict';
import test from 'node:test';
import { basePullEligibility, createBasePullHandler, runBasePull as runBasePullWithIsolation } from '../lib/dispatch/api/pull-base.js';

const runBasePull = (options) => runBasePullWithIsolation({ enforceHistoryIsolation: false, ...options });

const payload = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1',
  batch_id: 'stable-base-batch',
  time_segment: 'A',
  items: [{
    request_id: 'stable-base-request', request_name: 'recovery', business_type: '千川',
    target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
  }],
};

function response() {
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return res; },
    json(value) { result.body = value; return res; },
  };
  return { result, res };
}

function request(secret = 'cron') {
  return { method: 'GET', headers: { authorization: `Bearer ${secret}` } };
}

function record(fields = {}) {
  return { record_id: 'rec-recovery', fields: { dispatch_payload: payload, ...fields } };
}

test('Base pull 默认关闭且完全不创建 store 或访问 Base', async () => {
  let touched = false;
  const result = await runBasePull({
    enabled: false,
    storeFactory: () => { touched = true; },
    client: { async request() { touched = true; } },
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.message, 'disabled');
  assert.equal(touched, false);
});

test('Base pull 启用后缺失 Base/Lark 配置时返回明确字段且不创建 store', async () => {
  let storeCreated = false;
  const { result, res } = response();
  await createBasePullHandler({
    secret: 'cron', enabled: true, appToken: '', tableId: '', appId: '', appSecret: '',
    storeFactory: () => { storeCreated = true; },
  })(request(), res);
  assert.equal(result.status, 500);
  assert.equal(result.body.error_code, 'BASE_PULL_CONFIGURATION_MISSING');
  assert.deepEqual(result.body.missing_configuration, [
    'BESS_BASE_APP_TOKEN', 'BESS_BASE_TABLE_ID', 'LARK_APP_ID', 'LARK_APP_SECRET',
  ]);
  assert.equal(storeCreated, false);
});

test('FAILED 只有可证明无 HTTP 回执且所有回执字段为空才 eligible', () => {
  for (const errorDetail of [
    'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY',
    'AUTO_RETRY_REARM_AFTER_HTTP_NO_RESPONSE',
  ]) {
    assert.deepEqual(basePullEligibility(record({
      automation_status: 'FAILED', error_detail: errorDetail, operation_id: '', http_status: '', items_accepted: '',
    })), { eligible: true, status: 'FAILED', recoveryReason: errorDetail });
  }
  assert.equal(basePullEligibility(record({ automation_status: 'FAILED', error_detail: 'BUSINESS_REJECTED' })).eligible, false);
  assert.equal(basePullEligibility(record({
    automation_status: 'FAILED', error_detail: 'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY', http_status: 500,
  })).eligible, false);
  assert.equal(basePullEligibility(record({
    automation_status: 'FAILED', error_detail: 'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY', items_accepted: 0,
  })).eligible, false);
  assert.equal(basePullEligibility(record({
    automation_status: 'FAILED', error_detail: 'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY', operation_id: 'existing-op',
  })).eligible, false);
  assert.equal(basePullEligibility(record({ automation_status: 'PENDING', operation_id: 'existing-op' })).eligible, false);
  assert.deepEqual(basePullEligibility(record({ automation_status: 'PENDING', message_id: 'existing-message' })), {
    eligible: false, reason: 'EXISTING_MESSAGE',
  });
});

test('allowlist 仅逐条精确 GET，不调用列表接口或携带 filter', async () => {
  const calls = [];
  const ids = ['rec-one', 'rec/two'];
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table', recordAllowlist: ids.join(','),
    client: { async request(method, path, options) {
      calls.push({ method, path, options });
      const id = decodeURIComponent(path.split('/').at(-1));
      return { data: { record: { ...record({ automation_status: 'PENDING', dry_run: true }), record_id: id } } };
    } },
    storeFactory: () => ({}),
  });
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'GET']);
  assert.deepEqual(calls.map(({ path }) => path), [
    '/open-apis/bitable/v1/apps/app/tables/table/records/rec-one',
    '/open-apis/bitable/v1/apps/app/tables/table/records/rec%2Ftwo',
  ]);
  assert.equal(calls.every(({ options }) => options.query === undefined), true);
  assert.deepEqual(result.body.results.map(({ recordId }) => recordId), ids);
  assert.equal(result.body.results.every(({ status }) => status === 'DRY_RUN_OK'), true);
});

test('非 allowlist 使用无 filter 有界分页并在本地执行 eligibility 与 history isolation', async () => {
  const queries = [];
  const eligiblePayload = { ...payload, batch_id: '20261016-new' };
  const oldPayload = { ...payload, batch_id: '20261014-old' };
  const pages = [
    [
      record({ automation_status: 'FAILED', error_detail: 'BUSINESS_REJECTED' }),
      { ...record({ automation_status: 'PENDING', operation_id: 'op-old' }), record_id: 'rec-op' },
    ],
    [
      { ...record({ automation_status: 'PENDING', dispatch_payload: oldPayload }), record_id: 'rec-old' },
      { ...record({ automation_status: 'PENDING', dispatch_payload: eligiblePayload, dry_run: true }), record_id: 'rec-new' },
    ],
  ];
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table', minBatchId: '20261015-start', maxPages: 2,
    client: { async request(method, path, options) {
      assert.equal(method, 'GET');
      assert.equal(path, '/open-apis/bitable/v1/apps/app/tables/table/records');
      queries.push(options.query);
      const index = queries.length - 1;
      return { data: { items: pages[index], has_more: true, page_token: `next-${index}` } };
    } },
    storeFactory: () => ({}),
  });
  assert.equal(queries.length, 2);
  assert.equal(queries.every((query) => !Object.hasOwn(query, 'filter')), true);
  assert.deepEqual(queries.map((query) => query.page_token), [undefined, 'next-0']);
  assert.equal(result.body.pages, 2);
  assert.equal(result.body.truncated, true);
  assert.deepEqual(result.body.results.map(({ reason, status }) => reason || status), [
    'FAILED_NOT_PROVEN_NO_HTTP_RECEIPT',
    'EXISTING_OPERATION',
    'BATCH_OUTSIDE_CONFIGURED_WINDOW',
    'DRY_RUN_OK',
  ]);
});

test('FAILED timeout 恢复复用原 chat/batch/record 与确定 operation，同批重放不新建 batch', async () => {
  const registrations = [];
  const patches = [];
  let publishes = 0;
  const store = {
    async registerDispatchHandoff(value) {
      registrations.push(value);
      return registrations.length === 1
        ? { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }
        : { outcome: 'REUSED', status: 'QUEUED' };
    },
    async confirmDispatchHandoff() { return { updated: true }; },
  };
  const client = { async request(method, path, options) {
    if (method === 'PATCH') { patches.push({ path, options }); return {}; }
    return { data: { items: [record({
      automation_status: 'FAILED', error_detail: 'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY',
      operation_id: '', http_status: '', items_accepted: '',
    })] } };
  } };
  const options = {
    enabled: true, appToken: 'app', tableId: 'table', client, storeFactory: () => store,
    publishDispatch: async () => { publishes += 1; },
  };
  await runBasePull(options);
  await runBasePull(options);
  assert.equal(publishes, 1);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].chatId, payload.chat_id);
  assert.equal(registrations[0].batchId, payload.batch_id);
  assert.equal(registrations[0].sourceRecordId, 'rec-recovery');
  assert.equal(registrations[0].operationId, registrations[1].operationId);
  assert.equal(registrations[0].source, 'pull:rec-recovery');
  assert.equal(patches.length, 2);
});

test('同一 Base record 并发仅 publish claim 获得者处理', async () => {
  let claimed = false;
  let publishes = 0;
  const store = {
    async registerDispatchHandoff() {
      return { outcome: 'REUSED', status: 'HANDOFF_PENDING' };
    },
    async claimDispatchHandoffPublish() {
      if (claimed) return { claimed: false };
      claimed = true;
      return { claimed: true, workerToken: 'winner' };
    },
    async confirmDispatchHandoff() { return { updated: true }; },
  };
  const client = { async request(method) {
    if (method === 'PATCH') return {};
    return { data: { items: [record({ automation_status: 'PENDING' })] } };
  } };
  const options = {
    enabled: true, appToken: 'app', tableId: 'table', client, storeFactory: () => store,
    publishDispatch: async () => { publishes += 1; },
  };
  await Promise.all([runBasePull(options), runBasePull(options)]);
  assert.equal(publishes, 1);
});

test('UNKNOWN handoff 不回写 Base；只有 QUEUED/SENT 可写 INGESTED', async () => {
  for (const status of ['ACCEPTED_UNKNOWN', 'PROCESSING', 'RETRY']) {
    let patches = 0;
    const result = await runBasePull({
      enabled: true, appToken: 'app', tableId: 'table',
      client: { async request(method) {
        if (method === 'PATCH') { patches += 1; return {}; }
        return { data: { items: [record({ automation_status: 'PENDING' })] } };
      } },
      storeFactory: () => ({
        async registerDispatchHandoff() { return { outcome: 'REUSED', status }; },
      }),
    });
    assert.equal(patches, 0);
    assert.equal(result.body.results[0].ok, false);
  }
});
