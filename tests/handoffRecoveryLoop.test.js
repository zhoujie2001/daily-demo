import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { runHandoffReconciliation } from '../lib/dispatch/api/handoff-reconcile.js';
import { createHandoffRecoveryHandler } from '../lib/dispatch/api/handoff-recovery.js';
import { classifyDispatchHandoff } from '../lib/dispatch/handoff-recovery.js';

const payload = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', batch_id: 'recovery-b1', time_segment: 'A',
  items: [{
    request_id: 'recovery-r1', request_name: 'recovery', business_type: '千川', target_category: 'qianchuan',
    sheet_url: 'https://example.com', sheet_id: 's1', row_index: 1,
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

function context(overrides = {}) {
  const card = { schema: '2.0' };
  return {
    kind: 'dispatch_ingest', status: 'ACCEPTED_UNKNOWN', batchId: 'b1', operationId: 'op1',
    fingerprint: 'fp1', requestIds: ['r1'], card,
    queueMessage: {
      schema_version: 1, kind: 'dispatch', chat_id: 'oc_1', batch_id: 'b1', fingerprint: 'fp1',
      request_ids: ['r1'], operation_id: 'op1', card,
    },
    registeredAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return { found: true, chatId: 'oc_1', context: context(overrides) };
}

test('恢复分类严格区分已确认、可安全重试和需对账', () => {
  const ambiguous = classifyDispatchHandoff(handoff({ publishClaimedAt: '2026-10-21T10:01:00Z' }), {
    status: 'ACCEPTED_UNKNOWN', operation_id: 'op1',
  });
  assert.equal(ambiguous.classification, 'NEEDS_RECONCILIATION');
  assert.equal(ambiguous.publish_allowed, false);
  assert.equal(ambiguous.evidence.operation_id, 'op1');

  const rejected = classifyDispatchHandoff(handoff({ authoritativeNonAcceptance: true }), {
    status: 'ACCEPTED_UNKNOWN', operation_id: 'op1',
  });
  assert.equal(rejected.classification, 'SAFE_TO_RETRY');
  assert.equal(rejected.publish_allowed, true);

  const confirmed = classifyDispatchHandoff(handoff({ status: 'SENT', confirmedAt: '2026-10-21T10:02:00Z' }), {
    status: 'SENT', operation_id: 'op1',
  });
  assert.equal(confirmed.classification, 'CONFIRMED');
  assert.equal(confirmed.evidence.confirmed_at, '2026-10-21T10:02:00Z');
});

test('自动 reconciler 绝不重投已越过 publish 边界的 UNKNOWN', async () => {
  let publishes = 0;
  let claims = 0;
  const item = handoff({ publishClaimedAt: '2026-10-21T10:01:00Z', publishWorkerToken: 'old-worker' });
  const result = await runHandoffReconciliation({
    store: {
      async listHandoffsToReconcile() { return [item]; },
      async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
      async claimDispatchHandoffPublish() { claims += 1; return { claimed: true }; },
    },
    publishDispatch: async () => { publishes += 1; },
  });
  assert.equal(result.results[0].recovery, 'NEEDS_RECONCILIATION');
  assert.equal(result.results[0].republished, false);
  assert.equal(claims, 0);
  assert.equal(publishes, 0);
});

test('只读恢复探测不 claim、不 publish、不更新状态', async () => {
  let writes = 0;
  const store = {
    async getDispatchHandoff() { return handoff({ publishClaimedAt: '2026-10-21T10:01:00Z' }); },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() { writes += 1; },
  };
  const { result, res } = response();
  await createHandoffRecoveryHandler({ secret: 'cron', storeFactory: () => store })(
    { method: 'GET', headers: { authorization: 'Bearer cron' }, query: { chat_id: 'oc_1', batch_id: 'b1' } }, res,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.classification, 'NEEDS_RECONCILIATION');
  assert.equal(result.body.operation_id, 'op1');
  assert.equal(writes, 0);
});

test('受控恢复仅凭同 operation_id 和权威未接收证据重投一次', async () => {
  let publishes = 0;
  let confirms = 0;
  const item = handoff({ authoritativeNonAcceptance: true, queueRejectionError: 'QUEUE_REJECTED' });
  const store = {
    async getDispatchHandoff() { return item; },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() { return { claimed: true, workerToken: 'worker-1', queueMessage: item.context.queueMessage }; },
    async confirmDispatchHandoff(value) { assert.equal(value.workerToken, 'worker-1'); confirms += 1; },
    async markDispatchHandoffUnknown() { assert.fail('successful recovery must not become unknown'); },
  };
  const { result, res } = response();
  await createHandoffRecoveryHandler({
    secret: 'cron', storeFactory: () => store,
    publishDispatch: async (message) => { assert.equal(message.operation_id, 'op1'); publishes += 1; },
  })({
    method: 'POST', headers: { authorization: 'Bearer cron' }, query: {},
    body: { chat_id: 'oc_1', batch_id: 'b1', operation_id: 'op1', recovery_action: 'retry_if_safe' },
  }, res);
  assert.equal(result.status, 202);
  assert.equal(result.body.classification, 'CONFIRMED');
  assert.equal(publishes, 1);
  assert.equal(confirms, 1);
});

test('受控恢复拒绝 UNKNOWN 盲重投和 operation_id 不匹配', async () => {
  let claims = 0;
  const store = {
    async getDispatchHandoff() { return handoff({ publishClaimedAt: '2026-10-21T10:01:00Z' }); },
    async getIngestBatchStatus() { return { found: true, status: 'ACCEPTED_UNKNOWN', operation_id: 'op1' }; },
    async claimDispatchHandoffPublish() { claims += 1; },
  };
  const handler = createHandoffRecoveryHandler({ secret: 'cron', storeFactory: () => store });
  for (const operationId of ['op1', 'wrong']) {
    const { result, res } = response();
    await handler({
      method: 'POST', headers: { authorization: 'Bearer cron' }, query: {},
      body: { chat_id: 'oc_1', batch_id: 'b1', operation_id: operationId, recovery_action: 'retry_if_safe' },
    }, res);
    assert.equal(result.status, 409);
    assert.equal(result.body.error_code, operationId === 'op1'
      ? 'HANDOFF_RECONCILIATION_REQUIRED' : 'OPERATION_ID_MISMATCH');
  }
  assert.equal(claims, 0);
});

test('dry-run 在验证后不创建 store、不持久化、不入队', async () => {
  let stores = 0;
  let publishes = 0;
  const handler = createAutomationSendHandler({
    secret: 'automation',
    storeFactory: () => { stores += 1; throw new Error('store must not be created'); },
    publishDispatch: async () => { publishes += 1; },
  });
  const { result, res } = response();
  await handler({ method: 'POST', headers: {}, body: {
    automation_token: 'automation', dispatch_payload: payload, dry_run: true,
  } }, res);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'DRY_RUN_OK');
  assert.equal(stores, 0);
  assert.equal(publishes, 0);
});
