import assert from 'node:assert/strict';
import test from 'node:test';
import {
  basePullEligibility,
  basePullHistoryEligibility,
  createBasePullHandler,
  runBasePull as runBasePullWithIsolation,
} from '../lib/dispatch/api/pull-base.js';

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

for (const count of [30, 31, 32, 40]) {
  test(`旧单卡 Base Pull ${count}条保留原有30条边界，不能继承拆卡入口容量`, async () => {
    let registrations = 0;
    let publishes = 0;
    let writes = 0;
    const batch = {
      ...payload,
      items: Array.from({ length: count }, (_, index) => ({
        ...payload.items[0], request_id: `legacy_capacity_${index}`, row_index: index + 1,
      })),
    };
    const result = await runBasePull({
      enabled: true, appToken: 'app', tableId: 'table',
      client: { async request(method) {
        if (method === 'PUT') { writes += 1; return {}; }
        return { data: { items: [record({ automation_status: 'PENDING', dispatch_payload: batch })] } };
      } },
      storeFactory: () => ({
        async registerDispatchHandoff() {
          registrations += 1;
          return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
        },
        async confirmDispatchHandoff() {},
      }),
      publishDispatch: async () => { publishes += 1; return {}; },
    });
    const item = result.body.results[0];
    if (count === 30) {
      assert.equal(item.status, 'QUEUED');
      assert.equal(registrations, 1);
      assert.equal(publishes, 1);
      assert.equal(writes, 1);
    } else {
      assert.equal(item.error, 'INVALID_BATCH_SIZE');
      assert.match(item.message, /1 至 30/);
      assert.equal(registrations, 0);
      assert.equal(publishes, 0);
      assert.equal(writes, 0);
    }
  });
}

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

test('非 allowlist 仅搜索未受理记录并按 batch_id 倒序分页，再执行本地 eligibility 与历史隔离', async () => {
  const queries = [];
  const bodies = [];
  const eligiblePayload = { ...payload, batch_id: '20261016-new' };
  const oldPayload = { ...payload, batch_id: '20261014-old' };
  const encodedEligiblePayload = Buffer.from(JSON.stringify(eligiblePayload)).toString('base64');
  const payloadSplit = Math.floor(encodedEligiblePayload.length / 2);
  const pages = [
    [
      record({ automation_status: 'FAILED', error_detail: 'BUSINESS_REJECTED' }),
      { ...record({ automation_status: 'PENDING', operation_id: 'op-old' }), record_id: 'rec-op' },
    ],
    [
      { ...record({ automation_status: 'PENDING', dispatch_payload: oldPayload }), record_id: 'rec-old' },
      {
        ...record({
          automation_status: 'PENDING',
          dispatch_payload: [
            { type: 'text', text: encodedEligiblePayload.slice(0, payloadSplit) },
            { type: 'text', text: encodedEligiblePayload.slice(payloadSplit) },
          ],
          dry_run: true,
        }),
        record_id: 'rec-new',
      },
    ],
  ];
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table', minBatchId: '20261015-start', maxPages: 2,
    client: { async request(method, path, options) {
      assert.equal(method, 'POST');
      assert.equal(path, '/open-apis/bitable/v1/apps/app/tables/table/records/search');
      queries.push(options.query);
      bodies.push(options.body);
      const index = queries.length - 1;
      return { data: { items: pages[index], has_more: true, page_token: `next-${index}` } };
    } },
    storeFactory: () => ({}),
  });
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map((query) => query.page_token), [undefined, 'next-0']);
  const expectedBody = {
    filter: {
      conjunction: 'and',
      conditions: [{ field_name: 'operation_id', operator: 'isEmpty', value: [] }],
    },
    sort: [{ field_name: 'batch_id', desc: true }],
  };
  assert.deepEqual(bodies, [expectedBody, expectedBody]);
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
    if (method === 'PUT') { patches.push({ path, options }); return {}; }
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
    if (method === 'PUT') return {};
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
        if (method === 'PUT') { patches += 1; return {}; }
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

const RECOVER_AFTER_MS = new Date('2026-10-15T00:00:00+08:00').getTime();
const INSIDE_WINDOW_MS = new Date('2026-11-22T10:01:22+08:00').getTime();
const BEFORE_WINDOW_MS = new Date('2026-10-01T09:00:00+08:00').getTime();
// Deterministic clock for runBasePull age-guard tests: 30 min after the fixture
// record was created, comfortably inside the 24h auto-recovery window.
const PULL_NOW = () => new Date(INSIDE_WINDOW_MS + 30 * 60 * 1000);

