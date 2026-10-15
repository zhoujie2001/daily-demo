import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import dispatchActionHandler from '../api/dispatch/[action].js';
import { createDispatchRecoveryHandler } from '../api/cron/bess-dispatch-cleanup.js';
import { createHandoffReconcileHandler } from '../lib/dispatch/api/handoff-reconcile.js';
import { createBasePullHandler } from '../lib/dispatch/api/pull-base.js';
import { createWritebackRetryHandler } from '../lib/dispatch/api/writeback-retry.js';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';

function response() {
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return res; },
    json(value) { result.body = value; return res; },
  };
  return { result, res };
}

function cronRequest(secret = '') {
  return { method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : {} };
}

test('cron 动作复用 dispatch 动态函数且部署函数数不超过 Hobby 限额', async () => {
  for (const action of ['pull-base', 'handoff-reconcile', 'writeback-retry']) {
    const { result, res } = response();
    await dispatchActionHandler({ ...cronRequest(), query: { action } }, res);
    assert.equal(result.status, 401, `${action} 必须继续 fail-closed`);
  }

  const apiFiles = (await readdir(new URL('../api', import.meta.url), { recursive: true }))
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.js'));
  const ignored = (await readFile(new URL('../.vercelignore', import.meta.url), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('api/') && line.endsWith('.js'))
    .map((line) => line.slice('api/'.length));
  const deployedFunctions = apiFiles.filter((file) => !ignored.includes(file));

  assert.equal(apiFiles.includes('cron/bess-pull-base.js'), false);
  assert.equal(apiFiles.includes('cron/bess-handoff-reconcile.js'), false);
  assert.equal(apiFiles.includes('cron/bess-writeback-retry.js'), false);
  assert.ok(deployedFunctions.length <= 12, `Vercel functions=${deployedFunctions.length}, expected <= 12`);

  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const recoveryCrons = vercel.crons.filter((entry) => entry.path === '/api/cron/bess-dispatch-cleanup');
  assert.deepEqual(recoveryCrons, [{ path: '/api/cron/bess-dispatch-cleanup', schedule: '10 16 * * *' }]);
  assert.equal(vercel.crons.some((entry) => entry.path.includes('pull-base')), false, 'Base pull 不得自动调度');
});

test('每日聚合恢复 cron 真实执行 pull、handoff、outbox、writeback 且阶段互不遮蔽', async () => {
  const calls = [];
  const handler = createDispatchRecoveryHandler({
    secret: 'cron', storeFactory: () => ({ id: 'shared-store' }),
    cleanup: async (store) => { calls.push(['cleanup', store.id]); return { ok: true }; },
    recoverBasePull: async (store) => { calls.push(['basePull', store.id]); throw Object.assign(new Error('bad config'), { code: 'BASE_PULL_CONFIG' }); },
    recoverHandoffs: async (store) => { calls.push(['handoffs', store.id]); return { ok: true }; },
    recoverOutbox: async (store) => { calls.push(['outbox', store.id]); throw Object.assign(new Error('down'), { code: 'OUTBOX_DOWN' }); },
    recoverWritebacks: async (store) => { calls.push(['writebacks', store.id]); return { ok: true }; },
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 207);
  assert.deepEqual(calls.map(([name]) => name), ['cleanup', 'basePull', 'handoffs', 'outbox', 'writebacks']);
  assert.equal(result.body.recovery.basePull.error_code, 'BASE_PULL_CONFIG');
  assert.equal(result.body.recovery.outbox.error_code, 'OUTBOX_DOWN');
  assert.equal(result.body.recovery.writebacks.ok, true);
});

test('Base pull 强制 GET 与 CRON_SECRET，缺 secret 时 fail-closed', async () => {
  const handler = createBasePullHandler({ secret: '', enabled: false });
  const method = response();
  await handler({ method: 'POST', headers: {} }, method.res);
  assert.equal(method.result.status, 405);
  const unauthorized = response();
  await handler(cronRequest(), unauthorized.res);
  assert.equal(unauthorized.result.status, 401);
});

test('启用 Base pull 会构建完整卡片并发布队列，重放不重复 publish', async () => {
  const dispatchPayload = {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'pull-b1', time_segment: 'A',
    items: [{
      request_id: 'pull-r1', request_name: 'pull', business_type: '千川', target_category: 'qianchuan',
      sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  };
  let registrations = 0;
  let publishes = 0;
  let confirmed = 0;
  let confirmedValue;
  const patched = [];
  const store = {
    async registerDispatchHandoff() {
      registrations += 1;
      return registrations === 1
        ? { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING', operation_id: 'op1' }
        : { outcome: 'REUSED', status: 'QUEUED', operation_id: 'op1' };
    },
    async confirmDispatchHandoff(value) {
      confirmed += 1;
      confirmedValue = value;
      return { updated: true };
    },
  };
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table', storeFactory: () => store,
    client: { async request(method, path, options) {
      if (method === 'PATCH') { patched.push({ path, options }); return {}; }
      return { data: { items: [{ record_id: 'rec1', fields: { Status: 'PENDING', dispatch_payload: dispatchPayload } }] } };
    } },
    publishDispatch: async (message) => {
      publishes += 1;
      assert.ok(message.card);
      assert.equal(message.kind, 'dispatch');
      assert.match(message.operation_id, /^bess-outbox-/);
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const invocation = response();
    await handler(cronRequest('cron'), invocation.res);
    assert.equal(invocation.result.status, 200);
  }
  assert.equal(publishes, 1);
  assert.equal(confirmed, 1);
  assert.equal(confirmedValue.chatId, dispatchPayload.chat_id);
  assert.equal(confirmedValue.batchId, dispatchPayload.batch_id);
  assert.match(confirmedValue.operationId, /^bess-outbox-/);
  assert.ok(confirmedValue.now instanceof Date);
  assert.equal(patched.length, 2);
  assert.equal(patched[0].options.body.fields.Status, 'INGESTED');
  assert.equal(patched[0].options.body.fields.DispatchOperationID, confirmedValue.operationId);
});

test('Base pull 遍历分页快照并回写后续页，避免第一页饥饿', async () => {
  const payload = (id) => ({
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: `batch-${id}`, time_segment: 'A',
    items: [{
      request_id: `request-${id}`, request_name: id, business_type: '千川', target_category: 'qianchuan',
      sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  });
  const requestedTokens = [];
  const patched = [];
  const client = {
    async request(method, path, options) {
      if (method === 'PATCH') { patched.push(path); return {}; }
      requestedTokens.push(options.query.page_token || null);
      return options.query.page_token
        ? { data: { items: [{ record_id: 'rec2', fields: { Status: 'PENDING', dispatch_payload: payload('2') } }], has_more: false } }
        : { data: { items: [{ record_id: 'rec1', fields: { Status: 'PENDING', dispatch_payload: payload('1') } }], has_more: true, page_token: 'page-2' } };
    },
  };
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table', client,
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'REUSED', status: 'QUEUED' }; },
    }),
    publishDispatch: async () => assert.fail('queued handoff must not republish'),
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.deepEqual(requestedTokens, [null, 'page-2']);
  assert.equal(result.body.pages, 2);
  assert.equal(result.body.truncated, false);
  assert.equal(patched.length, 2);
});

test('Base pull publish 成功但 Base 回写失败时进入 pendingWritebacks', async () => {
  const dispatchPayload = {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'writeback-b1', time_segment: 'A',
    items: [{
      request_id: 'writeback-r1', request_name: 'writeback', business_type: '千川', target_category: 'qianchuan',
      sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  };
  let pending;
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table',
    client: { async request(method) {
      if (method === 'PATCH') throw Object.assign(new Error('down'), { code: 'BASE_DOWN' });
      return { data: { items: [{ record_id: 'rec1', fields: { Status: 'PENDING', dispatch_payload: dispatchPayload } }] } };
    } },
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
      async confirmDispatchHandoff() { return { updated: true }; },
      async recordWritebackFailure(value) { pending = value; },
    }),
    publishDispatch: async () => {},
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].writebackPending, true);
  assert.equal(pending.chatId, dispatchPayload.chat_id);
  assert.equal(pending.batchId, 'writeback-b1');
  assert.equal(pending.recordId, 'rec1');
  assert.equal(pending.errorCode, 'BASE_DOWN');
});

test('同步 queue rejection 先持久化权威 non-acceptance 和完整卡片', async () => {
  let rejected;
  const store = {
    async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
    async markDispatchHandoffRejected(value) { rejected = value; },
  };
  const handler = createAutomationSendHandler({
    secret: 'automation', storeFactory: () => store,
    publishDispatch: async () => { throw Object.assign(new Error('rejected'), { code: 'QUEUE_REJECTED' }); },
  });
  const { result, res } = response();
  await handler({
    method: 'POST', headers: {},
    body: {
      automation_token: 'automation',
      dispatch_payload: {
        chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'b1', time_segment: 'A',
        items: [{
          request_id: 'r1', request_name: 'test', business_type: '千川', target_category: 'qianchuan',
          sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
        }],
      },
    },
  }, res);
  assert.equal(result.status, 503);
  assert.equal(rejected.errorCode, 'QUEUE_REJECTED');
  assert.ok(rejected.card);
  assert.match(rejected.operationId, /^bess-outbox-/);
  assert.match(rejected.fingerprint, /^[a-f0-9]{64}$/);
});

test('automation DEAD 重放返回终态失败且不重新 publish', async () => {
  let publishes = 0;
  const handler = createAutomationSendHandler({
    secret: 'automation',
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'REUSED', status: 'DEAD', operation_id: 'op-dead' }; },
    }),
    publishDispatch: async () => { publishes += 1; },
  });
  const { result, res } = response();
  await handler({
    method: 'POST', headers: {},
    body: {
      automation_token: 'automation',
      dispatch_payload: {
        chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'dead-b1', time_segment: 'A',
        items: [{
          request_id: 'dead-r1', request_name: 'dead', business_type: '千川', target_category: 'qianchuan',
          sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
        }],
      },
    },
  }, res);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'FAILED');
  assert.equal(result.body.dead_letter, true);
  assert.equal(result.body.ok, false);
  assert.equal(publishes, 0);
});

