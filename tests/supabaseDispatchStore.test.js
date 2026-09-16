import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseDispatchStore, DispatchStoreError } from '../lib/dispatch/supabase-store.js';
import { runDispatchOutbox } from '../lib/dispatch/outbox-worker.js';

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() { return payload === null ? '' : JSON.stringify(payload); },
  };
}

function setup(payloads) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(payloads.shift());
  };
  return {
    calls,
    store: createSupabaseDispatchStore({
      url: 'https://example.supabase.co/',
      serviceRoleKey: 'service-key',
      fetchImpl,
      logger: {},
    }),
  };
}

test('getAssignment 按 day_key 和 request_id 查询已有派单', async () => {
  const assignment = { day_key: '2026-08-30', request_id: 'request 1', assignee: '张三' };
  const { store, calls } = setup([[assignment]]);

  assert.deepEqual(await store.getAssignment('2026-08-30', 'request 1'), assignment);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.match(calls[0].url, /bess_dispatch_assignments\?day_key=eq\.2026-08-30/);
  assert.match(calls[0].url, /request_id=eq\.request%201/);
});

test('calibrateCursor 通过事务 RPC 按负责人原子校准双向游标', async () => {
  const state = { forward_cursor: 2, reverse_cursor: 2 };
  const { store, calls } = setup([[state]]);

  assert.deepEqual(await store.calibrateCursor({
    dayKey: '2026-08-30', assignee: '周杰', roster: ['张三', '周杰', '罗世坤'],
  }), state);

  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /rpc\/bess_calibrate_cursor$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_day_key: '2026-08-30', p_assignee: '周杰', p_roster: ['张三', '周杰', '罗世坤'],
  });
});

test('calibrateCursor 拒绝非法负责人或名单且不发起请求', async () => {
  const { store, calls } = setup([]);

  await assert.rejects(
    store.calibrateCursor({ dayKey: '2026-08-30', assignee: '', roster: ['周杰'] }),
    (error) => error instanceof DispatchStoreError && error.code === 'INVALID_CURSOR_CALIBRATION',
  );
  await assert.rejects(
    store.calibrateCursor({ dayKey: '2026-08-30', assignee: '周杰', roster: [] }),
    (error) => error instanceof DispatchStoreError && error.code === 'INVALID_CURSOR_CALIBRATION',
  );
  assert.equal(calls.length, 0);
});


test('claimBatch 复用 pending_forms 唯一键原子插入，不依赖新表或 RPC', async () => {
  const context = {
    kind: 'batch_dispatch', batchId: 'batch_1', fingerprint: 'a'.repeat(64), items: [{ requestId: 'r1' }],
    status: 'PROCESSING', results: [], claimToken: 'claim_1', leaseExpiresAt: '2026-08-30T11:05:00.000Z',
    cardUpdateDone: false, cardUpdateError: null, threadReplyDone: false, threadReplyError: null,
    resultMessageId: '',
  };
  const inserted = {
    form_message_id: 'synthetic', request_id: 'synthetic', original_message_id: 'om_1',
    request_context: context,
  };
  const { store, calls } = setup([[inserted]]);
  const result = await store.claimBatch({
    chatId: 'oc_1', batchId: 'batch_1', fingerprint: context.fingerprint, items: context.items,
    originalMessageId: 'om_1', claimToken: 'claim_1', now: new Date('2026-08-30T11:00:00Z'),
    leaseExpiresAt: context.leaseExpiresAt, expiresAt: '2026-09-06T11:00:00.000Z',
  });
  assert.equal(result.outcome, 'CLAIMED');
  assert.match(calls[0].url, /bess_dispatch_pending_forms\?on_conflict=form_message_id$/);
  assert.equal(calls[0].options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.form_message_id, /^bb_[a-f0-9]{48}$/);
  assert.match(body.request_id, /^batch_[a-f0-9]{48}$/);
  assert.deepEqual(body.request_context, context);
});

