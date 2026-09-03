import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseDispatchStore, DispatchStoreError } from '../lib/dispatch/supabase-store.js';

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