test('handoff reconcile 缺 CRON_SECRET 时 fail-closed', async () => {
  const { result, res } = response();
  await createHandoffReconcileHandler({ secret: '', storeFactory: () => assert.fail('must not create store') })(cronRequest(), res);
  assert.equal(result.status, 401);
});

test('ACCEPTED_UNKNOWN 使用持久化的同 operation 消息有界重放', async () => {
  const published = [];
  let claimed;
  const context = {
    batchId: 'b1', operationId: 'op1', fingerprint: 'fp1', status: 'ACCEPTED_UNKNOWN',
    reconcileAttempt: 2, card: { schema: '2.0' },
    queueMessage: {
      schema_version: 1, kind: 'dispatch', chat_id: 'oc_1', batch_id: 'b1',
      fingerprint: 'fp1', request_ids: ['r1'], operation_id: 'op1', card: { schema: '2.0' },
    },
  };
  const store = {
    async listHandoffsToReconcile() { return [{ chatId: 'oc_1', context }]; },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish(value) {
      claimed = value;
      return { claimed: true, workerToken: 'lease-1', queueMessage: context.queueMessage };
    },
    async confirmDispatchHandoff() { return { updated: true }; },
  };
  const { result, res } = response();
  await createHandoffReconcileHandler({
    secret: 'cron', storeFactory: () => store, publishDispatch: async (message) => published.push(message),
  })(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0], context.queueMessage);
  assert.equal(published[0].operation_id, 'op1');
  assert.equal(claimed.operationId, 'op1');
  assert.equal(claimed.maxReconcileAttempts, 6);
});