test('过期租约通过旧 claim token 条件 PATCH 原子接管', async () => {
  const oldContext = {
    kind: 'batch_dispatch', batchId: 'batch_2', fingerprint: 'b'.repeat(64), items: [],
    status: 'PROCESSING', results: [], claimToken: 'old_claim', leaseExpiresAt: '2026-08-30T10:59:00.000Z',
    cardUpdateDone: false, threadReplyDone: false,
  };
  const oldRow = { original_message_id: 'om_2', request_context: oldContext };
  const resumedRow = {
    ...oldRow,
    request_context: { ...oldContext, claimToken: 'new_claim', leaseExpiresAt: '2026-08-30T11:05:00.000Z' },
  };
  const { store, calls } = setup([[], [oldRow], [resumedRow]]);
  const result = await store.claimBatch({
    chatId: 'oc_2', batchId: 'batch_2', fingerprint: oldContext.fingerprint, items: [],
    originalMessageId: 'om_2', claimToken: 'new_claim', now: new Date('2026-08-30T11:00:00Z'),
    leaseExpiresAt: '2026-08-30T11:05:00.000Z', expiresAt: '2026-09-06T11:00:00.000Z',
  });
  assert.equal(result.outcome, 'RESUMED');
  assert.equal(calls[2].options.method, 'PATCH');
  assert.match(calls[2].url, /request_context-%3E%3EclaimToken=eq\.old_claim/);
  assert.match(calls[2].url, /request_context-%3E%3EleaseExpiresAt=eq\.2026-08-30T10%3A59%3A00\.000Z/);
});

test('批次进度和 finalization 状态写入 pending request_context 并校验 claim token', async () => {
  const baseContext = {
    kind: 'batch_dispatch', batchId: 'batch_3', fingerprint: 'c'.repeat(64), items: [],
    status: 'PROCESSING', results: [], claimToken: 'claim_3', leaseExpiresAt: '2026-08-30T11:05:00.000Z',
    cardUpdateDone: false, cardUpdateError: null, threadReplyDone: false, threadReplyError: null,
  };
  const baseRow = { original_message_id: 'om_3', request_context: baseContext };
  const progressContext = {
    ...baseContext, status: 'PARTIAL', results: [{ requestId: 'r1', status: 'FAILED' }],
  };
  const progressRow = { ...baseRow, request_context: progressContext };
  const cardContext = { ...progressContext, cardUpdateDone: true, cardUpdateError: null };
  const { store, calls } = setup([[baseRow], [progressRow], [progressRow], [{ ...baseRow, request_context: cardContext }]]);

  await store.saveBatchProgress({
    chatId: 'oc_3', batchId: 'batch_3', claimToken: 'claim_3', status: 'PARTIAL',
    results: progressContext.results, leaseExpiresAt: baseContext.leaseExpiresAt,
  });
  await store.markBatchFinalization({
    chatId: 'oc_3', batchId: 'batch_3', claimToken: 'claim_3', effect: 'card', succeeded: true,
  });

  assert.equal(calls[1].options.method, 'PATCH');
  assert.match(calls[1].url, /request_context-%3E%3EclaimToken=eq\.claim_3/);
  assert.deepEqual(JSON.parse(calls[1].options.body).request_context.results, progressContext.results);
  assert.equal(JSON.parse(calls[3].options.body).request_context.cardUpdateDone, true);
  assert.equal(JSON.parse(calls[3].options.body).completed_at, null);
});


test('calibrateCursor 在新 RPC 未部署时使用现有 daily_state CAS 兼容校准', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/rpc/bess_calibrate_cursor')) {
      return response({ code: 'PGRST202', message: 'Could not find bess_calibrate_cursor' }, { ok: false, status: 404 });
    }
    if (options.method === 'GET') {
      return response([{ day_key: '2026-08-30', roster: ['张三', '周杰', '罗世坤'], forward_cursor: 0, reverse_cursor: 0 }]);
    }
    return response([{ day_key: '2026-08-30', roster: ['张三', '周杰', '罗世坤'], forward_cursor: 2, reverse_cursor: 2 }]);
  };
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl,
  });

  const state = await store.calibrateCursor({
    dayKey: '2026-08-30', assignee: '周杰', roster: ['张三', '周杰', '罗世坤'],
  });

  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /bess_dispatch_daily_state\?day_key=eq\.2026-08-30/);
  assert.equal(calls[2].options.method, 'PATCH');
  assert.match(calls[2].url, /forward_cursor=eq\.0/);
  assert.match(calls[2].url, /reverse_cursor=eq\.0/);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    forward_cursor: 2, reverse_cursor: 2, updated_at: JSON.parse(calls[2].options.body).updated_at,
  });
  assert.equal(state.forward_cursor, 2);
});