test('历史隔离默认仍走批次名正则：非日期批次被挡，旧行为完全不变', () => {
  for (const batchId of ['bess-a-8460930ac8cf', 'ad-bess-c-4db33746', 'game-bess-a-b823d424']) {
    assert.deepEqual(
      basePullHistoryEligibility({
        recordId: 'rec-x', batchId, minBatchId: '20261015-B',
        recordCreatedTime: INSIDE_WINDOW_MS,
      }),
      { eligible: false, reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' },
    );
  }
  assert.deepEqual(
    basePullHistoryEligibility({ recordId: 'rec-x', batchId: '20261016-new', minBatchId: '20261015-B' }),
    { eligible: true, reason: 'BATCH_WINDOW' },
  );
});

test('statusDriven 开启后按记录创建时间放行非日期批次，窗口与旧批次边界对齐', () => {
  for (const batchId of ['bess-a-8460930ac8cf', 'ad-bess-c-4db33746', 'game-bess-a-b823d424', '20261016-new']) {
    assert.deepEqual(
      basePullHistoryEligibility({
        recordId: 'rec-x', batchId, minBatchId: '20261015-B',
        statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS, recordCreatedTime: INSIDE_WINDOW_MS,
      }),
      { eligible: true, reason: 'RECORD_TIME_WINDOW' },
    );
  }
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-old', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS, recordCreatedTime: BEFORE_WINDOW_MS,
    }),
    { eligible: false, reason: 'RECORD_BEFORE_RECOVER_AFTER' },
  );
});

test('statusDriven 缺少时间证据时 fail-closed 回退批次名规则，绝不放开历史记录', () => {
  // 记录无 created_time
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-8460930ac8cf', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS, recordCreatedTime: null,
    }),
    { eligible: false, reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' },
  );
  // 边界非法（NaN）
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-8460930ac8cf', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: NaN, recordCreatedTime: INSIDE_WINDOW_MS,
    }),
    { eligible: false, reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' },
  );
  // 两者都缺且未配置旧边界
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-8460930ac8cf', minBatchId: '',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS, recordCreatedTime: null,
    }),
    { eligible: false, reason: 'HISTORY_ISOLATION_UNCONFIGURED' },
  );
});

test('allowlist 在 statusDriven 模式下仍是最高优先边界', () => {
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-allow', batchId: 'bess-a-old', minBatchId: '20261015-B',
      recordAllowlist: 'rec-allow',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS, recordCreatedTime: BEFORE_WINDOW_MS,
    }),
    { eligible: true, reason: 'RECORD_ALLOWLIST' },
  );
});

function localBatchRecord(overrides = {}) {
  return {
    record_id: 'rec-local-a',
    created_time: String(INSIDE_WINDOW_MS),
    fields: {
      dispatch_payload: { ...payload, batch_id: 'bess-a-8460930ac8cfb5032e09e93e' },
      automation_status: 'PENDING',
    },
    ...overrides,
  };
}

function recoveryStore() {
  const registrations = [];
  return {
    registrations,
    async registerDispatchHandoff(value) {
      registrations.push(value);
      return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
    },
    async claimDispatchHandoffPublish() { return { claimed: true, workerToken: 'worker' }; },
    async confirmDispatchHandoff() { return { updated: true }; },
  };
}

test('runBasePull 开启 statusDriven 后恢复窗内 bess-a PENDING 记录并回写 Base', async () => {
  let publishes = 0;
  let writes = 0;
  const store = recoveryStore();
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B', now: PULL_NOW,
    statusDriven: true, recoverAfter: '2026-10-15T00:00:00+08:00',
    client: { async request(method) {
      if (method === 'PUT') { writes += 1; return {}; }
      return { data: { items: [localBatchRecord()], has_more: false } };
    } },
    storeFactory: () => store,
    publishDispatch: async () => { publishes += 1; return {}; },
  });
  const item = result.body.results[0];
  assert.equal(item.ok, true);
  assert.equal(item.status, 'QUEUED');
  assert.equal(publishes, 1);
  assert.equal(writes, 1);
  assert.equal(store.registrations[0].sourceRecordId, 'rec-local-a');
  assert.equal(store.registrations[0].batchId, 'bess-a-8460930ac8cfb5032e09e93e');
});

test('runBasePull 未开启 statusDriven 时 bess-a 记录仍被历史隔离跳过且不 publish', async () => {
  let publishes = 0;
  let writes = 0;
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B', now: PULL_NOW,
    statusDriven: false, recoverAfter: '2026-10-15T00:00:00+08:00',
    client: { async request(method) {
      if (method === 'PUT') { writes += 1; return {}; }
      return { data: { items: [localBatchRecord()], has_more: false } };
    } },
    storeFactory: () => recoveryStore(),
    publishDispatch: async () => { publishes += 1; return {}; },
  });
  assert.deepEqual(
    result.body.results.map(({ status, reason }) => ({ status, reason })),
    [{ status: 'HISTORY_SKIPPED', reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' }],
  );
  assert.equal(publishes, 0);
  assert.equal(writes, 0);
});

test('runBasePull 开启 statusDriven 但记录缺 created_time 时 fail-closed 跳过', async () => {
  let publishes = 0;
  const stale = localBatchRecord();
  delete stale.created_time;
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B', now: PULL_NOW,
    statusDriven: true, recoverAfter: '2026-10-15T00:00:00+08:00',
    client: { async request() { return { data: { items: [stale], has_more: false } }; } },
    storeFactory: () => recoveryStore(),
    publishDispatch: async () => { publishes += 1; return {}; },
  });
  assert.equal(result.body.results[0].reason, 'BATCH_OUTSIDE_CONFIGURED_WINDOW');
  assert.equal(publishes, 0);
});