test('ACCEPTED_UNKNOWN 超过有界次数进入可追踪 reconciliation dead-letter', async () => {
  let dead;
  const context = {
    batchId: 'b1', operationId: 'op1', fingerprint: 'fp1', status: 'ACCEPTED_UNKNOWN',
    reconcileAttempt: 6, card: { schema: '2.0' }, queueMessage: { operation_id: 'op1' },
  };
  const store = {
    async listHandoffsToReconcile() { return [{ chatId: 'oc_1', context }]; },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async markDispatchHandoffReconciliationDead(value) { dead = value; },
    async claimDispatchHandoffPublish() { assert.fail('exhausted UNKNOWN must not publish'); },
  };
  const { result, res } = response();
  await createHandoffReconcileHandler({ secret: 'cron', storeFactory: () => store })(cronRequest('cron'), res);
  assert.equal(result.body.results[0].status, 'RECONCILIATION_DEAD');
  assert.equal(result.body.results[0].dead_letter, true);
  assert.equal(dead.operationId, 'op1');
  assert.equal(dead.errorCode, 'HANDOFF_RECONCILE_ATTEMPTS_EXHAUSTED');
});

test('只有同 operation/fingerprint 的权威 non-acceptance 才安全重投', async () => {
  const messages = [];
  let confirmed = 0;
  const context = {
    batchId: 'b1', operationId: 'op1', fingerprint: 'fp1', requestIds: ['r1'],
    status: 'ACCEPTED_UNKNOWN', authoritativeNonAcceptance: true, card: { schema: '2.0' },
    queueMessage: {
      schema_version: 1, kind: 'dispatch', chat_id: 'oc_1', batch_id: 'b1', fingerprint: 'fp1',
      request_ids: ['r1'], operation_id: 'op1', card: { schema: '2.0' },
    },
  };
  const store = {
    async listHandoffsToReconcile() { return [{ chatId: 'oc_1', context }]; },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() {
      return { claimed: true, workerToken: 'publisher-1', queueMessage: context.queueMessage };
    },
    async confirmDispatchHandoff(value) {
      assert.equal(value.workerToken, 'publisher-1');
      confirmed += 1;
    },
  };
  const { result, res } = response();
  await createHandoffReconcileHandler({
    secret: 'cron', storeFactory: () => store, publishDispatch: async (message) => { messages.push(message); },
  })(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].operation_id, 'op1');
  assert.equal(messages[0].fingerprint, 'fp1');
  assert.equal(confirmed, 1);
});