test('calibrateCursor 兼容 CAS 遇到并发游标变化时 fail-closed', async () => {
  const payloads = [
    response({ code: 'PGRST202', message: 'missing bess_calibrate_cursor' }, { ok: false, status: 404 }),
    response([{ roster: ['张三', '周杰'], forward_cursor: 0, reverse_cursor: 0 }]),
    response([]),
  ];
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl: async () => payloads.shift(),
  });

  await assert.rejects(
    store.calibrateCursor({ dayKey: '2026-08-30', assignee: '周杰', roster: ['张三', '周杰'] }),
    (error) => error instanceof DispatchStoreError && error.code === 'CURSOR_CALIBRATION_CONFLICT',
  );
});


test('claimIngestBatch 通过单次 RPC 原子持久化 SENDING', async () => {
  const rpcLease = '2026-08-30T11:02:00+00:00';
  const { store, calls } = setup([[{ outcome: 'CLAIMED', lease_expires_at: rpcLease, message_id: '' }]]);
  const result = await store.claimIngestBatch({
    chatId: 'oc_ingest', batchId: 'ingest_1', fingerprint: 'd'.repeat(64), requestIds: ['r1'],
    now: new Date('2026-08-30T11:00:30.000Z'), expiresAt: '2026-09-06T11:00:00.000Z',
  });
  assert.equal(result.outcome, 'CLAIMED');
  assert.equal(result.lease_expires_at, '2026-08-30T11:02:00.000Z');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rpc\/bess_claim_ingest$/);
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.p_form_message_id, /^bi_[a-f0-9]{48}$/);
  assert.deepEqual(body.p_request_ids, ['r1']);
});

test('claimIngestBatch 原子 RPC 直接返回幂等重放结果', async () => {
  const { store, calls } = setup([[{ outcome: 'COMPLETE', lease_expires_at: null, message_id: 'om_done' }]]);
  const result = await store.claimIngestBatch({
    chatId: 'oc_ingest', batchId: 'ingest_done', fingerprint: 'e'.repeat(64), requestIds: ['r2'],
    now: new Date('2026-08-30T11:00:30.000Z'), expiresAt: '2026-09-06T11:00:00.000Z',
  });
  assert.deepEqual(result, { outcome: 'COMPLETE', lease_expires_at: '', message_id: 'om_done' });
  assert.equal(calls.length, 1);
});

test('claimIngestBatch 在 RPC 缺失时走有总预算的旧 schema 回退', async () => {
  const missing = { code: 'PGRST202', message: 'Could not find bess_claim_ingest' };
  const inserted = { request_context: { kind: 'dispatch_ingest', status: 'SENDING' } };
  const payloads = [
    response(missing, { ok: false, status: 404 }),
    response([inserted]),
  ];
  const calls = [];
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return payloads.shift(); },
    claimTimeoutMs: 100,
  });
  const result = await store.claimIngestBatch({
    chatId: 'oc_ingest', batchId: 'legacy', fingerprint: 'f'.repeat(64), requestIds: ['r3'],
    now: new Date('2026-08-30T11:00:30.000Z'), expiresAt: '2026-09-06T11:00:00.000Z',
  });
  assert.equal(result.outcome, 'CLAIMED');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /bess_dispatch_pending_forms\?on_conflict=form_message_id$/);
});