test('runBasePull 非法 recoverAfter 配置自动降级为旧批次名规则，不扩大窗口', async () => {
  let publishes = 0;
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B', now: PULL_NOW,
    statusDriven: true, recoverAfter: 'not-a-date',
    client: { async request() { return { data: { items: [localBatchRecord()], has_more: false } }; } },
    storeFactory: () => recoveryStore(),
    publishDispatch: async () => { publishes += 1; return {}; },
  });
  assert.equal(result.body.results[0].reason, 'BATCH_OUTSIDE_CONFIGURED_WINDOW');
  assert.equal(publishes, 0);
});

test('statusDriven 的自动恢复窗口上限：超过 24h 的历史 PENDING 不再自动重发', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  // 窗口内（30 分钟前创建）放行
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-8460930ac8cf', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS,
      recordCreatedTime: INSIDE_WINDOW_MS,
      maxRecordAgeMs: dayMs, nowMs: INSIDE_WINDOW_MS + 30 * 60 * 1000,
    }),
    { eligible: true, reason: 'RECORD_TIME_WINDOW' },
  );
  // 恰好等于窗口上限仍放行
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-x', batchId: 'bess-a-8460930ac8cf', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS,
      recordCreatedTime: INSIDE_WINDOW_MS,
      maxRecordAgeMs: dayMs, nowMs: INSIDE_WINDOW_MS + dayMs,
    }),
    { eligible: true, reason: 'RECORD_TIME_WINDOW' },
  );
  // 10/15-10/21 那类长期积压历史记录必须被挡在自动恢复之外
  const backlogMs = new Date('2026-10-20T18:45:35+08:00').getTime();
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-old', batchId: 'game-bess-b-1f431047d35cc10393ca9864', minBatchId: '20261015-B',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS,
      recordCreatedTime: backlogMs,
      maxRecordAgeMs: dayMs, nowMs: INSIDE_WINDOW_MS + 30 * 60 * 1000,
    }),
    { eligible: false, reason: 'RECORD_TOO_OLD_FOR_AUTO_RECOVERY' },
  );
  // allowlist 仍可人工精确指定，不受年龄上限限制
  assert.deepEqual(
    basePullHistoryEligibility({
      recordId: 'rec-old', batchId: 'game-bess-b-1f431047d35cc10393ca9864', minBatchId: '20261015-B',
      recordAllowlist: 'rec-old',
      statusDriven: true, recoverAfterMs: RECOVER_AFTER_MS,
      recordCreatedTime: backlogMs,
      maxRecordAgeMs: dayMs, nowMs: INSIDE_WINDOW_MS + 30 * 60 * 1000,
    }),
    { eligible: true, reason: 'RECORD_ALLOWLIST' },
  );
});

test('runBasePull 对超龄 PENDING 记录跳过且不 publish、不回写', async () => {
  let publishes = 0;
  let writes = 0;
  const stale = localBatchRecord({
    created_time: String(new Date('2026-10-20T18:45:35+08:00').getTime()),
  });
  const result = await runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B',
    now: PULL_NOW,
    statusDriven: true, recoverAfter: '2026-10-15T00:00:00+08:00',
    client: { async request(method) {
      if (method === 'PUT') { writes += 1; return {}; }
      return { data: { items: [stale], has_more: false } };
    } },
    storeFactory: () => recoveryStore(),
    publishDispatch: async () => { publishes += 1; return {}; },
  });
  assert.deepEqual(
    result.body.results.map(({ status, reason }) => ({ status, reason })),
    [{ status: 'HISTORY_SKIPPED', reason: 'RECORD_TOO_OLD_FOR_AUTO_RECOVERY' }],
  );
  assert.equal(publishes, 0);
  assert.equal(writes, 0);
});

test('runBasePull 年龄上限可通过参数覆盖，非法值自动降级为默认安全上限', async () => {
  const stale = localBatchRecord({
    created_time: String(new Date('2026-10-20T18:45:35+08:00').getTime()),
  });
  const run = (maxRecordAgeHours) => runBasePullWithIsolation({
    enabled: true, appToken: 'app', tableId: 'table',
    minBatchId: '20261015-B',
    now: PULL_NOW,
    maxRecordAgeHours,
    statusDriven: true, recoverAfter: '2026-10-15T00:00:00+08:00',
    client: { async request() { return { data: { items: [stale], has_more: false } }; } },
    storeFactory: () => recoveryStore(),
    publishDispatch: async () => ({}),
  });
  // 放宽到 60 天：同一记录恢复放行
  const wide = await run(24 * 60);
  assert.equal(wide.body.results[0].status, 'QUEUED');
  // 非法值（0 / NaN 语义）回落到默认 24h，不会变成无上限
  const invalid = await run('not-a-number');
  assert.equal(invalid.body.results[0].reason, 'RECORD_TOO_OLD_FOR_AUTO_RECOVERY');
});
