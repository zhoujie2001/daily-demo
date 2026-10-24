import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { buildAdjustStatusFormCard } from '../lib/lark/card-renderer.js';

const expiresAt = '2099-01-02T00:00:00.000Z';

test('default scope 三个方向共享名单与离岗，但游标/version 独立', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2099-01-01', roster: ['甲', '乙', '丙'], expiresAt });
  const state = await store.getDailyState('2099-01-01');
  const forward = await store.assign({ dayKey: '2099-01-01', requestId: 'f1', direction: 'forward', expectedVersion: state.version, expectedCursorVersion: state.forward_version });
  const emergency = await store.assign({ dayKey: '2099-01-01', requestId: 'e1', direction: 'emergency_forward', expectedVersion: state.version, expectedCursorVersion: state.emergency_forward_version });
  const reverse = await store.assign({ dayKey: '2099-01-01', requestId: 'r1', direction: 'reverse', expectedVersion: state.version, expectedCursorVersion: state.reverse_version });
  assert.deepEqual([forward.assignee, emergency.assignee, reverse.assignee], ['甲', '甲', '丙']);
  const after = await store.getDailyState('2099-01-01');
  assert.deepEqual([after.forward_cursor, after.emergency_forward_cursor, after.reverse_cursor], [1, 1, 1]);
  assert.deepEqual([after.forward_version, after.emergency_forward_version, after.reverse_version], [2, 2, 2]);
});

test('AD both 确认原子绑定各自 roster revision，并按 operation+hash 先行重放', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2099-01-01', scope: 'ad_review', roster: ['甲', '乙'], expiresAt });
  const review = await store.getDailyState('2099-01-01', 'ad_review');
  const game = await store.getDailyState('2099-01-01', 'ad_game');
  const args = {
    dayKey: '2099-01-01', confirmationOperationId: 'confirm-1', submissionHash: 'hash-1', confirmedBy: 'ou_test',
    updates: [
      { scope: 'ad_review', offDuty: ['甲'], expectedVersion: review.version, expectedRosterRevision: review.roster_revision },
      { scope: 'ad_game', offDuty: [], expectedVersion: game.version, expectedRosterRevision: game.roster_revision },
    ],
  };
  const first = await store.updateAdRosterStatuses(args);
  assert.equal(first.replayed, false);
  assert.equal(first.states.every((state) => state.status_confirmed && state.confirmed_roster_revision === state.roster_revision), true);
  const replay = await store.updateAdRosterStatuses(args);
  assert.equal(replay.replayed, true);
  await assert.rejects(store.updateAdRosterStatuses({ ...args, submissionHash: 'other' }), { code: 'CONFIRMATION_OPERATION_MISMATCH' });
  const before = await store.getDailyState('2099-01-01', 'ad_review');
  await assert.rejects(store.updateAdRosterStatuses({
    ...args, confirmationOperationId: 'confirm-2', submissionHash: 'hash-2',
    updates: [{ ...args.updates[0], expectedVersion: before.version }, { ...args.updates[1], expectedVersion: 999 }],
  }), { code: 'STATUS_UPDATE_CONFLICT' });
  assert.deepEqual((await store.getDailyState('2099-01-01', 'ad_review')).off_duty, ['甲']);
});

test('状态变化使 emergency CAS 失效；名单替换递增 revision 并失效旧确认', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2099-01-01', scope: 'ad_review', roster: ['甲', '乙'], expiresAt });
  const review = await store.getDailyState('2099-01-01', 'ad_review');
  const game = await store.getDailyState('2099-01-01', 'ad_game');
  await store.updateAdRosterStatuses({
    dayKey: '2099-01-01', confirmationOperationId: 'confirm', submissionHash: 'hash', confirmedBy: 'ou',
    updates: [{ scope: 'ad_review', offDuty: [], expectedVersion: review.version, expectedRosterRevision: review.roster_revision }],
  });
  await assert.rejects(store.assign({ dayKey: '2099-01-01', scope: 'ad_review', requestId: 'stale', direction: 'emergency_forward', expectedVersion: review.version, expectedCursorVersion: review.emergency_forward_version }), { code: 'ASSIGNMENT_CONFLICT' });
  const currentReview = await store.getDailyState('2099-01-01', 'ad_review');
  await store.replaceAdRosters({ dayKey: '2099-01-01', roster: ['乙', '甲'], expectedReviewVersion: currentReview.version, expectedGameVersion: game.version });
  const replaced = await store.getDailyState('2099-01-01', 'ad_review');
  assert.equal(replaced.roster_revision, review.roster_revision + 1);
  assert.equal(replaced.status_confirmed, false);
  assert.equal(replaced.confirmed_roster_revision, null);
});