test('completeIngestBatch 以所有权 CAS 更新并保留 requestIds', async () => {
  const completed = { request_context: { status: 'SENT', messageId: 'om_done' } };
  const { store, calls } = setup([[completed]]);
  const lease = '2026-08-30T11:02:00.000Z';
  await store.completeIngestBatch({
    chatId: 'oc_ingest', batchId: 'ingest_3', fingerprint: 'f'.repeat(64),
    requestIds: ['r3'], messageId: 'om_done', expectedLeaseExpiresAt: lease,
    completedAt: new Date('2026-08-30T11:00:30.000Z'),
  });
  assert.equal(calls[0].options.method, 'PATCH');
  assert.match(calls[0].url, /form_message_id=eq\.bi_[a-f0-9]{48}&/);
  assert.match(calls[0].url, /request_context-%3E%3Efingerprint=eq\.f{64}/);
  assert.match(calls[0].url, /request_context-%3E%3Estatus=eq\.SENDING/);
  assert.ok(calls[0].url.includes(`request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(lease)}`));
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.request_context.requestIds, ['r3']);
  assert.equal(body.request_context.status, 'SENT');
});

test('completeIngestBatch 所有权 CAS 丢失时拒绝覆盖新记录', async () => {
  const { store } = setup([[]]);
  await assert.rejects(
    store.completeIngestBatch({
      chatId: 'oc_ingest', batchId: 'ingest_stale', fingerprint: 'b'.repeat(64),
      requestIds: ['old'], messageId: 'om_old', expectedLeaseExpiresAt: '2026-08-30T11:02:00.000Z',
    }),
    (error) => error instanceof DispatchStoreError && error.code === 'INGEST_CLAIM_LOST',
  );
});

test('completeIngestBatch 写回受独立短超时约束且 store 内不盲重试', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl,
    timeoutMs: 5000, completionTimeoutMs: 8, logger: {},
  });

  await assert.rejects(
    store.completeIngestBatch({
      chatId: 'oc_ingest', batchId: 'ingest_timeout', fingerprint: 'a'.repeat(64),
      requestIds: ['r1'], messageId: 'om_delivered',
      expectedLeaseExpiresAt: '2026-08-30T11:02:00.000Z',
    }),
    (error) => error instanceof DispatchStoreError
      && error.code === 'DISPATCH_DB_TIMEOUT'
      && error.timeoutMs === 8,
  );
  assert.equal(calls, 1);
});


test('Supabase 请求输出不含查询值的结构化时延日志', async () => {
  const entries = [];
  const logger = {
    info(message) { entries.push(JSON.parse(message)); },
    warn(message) { entries.push(JSON.parse(message)); },
    error(message) { entries.push(JSON.parse(message)); },
  };
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchImpl: async () => response([]),
    logger,
  });

  await store.getIngestBatchStatus({ chatId: 'oc_secret', batchId: 'batch_secret' });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'dispatch_db_request');
  assert.equal(entries[0].outcome, 'ok');
  assert.equal(entries[0].operation, 'GET bess_dispatch_pending_forms');
  assert.equal(entries[0].http_status, 200);
  assert.equal(typeof entries[0].duration_ms, 'number');
  assert.doesNotMatch(JSON.stringify(entries[0]), /oc_secret|batch_secret|service-key/);
});

test('status 只读查询遇到瞬时网络错误时在总预算内重试一次', async () => {
  let calls = 0;
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('socket reset'), { name: 'TypeError' });
      return response([{
        request_context: {
          kind: 'dispatch_ingest', status: 'SENT', messageId: 'om_recovered', requestIds: ['r1'],
        },
      }]);
    },
    statusRetryDelayMs: 0,
    logger: {},
  });

  const status = await store.getIngestBatchStatus({ chatId: 'oc_retry', batchId: 'batch_retry' });
  assert.equal(calls, 2);
  assert.equal(status.status, 'SENT');
  assert.equal(status.message_id, 'om_recovered');
});

test('status 只读查询遇到确定性 4xx 时不重试', async () => {
  let calls = 0;
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchImpl: async () => {
      calls += 1;
      return response({ code: '42501', message: 'forbidden' }, { ok: false, status: 403 });
    },
    statusRetryDelayMs: 0,
    logger: {},
  });

  await assert.rejects(
    store.getIngestBatchStatus({ chatId: 'oc_forbidden', batchId: 'batch_forbidden' }),
    (error) => error instanceof DispatchStoreError && error.httpStatus === 403,
  );
  assert.equal(calls, 1);
});