test('writeback retry 鉴权、claim 后成功删除 pendingWritebacks', async () => {
  let completed;
  const store = {
    async claimPendingWritebacks({ workerToken }) {
      assert.ok(workerToken);
      return [{ formMessageId: 'bi_1', recordId: 'rec1', operationId: 'op1', attempt: 0 }];
    },
    async completeWriteback(value) { completed = value; return { completed: true }; },
  };
  const client = { async request() { return {}; } };
  const handler = createWritebackRetryHandler({
    secret: 'cron', appToken: 'app', tableId: 'table', storeFactory: () => store, client,
  });
  const unauthorized = response();
  await handler(cronRequest('wrong'), unauthorized.res);
  assert.equal(unauthorized.result.status, 401);

  const authorized = response();
  await handler(cronRequest('cron'), authorized.res);
  assert.equal(authorized.result.status, 200);
  assert.equal(completed.formMessageId, 'bi_1');
  assert.equal(completed.recordId, 'rec1');
  assert.ok(completed.workerToken);
});

test('writeback retry 失败只由持有 lease 的 worker 条件更新', async () => {
  let failure;
  const current = new Date('2026-10-15T09:00:00.000Z');
  const store = {
    async claimPendingWritebacks() {
      return [{ formMessageId: 'bi_1', recordId: 'rec1', operationId: 'op1', attempt: 2 }];
    },
    async completeWriteback() { assert.fail('failed writeback must not be removed'); },
    async failClaimedWriteback(value) { failure = value; return { updated: true }; },
  };
  const handler = createWritebackRetryHandler({
    secret: 'cron', appToken: 'app', tableId: 'table', storeFactory: () => store,
    client: { async request() { throw Object.assign(new Error('down'), { code: 'BASE_DOWN' }); } },
    now: () => current,
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(failure.errorCode, 'BASE_DOWN');
  assert.ok(failure.workerToken);
  assert.ok(failure.nextRetryAt > current);
});

test('writeback 达最大次数或永久错误进入 dead-letter，不再无限重试', async () => {
  for (const scenario of [
    { attempt: 7, error: Object.assign(new Error('temporary'), { code: 'BASE_DOWN' }) },
    { attempt: 0, error: Object.assign(new Error('gone'), { code: 'LARK_API_404', httpStatus: 404 }) },
  ]) {
    let failure;
    const handler = createWritebackRetryHandler({
      secret: 'cron', appToken: 'app', tableId: 'table', maxAttempts: 8,
      storeFactory: () => ({
        async claimPendingWritebacks(options) {
          assert.equal(options.maxAttempts, 8);
          return [{ formMessageId: 'bi_1', recordId: 'rec1', operationId: 'op1', attempt: scenario.attempt }];
        },
        async failClaimedWriteback(value) { failure = value; return { updated: true }; },
      }),
      client: { async request() { throw scenario.error; } },
    });
    const { result, res } = response();
    await handler(cronRequest('cron'), res);
    assert.equal(failure.dead, true);
    assert.equal(result.body.results[0].dead_letter, true);
  }
});

test('writeback 失败 worker 丢失 lease 后不得复活已完成项', async () => {
  let legacyFailureCalled = false;
  const handler = createWritebackRetryHandler({
    secret: 'cron', appToken: 'app', tableId: 'table',
    storeFactory: () => ({
      async claimPendingWritebacks() {
        return [{ formMessageId: 'bi_1', recordId: 'rec1', operationId: 'op1', attempt: 0 }];
      },
      async failClaimedWriteback() { return { updated: false, ownershipLost: true }; },
      async recordWritebackFailure() { legacyFailureCalled = true; },
    }),
    client: { async request() { throw new Error('late failure'); } },
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].ownership_lost, true);
  assert.equal(legacyFailureCalled, false);
});

test('writeback complete 并发已删除时按幂等完成处理', async () => {
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'key', logger: {},
    fetchImpl: async () => ({ ok: true, headers: { get() { return ''; } }, text: async () => '[{"updated":false}]' }),
  });
  const result = await store.completeWriteback({ formMessageId: 'bi_1', recordId: 'rec1', workerToken: 'worker-1' });
  assert.equal(result.completed, true);
  assert.equal(result.reused, true);
});