test('AD 状态卡提供 current/other/both 范围，旧提交兼容由服务默认 current', () => {
  const card = buildAdjustStatusFormCard({
    dayKey: '2099-01-01', businessType: 'AD', dispatchProfile: 'ad',
    roster: ['甲'], offDuty: [], version: 1, isAd: true,
  });
  const form = card.body.elements.find((element) => element.tag === 'form');
  const range = form.elements.find((element) => element.name === 'range');
  assert.equal(range.initial_option, 'current');
  assert.equal(typeof range.initial_option, 'string');
  assert.deepEqual(range.options.map((option) => option.value), ['current', 'other', 'both']);
});

test('SQL migration 固化 revision 确认键、独立 operation ledger 与 emergency lane', () => {
  const sql = readFileSync(new URL('../db/migrations/20261024_ad_status_confirmation_emergency_cursor.sql', import.meta.url), 'utf8');
  assert.match(sql, /primary key \(day_key, scope, roster_revision\)/i);
  assert.match(sql, /bess_dispatch_confirmation_operations[\s\S]*confirmation_operation_id text primary key/i);
  assert.match(sql, /return v_previous\.result \|\| jsonb_build_object\('replayed', true\)[\s\S]*AD_STATUS_UPDATE_CONFLICT/i);
  assert.match(sql, /emergency_forward_cursor bigint not null default 0/i);
  assert.match(sql, /p_direction not in \('forward','reverse','emergency_forward'\)/i);
  assert.match(sql, /if v_total_steps>0[\s\S]*emergency_forward_version=state\.emergency_forward_version\+1/i);
});

test('SQL migration 保持旧 RPC 调用兼容，确认门禁仅由新版 Node 执行', () => {
  const sql = readFileSync(new URL('../db/migrations/20261024_ad_status_confirmation_emergency_cursor.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /AD_STATUS_CONFIRMATION_REQUIRED/i);
  assert.doesNotMatch(sql, /p_require_status_confirmation/i);
  assert.match(sql, /create function public\.bess_assign_next\(\s*p_day_key date, p_scope text, p_request_id text, p_direction text,[\s\S]*?p_expected_cursor_version bigint default null\s*\)/i);
  assert.match(sql, /create function public\.bess_assign_batch\(\s*p_day_key date,p_scope text,p_request_ids text\[\],p_direction text,[\s\S]*?p_expected_cursor_version bigint default null\s*\)/i);
  assert.match(sql, /create function public\.bess_assign_specific\(p_day_key date,p_scope text,p_request_id text,p_assignee text,p_context jsonb default '\{\}'::jsonb\)/i);
  assert.match(sql, /create function public\.bess_calibrate_and_assign_next\(\s*p_day_key date,p_scope text,p_request_id text,p_direction text,p_assignee text,p_roster jsonb,[\s\S]*?p_expected_cursor_version bigint default null\s*\)/i);
});

test('SQL migration 保持旧返回列前缀并只在末尾追加 emergency version', () => {
  const sql = readFileSync(new URL('../db/migrations/20261024_ad_status_confirmation_emergency_cursor.sql', import.meta.url), 'utf8');
  assert.match(sql, /bess_assign_next\([\s\S]*?returns table \(assignee text, roster jsonb, direction text, replayed boolean,\s*original_message_id text, version bigint, forward_version bigint, reverse_version bigint,\s*assignment_seq bigint, emergency_forward_version bigint\)/i);
  assert.match(sql, /bess_assign_batch\([\s\S]*?returns table\(request_id text,assignee text,roster jsonb,direction text,replayed boolean,\s*original_message_id text,version bigint,forward_version bigint,reverse_version bigint,\s*assignment_seq bigint,emergency_forward_version bigint\)/i);
  assert.match(sql, /bess_assign_specific\([\s\S]*?returns table\(assignee text,replayed boolean,version bigint,forward_version bigint,reverse_version bigint,assignment_seq bigint,emergency_forward_version bigint\)/i);
  assert.match(sql, /bess_calibrate_and_assign_next\([\s\S]*?returns table\(assignee text,roster jsonb,direction text,replayed boolean,original_message_id text,\s*version bigint,forward_version bigint,reverse_version bigint,assignment_seq bigint,emergency_forward_version bigint\)/i);
});

test('正向和回滚迁移均以 NOT VALID + VALIDATE 替换 direction CHECK', () => {
  for (const file of [
    '../db/migrations/20261024_ad_status_confirmation_emergency_cursor.sql',
    '../db/migrations/20261024_ad_status_confirmation_emergency_cursor_rollback.sql',
  ]) {
    const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(sql, /add constraint bess_dispatch_assignments_direction_check[\s\S]*?check \([\s\S]*?\) not valid/i);
    assert.match(sql, /validate constraint bess_dispatch_assignments_direction_check/i);
  }
});