test('Supabase 超时错误保留操作和时延诊断字段', async () => {
  const entries = [];
  const logger = {
    warn(message) { entries.push(JSON.parse(message)); },
    error(message) { entries.push(JSON.parse(message)); },
  };
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchImpl,
    timeoutMs: 5,
    statusTotalTimeoutMs: 20,
    statusRetryDelayMs: 0,
    logger,
  });

  await assert.rejects(
    store.getIngestBatchStatus({ chatId: 'oc_timeout', batchId: 'batch_timeout' }),
    (error) => error instanceof DispatchStoreError
      && error.code === 'DISPATCH_DB_TIMEOUT'
      && error.dbOperation === 'GET bess_dispatch_pending_forms'
      && error.timeoutMs === 5
      && error.durationMs >= 5,
  );
  assert.equal(entries.filter((entry) => entry.outcome === 'timeout').length, 2);
  assert.equal(entries.filter((entry) => entry.outcome === 'retry_scheduled').length, 1);
  assert.equal(entries[0].timeout_ms, 5);
  assert.equal(entries[0].http_status, null);
});


test('claimIngestBatch 慢数据库受严格总时限约束且不重试', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl,
    timeoutMs: 5000, claimTimeoutMs: 25, logger: {},
  });
  const startedAt = Date.now();
  await assert.rejects(
    store.claimIngestBatch({
      chatId: 'oc_slow', batchId: 'slow', fingerprint: 'a'.repeat(64), requestIds: ['r'],
      now: new Date(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }),
    (error) => error instanceof DispatchStoreError && error.code === 'DISPATCH_DB_TIMEOUT',
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 250, 'claim must stay well below the HTTP timeout');
});

test('failIngestBatch 以租约 CAS 持久化 FAILED', async () => {
  const failed = { request_context: { status: 'FAILED', errorCode: 'LARK_TIMEOUT' } };
  const { store, calls } = setup([[failed]]);
  await store.failIngestBatch({
    chatId: 'oc_ingest', batchId: 'failed', fingerprint: 'c'.repeat(64),
    requestIds: ['r4'], errorCode: 'LARK_TIMEOUT',
    expectedLeaseExpiresAt: '2026-08-30T11:02:00.000Z',
    failedAt: new Date('2026-08-30T11:01:00.000Z'),
  });
  assert.equal(calls[0].options.method, 'PATCH');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.request_context.status, 'FAILED');
  assert.equal(body.request_context.errorCode, 'LARK_TIMEOUT');
});


test('outbox store 通过 RPC 入队、claim、complete 和 retry', async () => {
  const { store, calls } = setup([
    [{ outcome: 'ACCEPTED', status: 'QUEUED', operation_id: 'op_1', message_id: '' }],
    [{ form_message_id: 'bi_1', chat_id: 'oc_1', batch_id: 'b_1', operation_id: 'op_1', request_ids: ['r1'], card: { schema: '2.0' }, attempt: 1 }],
    [{ completed: true }],
    [{ updated: true }],
  ]);
  const now = new Date('2026-09-15T10:00:00.000Z');
  const enqueued = await store.enqueueDispatchOutbox({
    chatId: 'oc_1', batchId: 'b_1', fingerprint: 'a'.repeat(64), requestIds: ['r1'],
    operationId: 'op_1', card: { schema: '2.0' }, source: 'test', now,
    expiresAt: '2026-09-22T10:00:00.000Z',
  });
  assert.equal(enqueued.status, 'QUEUED');
  const claimed = await store.claimDispatchOutbox({ workerToken: 'worker-1', now });
  assert.equal(claimed[0].operation_id, 'op_1');
  await store.completeDispatchOutbox({ formMessageId: 'bi_1', workerToken: 'worker-1', operationId: 'op_1', messageId: 'om_1', completedAt: now });
  await store.retryDispatchOutbox({ formMessageId: 'bi_1', workerToken: 'worker-1', operationId: 'op_1', errorCode: 'TEST', nextRetryAt: now, dead: false });
  assert.match(calls[0].url, /rpc\/bess_enqueue_dispatch_outbox$/);
  assert.match(calls[1].url, /rpc\/bess_claim_dispatch_outbox$/);
  assert.match(calls[2].url, /rpc\/bess_complete_dispatch_outbox$/);
  assert.match(calls[3].url, /rpc\/bess_retry_dispatch_outbox$/);
});

