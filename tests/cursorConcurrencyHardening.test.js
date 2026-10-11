import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

const migration = readFileSync(new URL('../db/migrations/20261012_cursor_concurrency_hardening.sql', import.meta.url), 'utf8');
const previous = readFileSync(new URL('../db/migrations/20261011_rpc_contract_hardening.sql', import.meta.url), 'utf8');
const acceptance = readFileSync(new URL('../db/bess-dispatch-rpc-acceptance.sql', import.meta.url), 'utf8');

const historicalSignatures = [
  'bess_assign_next(date,text,text,jsonb,timestamptz,jsonb)',
  'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb)',
  'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint)',
  'bess_calibrate_cursor(date,text,jsonb)',
  'bess_calibrate_cursor(date,text,text,jsonb)',
  'bess_calibrate_cursor(date,text,text,text,jsonb)',
  'bess_calibrate_cursor(date,text,text,text,jsonb,bigint)',
  'bess_update_roster_status(date,jsonb,bigint)',
];

function cleanupSet(sql) {
  const block = sql.match(/v_sigs(?:\s+constant)?\s+text\[\]\s*:=\s*array\[([\s\S]*?)\];/i)?.[1] || '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

test('overload 清理集合由迁移解析并 deepEqual 完整历史枚举', () => {
  assert.deepEqual(cleanupSet(previous), [...historicalSignatures].sort());
  assert.deepEqual(cleanupSet(migration), [...historicalSignatures].sort());
});

test('真实 PostgreSQL 验收 SQL 覆盖 9/7/4、唯一签名、权限与空 search_path', () => {
  assert.match(acceptance, /begin transaction read only/i);
  assert.match(acceptance, /\('bess_assign_next'::text, 9\)/i);
  assert.match(acceptance, /\('bess_calibrate_cursor'::text, 7\)/i);
  assert.match(acceptance, /\('bess_update_roster_status'::text, 4\)/i);
  assert.match(acceptance, /count\(\*\)[\s\S]*<> 1/i);
  assert.match(acceptance, /service_role[\s\S]*has_function_privilege/i);
  assert.match(acceptance, /search_path[\s\S]*= ''/i);
});

test('迁移先幂等再 CAS，重放校验 context 且不推进 cursor/version/seq', () => {
  const replay = migration.indexOf('-- Idempotency precedes');
  const cas = migration.indexOf('CAS_ROSTER_VERSION_MISMATCH');
  const cursorUpdate = migration.indexOf('forward_cursor = v_cursor + v_steps + 1');
  assert.ok(replay > 0 && replay < cas && cas < cursorUpdate);
  assert.match(migration, /IDEMPOTENCY_CONTEXT_MISMATCH:sheetId/);
  assert.match(migration, /IDEMPOTENCY_CONTEXT_MISMATCH:targetCategory/);
  const replayEnd = migration.indexOf('  if p_roster is not null then', replay);
  assert.doesNotMatch(migration.slice(replay, replayEnd), /for update/i);
});

test('绝对游标迁移不改生产 bounded 数据，并由校准提升到最小不小于当前的同余位置', () => {
  assert.doesNotMatch(migration, /update public\.bess_dispatch_daily_state[\s\S]*set (?:forward|reverse)_cursor\s*=\s*(?:forward|reverse)_cursor\s*\*/i);
  assert.match(migration, /v_lifted := v_current \+ \(\(v_residue - \(v_current % v_count\) \+ v_count\) % v_count\)/i);
  assert.match(migration, /forward_cursor = v_cursor \+ v_steps \+ 1/i);
  assert.match(migration, /reverse_cursor = v_cursor \+ v_steps \+ 1/i);
  assert.doesNotMatch(migration, /anchor_assignee/i);
});

test('三人正序 C→A 边界与旧 A 锚点不跳 B、不回退', async () => {
  const store = createMemoryBatchStore();
  const base = { dayKey: '2026-10-11', roster: ['A', 'B', 'C'], expiresAt: '2026-10-12T16:00:00Z' };
  await store.initializeRoster(base);
  await store.assign({ dayKey: base.dayKey, requestId: 'pre-c', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: 1 });
  let state = await store.getDailyState(base.dayKey);
  await store.assign({ dayKey: base.dayKey, requestId: 'pre-b', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: state.forward_version });
  state = await store.getDailyState(base.dayKey);
  await store.assign({ dayKey: base.dayKey, requestId: 'pre-a', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: state.forward_version });
  state = await store.getDailyState(base.dayKey);
  assert.equal(state.forward_cursor, 3);
  await store.calibrateCursor({ ...base, direction: 'forward', assignee: 'C', expectedVersion: 1, expectedCursorVersion: state.forward_version });
  state = await store.getDailyState(base.dayKey);
  const a = await store.assign({ dayKey: base.dayKey, requestId: 'a', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: state.forward_version });
  assert.equal(a.assignee, 'A');
  state = await store.getDailyState(base.dayKey);
  await store.calibrateCursor({ ...base, direction: 'forward', assignee: 'A', expectedVersion: 1, expectedCursorVersion: state.forward_version });
  state = await store.getDailyState(base.dayKey);
  assert.equal(state.forward_cursor, 4, '旧 A 锚点只能保持 next=B，不能把绝对游标改回 1');
  const b = await store.assign({ dayKey: base.dayKey, requestId: 'b', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: state.forward_version });
  assert.equal(b.assignee, 'B');
});

test('正反方向多圈保持单调绝对步数', async () => {
  const store = createMemoryBatchStore();
  const dayKey = '2026-10-11';
  await store.initializeRoster({ dayKey, roster: ['A', 'B', 'C'], expiresAt: '2026-10-12T16:00:00Z' });
  const forward = [];
  const reverse = [];
  for (let i = 0; i < 8; i += 1) {
    let state = await store.getDailyState(dayKey);
    forward.push((await store.assign({ dayKey, requestId: `f${i}`, direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: state.forward_version })).assignee);
    state = await store.getDailyState(dayKey);
    reverse.push((await store.assign({ dayKey, requestId: `r${i}`, direction: 'reverse', context: {}, expectedVersion: 1, expectedCursorVersion: state.reverse_version })).assignee);
  }
  assert.deepEqual(forward, ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B']);
  assert.deepEqual(reverse, ['C', 'B', 'A', 'C', 'B', 'A', 'C', 'B']);
  const state = await store.getDailyState(dayKey);
  assert.equal(state.forward_cursor, 8);
  assert.equal(state.reverse_cursor, 8);
});

test('旧版本 request_id 重放先于 CAS，且冲突 context fail-closed', async () => {
  const store = createMemoryBatchStore();
  const args = { dayKey: '2026-10-11', roster: ['A', 'B'], expiresAt: '2026-10-12T16:00:00Z' };
  await store.initializeRoster(args);
  const first = await store.assign({ dayKey: args.dayKey, requestId: 'same', direction: 'forward', context: { sheetId: 's1', targetCategory: 'ad' }, expectedVersion: 1, expectedCursorVersion: 1 });
  const before = await store.getDailyState(args.dayKey);
  const replay = await store.assign({ dayKey: args.dayKey, requestId: 'same', direction: 'forward', context: { sheetId: 's1', targetCategory: 'ad' }, expectedVersion: 0, expectedCursorVersion: 0 });
  const after = await store.getDailyState(args.dayKey);
  assert.equal(replay.replayed, true);
  assert.equal(replay.assignee, first.assignee);
  assert.deepEqual({ cursor: after.forward_cursor, version: after.forward_version, seq: after.assignment_seq },
    { cursor: before.forward_cursor, version: before.forward_version, seq: before.assignment_seq });
  await assert.rejects(
    store.assign({ dayKey: args.dayKey, requestId: 'same', direction: 'forward', context: { sheetId: 'other', targetCategory: 'ad' }, expectedVersion: 0, expectedCursorVersion: 0 }),
    (error) => error.code === 'IDEMPOTENCY_CONTEXT_MISMATCH',
  );
});
