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

test('AD 三份名单状态原子更新并按 operation+hash 幂等重放', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2099-01-01', scope: 'ad_review', roster: ['甲', '乙'], expiresAt });
  const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
  const states = await Promise.all(scopes.map((scope) => store.getDailyState('2099-01-01', scope)));
  const args = {
    dayKey: '2099-01-01', confirmationOperationId: 'confirm-1', submissionHash: 'hash-1', confirmedBy: 'ou_test',
    updates: states.map((state, index) => ({
      scope: state.scope,
      offDuty: index === 0 ? ['甲'] : index === 1 ? ['乙'] : [],
      expectedVersion: state.version,
      expectedRosterRevision: state.roster_revision,
    })),
  };
  const first = await store.updateAdRosterStatuses(args);
  assert.equal(first.replayed, false);
  assert.deepEqual(
    await Promise.all(scopes.map(async (scope) => (await store.getDailyState('2099-01-01', scope)).off_duty)),
    [['甲'], ['乙'], []],
  );
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

test('AD 三 scope 初始化同名单，替换后 revision/version 独立推进且无需确认门禁', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2099-01-01', scope: 'ad_review', roster: ['甲', '乙'], expiresAt });
  const review = await store.getDailyState('2099-01-01', 'ad_review');
  const game = await store.getDailyState('2099-01-01', 'ad_game');
  const emergency = await store.getDailyState('2099-01-01', 'ad_emergency');
  assert.deepEqual([review.roster, game.roster, emergency.roster], [['甲', '乙'], ['甲', '乙'], ['甲', '乙']]);
  await store.replaceAdRosters({
    dayKey: '2099-01-01', roster: ['乙', '甲'],
    expectedReviewVersion: review.version,
    expectedGameVersion: game.version,
    expectedEmergencyVersion: emergency.version,
  });
  const replaced = await Promise.all(['ad_review', 'ad_game', 'ad_emergency']
    .map((scope) => store.getDailyState('2099-01-01', scope)));
  assert.equal(replaced.every((state) => state.roster_revision === 2), true);
  assert.equal(replaced.every((state) => state.status_confirmed === true), true);
});

test('AD 统一状态卡展示三份明确名单和三个全局唯一多选字段', () => {
  const card = buildAdjustStatusFormCard({
    dayKey: '2099-01-01', businessType: 'AD', dispatchProfile: 'ad', isAd: true,
    adStates: [
      { scope: 'ad_review', roster: ['甲', '乙'], offDuty: ['甲'] },
      { scope: 'ad_game', roster: ['甲', '乙'], offDuty: ['乙'] },
      { scope: 'ad_emergency', roster: ['甲', '乙'], offDuty: [] },
    ],
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /AD大盘名单/);
  assert.match(serialized, /AD游戏名单/);
  assert.match(serialized, /应急需求名单/);
  assert.doesNotMatch(serialized, /仅当前范围|仅另一范围|两个范围|"name":"range"/);
  const form = card.body.elements.find((element) => element.tag === 'form');
  const selectors = form.elements.filter((element) => element.tag === 'multi_select_static');
  assert.deepEqual(selectors.map((element) => element.name), [
    'ad_review_off_duty', 'ad_game_off_duty', 'ad_emergency_off_duty',
  ]);
  assert.equal(new Set(form.elements.map((element) => element.name)).size, form.elements.length);
  const submit = form.elements.find((element) => element.name === 'adjust_status_submit');
  assert.equal(submit.value.status_form_protocol_version, 2);
  assert.deepEqual(selectors[0].selected_values, ['甲']);
  assert.deepEqual(selectors[2].selected_values, []);
  assert.equal(selectors.some((s) => Object.hasOwn(s, 'initial_options')), false);
  assert.equal(selectors.every((element) => element.options.every((option) => typeof option.value === 'string')), true);
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


test('独立增量 migration 新增 ad_emergency、从 ad_review 回填并保持兼容', () => {
  const publishedSql = readFileSync(new URL('../db/migrations/20261024_ad_status_confirmation_emergency_cursor.sql', import.meta.url), 'utf8');
  const sql = readFileSync(new URL('../db/migrations/20261024_ad_three_independent_rosters.sql', import.meta.url), 'utf8');
  const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(publishedSql, /ad_emergency/);
  assert.match(sql, /'ad_emergency'/);
  assert.match(sql, /select state\.day_key, 'ad_emergency', state\.roster[\s\S]*where state\.scope = 'ad_review'/i);
  assert.match(sql, /on conflict \(day_key, scope\) do nothing/i);
  assert.match(sql, /values \('ad_review'::text\), \('ad_game'::text\), \('ad_emergency'::text\)/i);
  assert.match(sql, /p_expected_emergency_version bigint/i);
  assert.match(sql, /ad_isolation\|ad_game_isolation/);
  assert.match(sql, /check \(public\.bess_is_valid_dispatch_scope\(scope\)\) not valid/i);
  assert.match(sql, /validate constraint bess_dispatch_daily_state_scope_check/i);
  assert.match(sql, /create or replace function public\.bess_replace_ad_rosters\([\s\S]*p_expected_game_version bigint\s*\) returns setof/i);
  assert.match(sql, /rollback may switch application traffic back to ad_review/i);
  assert.match(verification, /bess_replace_ad_rosters\(date,jsonb,bigint,bigint,bigint\)/i);
  assert.match(verification, /''ad_review''%''ad_game''%''ad_emergency''/i);
});