test('enqueueDispatchOutbox 慢数据库受 claim 总预算约束', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl,
    timeoutMs: 5000, claimTimeoutMs: 20, logger: {},
  });
  await assert.rejects(
    store.enqueueDispatchOutbox({
      chatId: 'oc_slow', batchId: 'slow', fingerprint: 'a'.repeat(64), requestIds: ['r'], operationId: 'op',
      card: { schema: '2.0' }, source: 'test', now: new Date(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }),
    (error) => error instanceof DispatchStoreError && error.code === 'DISPATCH_DB_TIMEOUT',
  );
  assert.equal(calls, 1);
});


test('outbox RPC 未迁移时 /send 入队自动降级到 pending_forms REST', async () => {
  const missing = response({ code: 'PGRST202', message: 'Could not find bess_enqueue_dispatch_outbox' }, { ok: false, status: 404 });
  const inserted = { form_message_id: 'bi_legacy', request_context: { kind: 'dispatch_ingest' } };
  const calls = [];
  const payloads = [missing, response([inserted])];
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return payloads.shift(); },
  });
  const result = await store.enqueueDispatchOutbox({
    chatId: 'oc_legacy', batchId: 'batch_legacy', fingerprint: 'a'.repeat(64),
    requestIds: ['r1'], operationId: 'op_stable', card: { schema: '2.0' }, source: 'test',
    now: new Date('2026-09-15T10:00:00.000Z'), expiresAt: '2026-09-22T10:00:00.000Z',
  });
  assert.equal(result.outcome, 'ACCEPTED');
  assert.equal(result.operation_id, 'op_stable');
  assert.match(calls[0].url, /rpc\/bess_enqueue_dispatch_outbox$/);
  assert.match(calls[1].url, /bess_dispatch_pending_forms\?on_conflict=form_message_id$/);
  const context = JSON.parse(calls[1].options.body).request_context;
  assert.equal(context.status, 'QUEUED');
  assert.equal(context.operationId, 'op_stable');
});

test('生产未迁移时并发 worker 通过 REST CAS 只发送一次并写回 SENT', async () => {
  const now = new Date('2026-09-15T10:00:00.000Z');
  let row = {
    form_message_id: 'bi_concurrent', request_id: 'batch_concurrent', original_message_id: 'bi_concurrent',
    chat_id: 'oc_concurrent', created_at: now.toISOString(), completed_at: null,
    request_context: {
      kind: 'dispatch_ingest', batchId: 'batch_concurrent', fingerprint: 'b'.repeat(64),
      requestIds: ['r1'], operationId: 'op_concurrent', card: { schema: '2.0' },
      status: 'QUEUED', attempt: 0, nextRetryAt: now.toISOString(), leaseExpiresAt: null, workerToken: null,
    },
  };
  const fetchImpl = async (url, options) => {
    if (url.includes('/rpc/')) {
      const name = url.split('/rpc/')[1];
      return response({ code: 'PGRST202', message: `Could not find ${name}` }, { ok: false, status: 404 });
    }
    if (options.method === 'GET') return response(row && !row.completed_at ? [structuredClone(row)] : row ? [structuredClone(row)] : []);
    if (options.method === 'PATCH') {
      const wantsProcessing = url.includes('status=eq.PROCESSING');
      const wantsQueued = url.includes('status=eq.QUEUED');
      const workerMatch = !url.includes('workerToken=eq.')
        || url.includes(`workerToken=eq.${encodeURIComponent(row.request_context.workerToken)}`);
      if ((wantsQueued && row.request_context.status !== 'QUEUED')
        || (wantsProcessing && row.request_context.status !== 'PROCESSING') || !workerMatch) return response([]);
      const body = JSON.parse(options.body);
      row = { ...row, ...body };
      return response([structuredClone(row)]);
    }
    throw new Error(`unexpected ${options.method} ${url}`);
  };
  const store = createSupabaseDispatchStore({ url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl });
  const sent = [];
  const client = { async sendMessage(message) { sent.push(message); return { message_id: 'om_deduped' }; } };
  const [first, second] = await Promise.all([
    runDispatchOutbox({ store, client, workerToken: 'worker-a', now: () => now }),
    runDispatchOutbox({ store, client, workerToken: 'worker-b', now: () => now }),
  ]);
  assert.equal(first.claimed + second.claimed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].uuid, 'op_concurrent');
  assert.equal(row.request_context.status, 'SENT');
  assert.equal(row.request_context.messageId, 'om_deduped');
  assert.equal(row.original_message_id, 'om_deduped');
});