test('status 将 HANDOFF_PENDING/ACCEPTED_UNKNOWN 视为 found 且 ok', async () => {
  const secret = 'status-secret';
  process.env.BESS_DISPATCH_INGEST_SECRET = secret;
  for (const persistedStatus of ['HANDOFF_PENDING', 'ACCEPTED_UNKNOWN']) {
    const body = { chat_id: 'oc_1', batch_id: `b_${persistedStatus}` };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
    const { result, res } = response();
    await createDispatchStatusHandler({
      storeFactory: () => ({
        async getIngestBatchStatus() { return { found: true, status: persistedStatus, operation_id: 'op1' }; },
        async nudgeDispatchOutbox() { return false; },
      }),
      defer() {},
      statusCache: { async get() { return null; }, async set() {} },
    })({
      method: 'POST', body,
      headers: { 'x-bess-timestamp': String(timestamp), 'x-bess-signature': `sha256=${signature}` },
    }, res);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.found, true);
    assert.equal(result.body.status, 'SENDING');
  }
});

test('迁移会 materialize handoff、校验 operation 并安全解析 JSON 时间', async () => {
  const [outbox, p0, p1, vercelText] = await Promise.all([
    readFile(new URL('../db/migrations/20260915_dispatch_outbox.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20261015_handoff_p0.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20261015_handoff_p1.sql', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
  ]);
  assert.equal(
    createHash('sha256').update(outbox).digest('hex'),
    'e94113a64117d0ed08fc82e07e7bd7815cedb8577c06fa969dbdc55e34a3aca4',
    '已执行的 20260915 历史迁移必须与 origin/main 原文保持一致',
  );
  assert.match(p0, /create or replace function public\.bess_enqueue_dispatch_outbox\(/i);
  assert.match(p0, /status' IN \('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN', 'RECONCILIATION_DEAD'\)[\s\S]*?SET request_context = v_context/i);
  assert.match(p0, /operationId'\) IS DISTINCT FROM p_operation_id/i);
  assert.match(p0, /create or replace function public\.bess_claim_dispatch_outbox\([\s\S]*?bess_safe_timestamptz\(pending\.request_context ->> 'nextRetryAt'\)/i);
  assert.match(p0, /create or replace function public\.bess_nudge_dispatch_outbox\([\s\S]*?bess_safe_timestamptz\(pending\.request_context ->> 'leaseExpiresAt'\)/i);
  assert.doesNotMatch(p0, /registeredAt'\)::timestamptz/i);
  assert.match(p0, /status' IN \('QUEUED', 'PROCESSING', 'SENT'\)/i);
  assert.match(p0, /'card', p_card,[\s\S]*?'queueMessage', p_queue_message/i);
  assert.match(p0, /status' = 'ACCEPTED_UNKNOWN'[\s\S]*?nextReconcileAt'[\s\S]*?reconcileAttempt'/i);
  assert.match(p0, /bess_claim_dispatch_handoff_publish\([\s\S]*?'publishWorkerToken', p_worker_token[\s\S]*?'reconcileAttempt'/i);
  assert.match(p0, /bess_confirm_dispatch_handoff\([\s\S]*?publishWorkerToken' = p_worker_token/i);
  assert.match(p0, /bess_mark_dispatch_handoff_unknown\([\s\S]*?publishWorkerToken' = p_worker_token/i);
  assert.match(p1, /bess_mark_dispatch_handoff_rejected\([\s\S]*?publishWorkerToken' = p_worker_token/i);
  for (const name of [
    'bess_register_dispatch_handoff',
    'bess_mark_dispatch_handoff_unknown',
    'bess_confirm_dispatch_handoff',
    'bess_enqueue_dispatch_outbox',
    'bess_claim_dispatch_outbox',
    'bess_nudge_dispatch_outbox',
  ]) {
    assert.match(p0, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`, 'i'));
  }
  for (const name of [
    'bess_list_handoffs_to_reconcile',
    'bess_dead_letter_dispatch_handoff',
    'bess_mark_dispatch_handoff_rejected',
    'bess_record_writeback_failure',
    'bess_claim_pending_writebacks',
    'bess_fail_claimed_writeback',
    'bess_complete_writeback',
  ]) {
    assert.match(p1, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}[\\s\\S]*?FROM public, anon, authenticated, service_role`, 'i'));
  }
  assert.match(p1, /bess_safe_timestamptz\((?:v_)?entry\.value ->> 'nextRetryAt'\)/i);
  assert.match(p1, /bess_claim_pending_writebacks\([\s\S]*?p_max_attempts[\s\S]*?attempt[\s\S]*?< p_max_attempts/i);
  assert.match(p1, /bess_fail_claimed_writeback\([\s\S]*?p_dead boolean[\s\S]*?'DEAD'/i);
  assert.match(p1, /bess_dead_letter_dispatch_handoff\([\s\S]*?'RECONCILIATION_DEAD'/i);
  const vercel = JSON.parse(vercelText);
  assert.equal(vercel.functions['api/dispatch/[action].js'].maxDuration, 60);
  for (const name of ['bess-pull-base', 'bess-handoff-reconcile', 'bess-writeback-retry']) {
    assert.equal(vercel.functions[`api/cron/${name}.js`], undefined);
    assert.equal(vercel.crons.some((entry) => entry.path === `/api/cron/${name}`), false);
  }
});


test('automation publish 成功但 confirm 失败只标记 ACCEPTED_UNKNOWN，不写权威拒绝', async () => {
  let unknown;
  let rejected = 0;
  const handler = createAutomationSendHandler({
    secret: 'automation',
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
      async confirmDispatchHandoff() { throw Object.assign(new Error('db down'), { code: 'DB_DOWN' }); },
      async markDispatchHandoffUnknown(value) { unknown = value; },
      async markDispatchHandoffRejected() { rejected += 1; },
    }),
    publishDispatch: async () => ({ message_id: 'queue-accepted' }),
  });
  const { result, res } = response();
  await handler({
    method: 'POST', headers: {},
    body: {
      automation_token: 'automation',
      dispatch_payload: {
        chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'confirm-unknown-b1', time_segment: 'A',
        items: [{
          request_id: 'confirm-unknown-r1', request_name: 'confirm unknown', business_type: '千川',
          target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
        }],
      },
    },
  }, res);
  assert.equal(result.status, 202);
  assert.equal(result.body.accepted_unknown, true);
  assert.equal(result.body.status, 'QUEUING');
  assert.equal(unknown.batchId, 'confirm-unknown-b1');
  assert.equal(rejected, 0);
});

test('Base pull publish 成功但 confirm 失败只标 unknown，且不回写 INGESTED', async () => {
  const dispatchPayload = {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'base-confirm-unknown-b1', time_segment: 'A',
    items: [{
      request_id: 'base-confirm-unknown-r1', request_name: 'base confirm unknown', business_type: '千川',
      target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  };
  let patched = 0;
  let unknown;
  let rejected = 0;
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table',
    client: { async request(method) {
      if (method === 'PATCH') { patched += 1; return {}; }
      return { data: { items: [{ record_id: 'rec-confirm-unknown', fields: { Status: 'PENDING', dispatch_payload: dispatchPayload } }] } };
    } },
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
      async confirmDispatchHandoff() { throw Object.assign(new Error('db down'), { code: 'DB_DOWN' }); },
      async markDispatchHandoffUnknown(value) { unknown = value; },
      async markDispatchHandoffRejected() { rejected += 1; },
    }),
    publishDispatch: async () => ({ message_id: 'queue-accepted' }),
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].acceptedUnknown, true);
  assert.equal(result.body.results[0].status, 'ACCEPTED_UNKNOWN');
  assert.equal(unknown.batchId, dispatchPayload.batch_id);
  assert.equal(patched, 0);
  assert.equal(rejected, 0);
});


test('Base pull 已有 ACCEPTED_UNKNOWN 不得提前回写 INGESTED', async () => {
  const dispatchPayload = {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'base-reused-unknown', time_segment: 'A',
    items: [{
      request_id: 'base-reused-r1', request_name: 'unknown', business_type: '千川',
      target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  };
  let patched = 0;
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table',
    client: { async request(method) {
      if (method === 'PATCH') { patched += 1; return {}; }
      return { data: { items: [{ record_id: 'rec-reused-unknown', fields: { Status: 'PENDING', dispatch_payload: dispatchPayload } }] } };
    } },
    storeFactory: () => ({
      async registerDispatchHandoff() {
        return { outcome: 'REUSED', status: 'ACCEPTED_UNKNOWN', operation_id: 'same-op' };
      },
    }),
    publishDispatch: async () => assert.fail('unknown reuse must await reconciler'),
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.body.results[0].status, 'ACCEPTED_UNKNOWN');
  assert.equal(result.body.results[0].acceptedUnknown, true);
  assert.equal(patched, 0);
});


test('Base pull publish 超时保持 ACCEPTED_UNKNOWN，不写权威拒绝', async () => {
  const dispatchPayload = {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'base-timeout-b1', time_segment: 'A',
    items: [{
      request_id: 'base-timeout-r1', request_name: 'base timeout', business_type: '千川',
      target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
    }],
  };
  let unknown = 0;
  let rejected = 0;
  let patched = 0;
  const handler = createBasePullHandler({
    secret: 'cron', enabled: true, appToken: 'app', tableId: 'table',
    client: { async request(method) {
      if (method === 'PATCH') { patched += 1; return {}; }
      return { data: { items: [{ record_id: 'rec-timeout', fields: { Status: 'PENDING', dispatch_payload: dispatchPayload } }] } };
    } },
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
      async markDispatchHandoffUnknown() { unknown += 1; },
      async markDispatchHandoffRejected() { rejected += 1; },
    }),
    publishDispatch: async () => {
      throw Object.assign(new Error('timeout'), { code: 'DISPATCH_QUEUE_TIMEOUT' });
    },
  });
  const { result, res } = response();
  await handler(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].acceptedUnknown, true);
  assert.equal(result.body.results[0].error, 'DISPATCH_QUEUE_TIMEOUT');
  assert.equal(unknown, 1);
  assert.equal(rejected, 0);
  assert.equal(patched, 0);
});


test('注册后崩溃的 HANDOFF_PENDING 在重试时通过 publish claim 恢复', async () => {
  let published = 0;
  let claimed = 0;
  const handler = createAutomationSendHandler({
    secret: 'automation',
    storeFactory: () => ({
      async registerDispatchHandoff() { return { outcome: 'REUSED', status: 'HANDOFF_PENDING', operation_id: 'op1' }; },
      async claimDispatchHandoffPublish() { claimed += 1; return { claimed: true, status: 'HANDOFF_PENDING' }; },
      async confirmDispatchHandoff() { return { updated: true }; },
    }),
    publishDispatch: async () => { published += 1; return { message_id: 'q1' }; },
  });
  const { result, res } = response();
  await handler({ method: 'POST', headers: {}, body: {
    automation_token: 'automation',
    dispatch_payload: {
      chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'crash-b1', time_segment: 'A',
      items: [{ request_id: 'crash-r1', request_name: 'recover', business_type: '千川', target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1 }],
    },
  } }, res);
  assert.equal(result.status, 202);
  assert.equal(claimed, 1);
  assert.equal(published, 1);
});

test('并发 HANDOFF_PENDING 重试只有 publish claim 获得者发布', async () => {
  let leaseHeld = false;
  let published = 0;
  const store = {
    async registerDispatchHandoff() { return { outcome: 'REUSED', status: 'HANDOFF_PENDING', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() {
      if (leaseHeld) return { claimed: false, status: 'HANDOFF_PENDING' };
      leaseHeld = true;
      return { claimed: true, status: 'HANDOFF_PENDING' };
    },
    async confirmDispatchHandoff() { return { updated: true }; },
  };
  const handler = createAutomationSendHandler({
    secret: 'automation', storeFactory: () => store,
    publishDispatch: async () => { published += 1; return { message_id: 'q1' }; },
  });
  const request = () => ({ method: 'POST', headers: {}, body: {
    automation_token: 'automation',
    dispatch_payload: {
      chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'concurrent-b1', time_segment: 'A',
      items: [{ request_id: 'concurrent-r1', request_name: 'once', business_type: '千川', target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1 }],
    },
  } });
  const first = response();
  const second = response();
  await Promise.all([handler(request(), first.res), handler(request(), second.res)]);
  assert.equal(published, 1);
  assert.deepEqual([first.result.status, second.result.status].sort(), [202, 202]);
});

test('reconciler 通过过期 publish lease claim 恢复未发布 handoff', async () => {
  let published = 0;
  let confirmed = 0;
  const context = {
    batchId: 'lease-b1', operationId: 'op1', fingerprint: 'fp1', requestIds: ['r1'],
    status: 'HANDOFF_PENDING', card: { schema: '2.0' },
    queueMessage: {
      schema_version: 1, kind: 'dispatch', chat_id: 'oc_1', batch_id: 'lease-b1', fingerprint: 'fp1',
      request_ids: ['r1'], operation_id: 'op1', card: { schema: '2.0' },
    },
    publishLeaseExpiresAt: '2026-01-01T00:00:00.000Z',
  };
  const store = {
    async listHandoffsToReconcile() { return [{ chatId: 'oc_1', context }]; },
    async getIngestBatchStatus() { return { found: true, status: 'HANDOFF_PENDING', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() {
      return { claimed: true, status: 'HANDOFF_PENDING', workerToken: 'publisher-lease', queueMessage: context.queueMessage };
    },
    async confirmDispatchHandoff(value) {
      assert.equal(value.workerToken, 'publisher-lease');
      confirmed += 1;
      return { updated: true };
    },
  };
  const { result, res } = response();
  await createHandoffReconcileHandler({
    secret: 'cron', storeFactory: () => store,
    now: () => new Date('2026-01-01T00:10:00.000Z'),
    publishDispatch: async () => { published += 1; },
  })(cronRequest('cron'), res);
  assert.equal(result.status, 200);
  assert.equal(published, 1);
  assert.equal(confirmed, 1);
  assert.equal(result.body.results[0].republished, true);
});


test('register 在 publish claim 前已原子携带 reconciler 所需完整消息', async () => {
  let registered;
  const handler = createAutomationSendHandler({
    secret: 'automation',
    storeFactory: () => ({
      async registerDispatchHandoff(value) {
        registered = value;
        return { outcome: 'REUSED', status: 'QUEUED', operation_id: value.operationId };
      },
    }),
    publishDispatch: async () => assert.fail('reused queued handoff must not publish'),
  });
  const { result, res } = response();
  await handler({ method: 'POST', headers: {}, body: {
    automation_token: 'automation',
    dispatch_payload: {
      chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'durable-register-b1', time_segment: 'A',
      items: [{
        request_id: 'durable-register-r1', request_name: 'durable', business_type: '千川',
        target_category: 'qianchuan', sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
      }],
    },
  } }, res);
  assert.equal(result.status, 202);
  assert.ok(registered.card);
  assert.equal(registered.queueMessage.card, registered.card);
  assert.equal(registered.queueMessage.operation_id, registered.operationId);
  assert.deepEqual(registered.queueMessage.request_ids, registered.requestIds);
});

test('两个 reconciler 并发重投 authoritative non-acceptance 时仅 claim 获得者发布', async () => {
  const context = {
    batchId: 'authoritative-race-b1', operationId: 'op-race', fingerprint: 'fp-race',
    requestIds: ['r1'], status: 'ACCEPTED_UNKNOWN', authoritativeNonAcceptance: true,
    card: { schema: '2.0' },
    queueMessage: {
      schema_version: 1, kind: 'dispatch', chat_id: 'oc_1', batch_id: 'authoritative-race-b1',
      fingerprint: 'fp-race', request_ids: ['r1'], operation_id: 'op-race', card: { schema: '2.0' },
    },
  };
  let claimed = false;
  let publishes = 0;
  let confirmedToken;
  const store = {
    async listHandoffsToReconcile() { return [{ chatId: 'oc_1', context }]; },
    async getIngestBatchStatus() {
      return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op-race' };
    },
    async claimDispatchHandoffPublish() {
      if (claimed) return { claimed: false, status: 'ACCEPTED_UNKNOWN' };
      claimed = true;
      return { claimed: true, workerToken: 'winning-worker', queueMessage: context.queueMessage };
    },
    async confirmDispatchHandoff(value) { confirmedToken = value.workerToken; return { updated: true }; },
  };
  const handler = createHandoffReconcileHandler({
    secret: 'cron', storeFactory: () => store,
    publishDispatch: async () => { publishes += 1; },
  });
  const first = response();
  const second = response();
  await Promise.all([
    handler(cronRequest('cron'), first.res),
    handler(cronRequest('cron'), second.res),
  ]);
  assert.equal(publishes, 1);
  assert.equal(confirmedToken, 'winning-worker');
  assert.equal(first.result.status, 200);
  assert.equal(second.result.status, 200);
});

test('publish outcome RPC 拒绝非 lease worker 的状态更新', async () => {
  for (const operation of ['confirm', 'unknown', 'rejected']) {
    const store = createSupabaseDispatchStore({
      url: 'https://example.supabase.co', serviceRoleKey: 'key', logger: {},
      fetchImpl: async () => ({
        ok: true, headers: { get() { return ''; } }, text: async () => '[{"updated":false}]',
      }),
    });
    const call = operation === 'confirm'
      ? store.confirmDispatchHandoff({ chatId: 'c1', batchId: 'b1', operationId: 'op1', workerToken: 'stale' })
      : operation === 'unknown'
        ? store.markDispatchHandoffUnknown({ chatId: 'c1', batchId: 'b1', workerToken: 'stale' })
        : store.markDispatchHandoffRejected({
          chatId: 'c1', batchId: 'b1', operationId: 'op1', fingerprint: 'fp1', card: {},
          errorCode: 'REJECTED', workerToken: 'stale',
        });
    await assert.rejects(call, (error) => ['HANDOFF_STATE_CONFLICT', 'HANDOFF_PUBLISH_CLAIM_LOST'].includes(error.code));
  }
});
