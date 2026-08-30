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

test('calibrateCursor 分别更新正序和倒序游标', async () => {
  const { store, calls } = setup([[{ forward_cursor: 2 }], [{ reverse_cursor: 3 }]]);

  await store.calibrateCursor({ dayKey: '2026-08-30', direction: 'forward', cursor: 2 });
  await store.calibrateCursor({ dayKey: '2026-08-30', direction: 'reverse', cursor: 3 });

  assert.deepEqual(JSON.parse(calls[0].options.body), { forward_cursor: 2 });
  assert.deepEqual(JSON.parse(calls[1].options.body), { reverse_cursor: 3 });
  for (const call of calls) {
    assert.equal(call.options.method, 'PATCH');
    assert.equal(call.options.headers.Prefer, 'return=representation');
    assert.match(call.url, /bess_dispatch_daily_state\?day_key=eq\.2026-08-30$/);
  }
});

test('calibrateCursor 拒绝非法方向和游标且不发起请求', async () => {
  const { store, calls } = setup([]);

  await assert.rejects(
    store.calibrateCursor({ dayKey: '2026-08-30', direction: 'sideways', cursor: 1 }),
    (error) => error instanceof DispatchStoreError && error.code === 'INVALID_CURSOR_CALIBRATION',
  );
  await assert.rejects(
    store.calibrateCursor({ dayKey: '2026-08-30', direction: 'forward', cursor: -1 }),
    (error) => error instanceof DispatchStoreError && error.code === 'INVALID_CURSOR_CALIBRATION',
  );
  assert.equal(calls.length, 0);
});