test('生产未迁移时 retry 和 DEAD 均写回现有 request_context', async () => {
  const now = new Date('2026-09-15T10:00:00.000Z');
  let context = { kind: 'dispatch_ingest', operationId: 'op_retry', status: 'PROCESSING', workerToken: 'worker-r', leaseExpiresAt: now.toISOString() };
  const fetchImpl = async (url, options) => {
    if (url.includes('/rpc/')) return response({ code: 'PGRST202', message: `Could not find ${url.split('/rpc/')[1]}` }, { ok: false, status: 404 });
    if (options.method === 'GET') return response([{ form_message_id: 'bi_retry', request_context: structuredClone(context) }]);
    if (options.method === 'PATCH') {
      context = JSON.parse(options.body).request_context;
      return response([{ form_message_id: 'bi_retry', request_context: structuredClone(context) }]);
    }
    throw new Error('unexpected request');
  };
  const store = createSupabaseDispatchStore({ url: 'https://example.supabase.co', serviceRoleKey: 'service-key', fetchImpl });
  await store.retryDispatchOutbox({
    formMessageId: 'bi_retry', workerToken: 'worker-r', operationId: 'op_retry',
    errorCode: 'COMPLETE_TIMEOUT', nextRetryAt: new Date(now.getTime() + 5000), dead: false,
  });
  assert.equal(context.status, 'RETRY');
  assert.equal(context.errorCode, 'COMPLETE_TIMEOUT');
  context = { ...context, status: 'PROCESSING', workerToken: 'worker-r' };
  await store.retryDispatchOutbox({
    formMessageId: 'bi_retry', workerToken: 'worker-r', operationId: 'op_retry',
    errorCode: 'MAX_ATTEMPTS', nextRetryAt: new Date(now.getTime() + 10000), dead: true,
  });
  assert.equal(context.status, 'DEAD');
  assert.equal(context.workerToken, null);
});


test('status recovery claim 使用目标 batch 的 REST/CAS 而非全局 RPC', async () => {
  const now = new Date('2026-09-15T10:00:00.000Z');
  const row = {
    form_message_id: 'bi_target', chat_id: 'oc_target', created_at: now.toISOString(), completed_at: null,
    request_context: {
      kind: 'dispatch_ingest', batchId: 'batch_target', operationId: 'op_target',
      requestIds: ['r1'], card: { schema: '2.0' }, status: 'RETRY', attempt: 1,
      nextRetryAt: now.toISOString(), leaseExpiresAt: null, workerToken: null,
    },
  };
  const { store, calls } = setup([[row], [{ ...row, request_context: { ...row.request_context, status: 'PROCESSING' } }]]);
  const claimed = await store.claimDispatchOutboxBatch({
    chatId: 'oc_target', batchId: 'batch_target', workerToken: 'worker-target', now,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].batch_id, 'batch_target');
  assert.doesNotMatch(calls[0].url, /\/rpc\//);
  assert.match(calls[0].url, /form_message_id=eq\./);
  assert.match(calls[1].url, /request_context-%3E%3Estatus=eq\.RETRY/);
});
