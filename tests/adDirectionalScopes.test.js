import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { enforceSingleBatchScope } from '../lib/dispatch/dispatch-service.js';

const sql = readFileSync(new URL('../db/migrations/20261005_ad_directional_scopes.sql', import.meta.url), 'utf8');
const hardeningSql = readFileSync(new URL('../db/migrations/20261011_rpc_contract_hardening.sql', import.meta.url), 'utf8');
const isolationSql = readFileSync(new URL('../db/migrations/20261023_isolate_ad_off_duty.sql', import.meta.url), 'utf8');
const rollbackSql = readFileSync(new URL('../db/migrations/20261023_isolate_ad_off_duty_rollback.sql', import.meta.url), 'utf8');

const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');

function functionSql(name, source = sql) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} must exist in source`);
  const next = source.indexOf('create or replace function public.', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('回滚迁移以 ad_review 为准恢复共享表并还原旧逻辑', () => {
  assert.match(rollbackSql, /insert into public\.bess_dispatch_person_status/i);
  assert.match(rollbackSql, /where scope = 'ad_review'/i);

  // 确保回滚后的 update_roster_status 重新包含 person_status 写入和双 Scope 更新
  const updateStatus = functionSql('bess_update_roster_status', rollbackSql);
  assert.match(updateStatus, /insert into public\.bess_dispatch_person_status/i);
  assert.match(updateStatus, /where state\.day_key = p_day_key and state\.scope in \('ad_review', 'ad_game'\)/i);
});

test('AD 状态隔离迁移移除对 person_status 的读写，回归使用 daily_state.off_duty', () => {
  assert.match(isolationSql, /create or replace function public\.bess_initialize_ad_rosters\(/i);
  assert.match(isolationSql, /create or replace function public\.bess_replace_ad_rosters\(/i);
  assert.match(isolationSql, /create or replace function public\.bess_update_roster_status\(/i);
  assert.match(isolationSql, /create or replace function public\.bess_assign_next\(/i);
  assert.match(isolationSql, /create or replace function public\.bess_assign_batch\(/i);
  assert.match(isolationSql, /create or replace function public\.bess_assign_specific\(/i);

  // 确保新函数代码体中不再出现 person_status (忽略文件头注释)
  const codeBody = isolationSql.slice(isolationSql.indexOf('begin;'));
  assert.doesNotMatch(codeBody, /bess_dispatch_person_status/i);

  // 确保 update_roster_status 仅更新单行且包含 test_default
  const updateStatus = functionSql('bess_update_roster_status', isolationSql);
  assert.match(updateStatus, /p_scope not in \('default', 'test_default', 'ad', 'ad_review', 'ad_game'\)/i);
  assert.match(updateStatus, /where state\.day_key = p_day_key and state\.scope = p_scope/i);
  assert.doesNotMatch(updateStatus, /state\.scope in \('ad_review', 'ad_game'\)/i);

  // 确保派单函数统一使用 state.off_duty
  for (const rpc of ['bess_assign_next', 'bess_assign_batch', 'bess_assign_specific']) {
    const body = functionSql(rpc, isolationSql);
    assert.match(body, /v_state\.off_duty \? /i);
    assert.doesNotMatch(body, /public\.bess_dispatch_person_status/i);
  }
});

test('AD 双 scope 迁移放宽约束并保留旧 ad 回滚兼容', () => {
  assert.match(sql, /scope in \('default', 'ad', 'ad_review', 'ad_game'\)/i);
  assert.match(sql, /where legacy\.scope = 'ad'/i);
  assert.match(sql, /cross join \(values \('ad_review'::text\), \('ad_game'::text\)\)/i);
  assert.doesNotMatch(sql, /delete from public\.bess_dispatch_(?:daily_state|assignments)/i);
});

test('迁移提供双名单原子初始化、全局人员状态和四个 scope-aware RPC', () => {
  assert.match(sql, /create table if not exists public\.bess_dispatch_person_status/i);
  assert.match(sql, /primary key \(day_key, person_name\)/i);
  assert.match(sql, /create or replace function public\.bess_initialize_ad_rosters\(/i);
  assert.match(sql, /create or replace function public\.bess_replace_ad_rosters\(/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*:ad_rosters/i);
  for (const rpc of ['bess_assign_next', 'bess_assign_specific', 'bess_calibrate_cursor', 'bess_update_roster_status']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}\\(`, 'i'));
  }
  assert.match(sql, /state\.scope in \('ad_review', 'ad_game'\)/i);
  assert.match(sql, /bess_dispatch_person_status[\s\S]*status\.off_duty/i);
});

test('rollback shadow 同步名单、离岗和两类 assignment，legacy 游标入口 fail-closed', () => {
  const syncShadow = functionSql('bess_sync_legacy_ad_shadow');
  const assignNext = functionSql('bess_assign_next');
  const assignSpecific = functionSql('bess_assign_specific');
  const calibrate = functionSql('bess_calibrate_cursor');
  const updateStatus = functionSql('bess_update_roster_status');

  assert.match(syncShadow, /p_day_key, 'ad', v_review\.roster, 0, 0, v_review\.off_duty/i);
  assert.match(syncShadow, /set roster = excluded\.roster,[\s\S]*off_duty = excluded\.off_duty/i);
  assert.match(updateStatus, /perform public\.bess_sync_legacy_ad_shadow\(p_day_key\)/i);
  for (const assignmentRpc of [assignNext, assignSpecific]) {
    assert.match(assignmentRpc, /values \(p_day_key, 'ad', p_request_id,[\s\S]*on conflict \(day_key, scope, request_id\) do update/i);
    assert.match(assignmentRpc, /perform public\.bess_sync_legacy_ad_shadow\(p_day_key\)/i);
  }
  assert.match(assignNext, /p_scope = 'ad'[\s\S]*LEGACY_AD_CURSOR_UNREPRESENTABLE/i);
  assert.match(calibrate, /p_scope = 'ad'[\s\S]*LEGACY_AD_CURSOR_UNREPRESENTABLE/i);
  assert.match(sql, /revoke all on function public\.bess_sync_legacy_ad_shadow\(date\)[\s\S]*service_role/i);
});

test('全局离岗回填可重跑且不会覆盖迁移后恢复状态', () => {
  const start = sql.indexOf('insert into public.bess_dispatch_person_status(day_key, person_name, off_duty, updated_at)');
  const end = sql.indexOf('-- Migrate idempotency', start);
  const backfill = sql.slice(start, end);
  assert.match(backfill, /on conflict \(day_key, person_name\) do nothing/i);
  assert.doesNotMatch(backfill, /do update/i);
});

test('AD assignment 仅在 targetCategory 与完整 sheet/字段契约一致时回填', () => {
  assert.match(sql, /category = 'game_agent' then 'ad_game' else 'ad_review'/i);
  assert.match(sql, /category in \('ad', 'game_agent'\)[\s\S]*sheet_id <> ''[\s\S]*sheet_id <> '288afd'[\s\S]*date_field_id = 'J'[\s\S]*assignee_field_id = 'B'/i);
  assert.match(sql, /category in \('qianchuan_ad', 'ehc_emergency_ad'\)[\s\S]*sheet_id = '288afd'[\s\S]*date_field_id = 'A'[\s\S]*assignee_field_id = 'F'/i);
  assert.match(sql, /Contradictory, partial and category-less records remain in legacy ad/i);
  assert.doesNotMatch(sql, /coalesce\([^)]*sheet[^)]*,[^)]*'ad_review'/i);
});

test('人员状态表重复迁移后仍保持唯一 service_role policy 与最小表权限', () => {
  assert.match(sql, /drop policy if exists bess_dispatch_service_role_only on public\.bess_dispatch_person_status/i);
  assert.match(sql, /create policy bess_dispatch_service_role_only[\s\S]*?to service_role[\s\S]*?using \(true\)[\s\S]*?with check \(true\)/i);
  assert.match(sql, /revoke all on table public\.bess_dispatch_person_status from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.bess_dispatch_person_status to service_role/i);
});

test('只读验收覆盖双 scope 键、人员状态、双名单、scope-aware RPC 和 rollback shadow', () => {
  for (const contract of [
    'PRIMARY KEY (day_key, scope)',
    'UNIQUE (day_key, scope, request_id)',
    'bess_dispatch_person_status',
    'bess_initialize_ad_rosters',
    'bess_replace_ad_rosters',
    'bess_assign_specific',
    'bess_calibrate_cursor',
    'bess_update_roster_status',
    'LEGACY_AD_CURSOR_UNREPRESENTABLE',
    'bess_sync_legacy_ad_shadow',
  ]) assert.match(verification, new RegExp(contract.replace(/[()]/g, '\\$&'), 'i'));
  assert.match(verification, /bess_is_valid_dispatch_scope/);
  assert.match(verification, /ad_isolation\|ad_game_isolation/);
  assert.match(verification, /begin transaction read only/i);
});

test('验收脚本精确校验动态 scope validator 并保留基础 schema/序列契约', () => {
  assert.match(verification, /to_regprocedure\('public\.bess_is_valid_dispatch_scope\(text\)'\)/i);
  assert.match(verification, /pg_get_constraintdef\(c\.oid\)[\s\S]*bess_is_valid_dispatch_scope\(scope\)/i);
  assert.match(verification, /pg_get_constraintdef\(c\.oid\) =\s*'CHECK \(\(direction = ANY \(ARRAY\[/i);
  assert.doesNotMatch(verification, /pg_get_constraintdef\(c\.oid\) like '%scope%'/i);
  for (const contract of [
    'PRIMARY KEY (form_message_id)',
    'UNIQUE (request_id)',
    'PRIMARY KEY (id)',
    'jsonb_array_length(roster) > 0',
    'forward_cursor >= 0',
    'reverse_cursor >= 0',
    'bess_dispatch_assignments_id_seq',
    'service_role 拥有不必要的 assignments identity 序列 SELECT/UPDATE',
  ]) assert.match(verification, new RegExp(contract.replace(/[()]/g, '\\$&'), 'i'));
});

test('assign_next 验收锁定 9 参数与版本化 OUT 契约', () => {
  assert.match(verification, /bess_assign_next\(date,text,text,text,jsonb,timestamp with time zone,jsonb,bigint,bigint\)/i);
  assert.match(verification, /'p_expected_version','p_expected_cursor_version','assignee','roster','direction','replayed'/i);
  assert.match(verification, /'original_message_id','version','forward_version','reverse_version','assignment_seq',\s*'emergency_forward_version'/i);
  assert.match(verification, /p\.proargmodes = array\['i','i','i','i','i','i','i','i','i','t','t','t','t','t','t','t','t','t','t'\]::"char"\[\]/i);
  assert.match(verification, /旧 RPC overload 未 DROP/i);
});

test('内存契约：双 scope 名单同序、游标和 assignment 隔离、离岗与恢复完全独立', async () => {
  const store = createMemoryBatchStore({ now: () => new Date('2026-10-05T08:00:00Z') });
  const init = { dayKey: '2026-10-05', scope: 'ad_review', roster: ['甲甲', '乙乙'], expiresAt: '2026-10-06T16:00:00Z' };
  await store.initializeRoster(init);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).roster, ['甲甲', '乙乙']);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).roster, ['甲甲', '乙乙']);

  await store.assign({ dayKey: init.dayKey, scope: 'ad_review', requestId: 'same', direction: 'reverse', context: {} });
  assert.equal((await store.getDailyState(init.dayKey, 'ad_review')).reverse_cursor, 1);
  assert.equal((await store.getDailyState(init.dayKey, 'ad_game')).reverse_cursor, 0);

  // 验证状态隔离：更新 review 不影响 game
  await store.updateRosterStatus({ dayKey: init.dayKey, scope: 'ad_review', offDuty: ['甲甲'], expectedVersion: 1 });
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).off_duty, ['甲甲']);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).off_duty, []);

  // 验证各 Scope 派单跳过各自的离岗人员
  // ad_review 中 甲甲 离岗，reverse 应该派 乙乙 (index 1)
  const reviewRes = await store.assign({ dayKey: init.dayKey, scope: 'ad_review', requestId: 'r-review', direction: 'reverse' });
  assert.equal(reviewRes.assignee, '乙乙');

  // ad_game 中没有人离岗，reverse 应该派 乙乙 (index 1) 然后 1 也是乙乙 (Wait, roster length 2, reverse cursor 0 -> index 2-1-0=1 which is 乙乙)
  // Let's do forward for ad_game to be clearer
  const gameRes = await store.assign({ dayKey: init.dayKey, scope: 'ad_game', requestId: 'r-game', direction: 'forward' });
  assert.equal(gameRes.assignee, '甲甲');

  // 验证反向隔离：更新 game 不影响 review
  await store.updateRosterStatus({ dayKey: init.dayKey, scope: 'ad_game', offDuty: ['乙乙'], expectedVersion: 1 });
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).off_duty, ['乙乙']);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).off_duty, ['甲甲']);
});

test('跨 scope 批次 fail-closed', () => {
  assert.throws(
    () => enforceSingleBatchScope([{ dispatchScope: 'ad_review' }, { dispatchScope: 'ad_game' }]),
    (error) => error.code === 'MIXED_DISPATCH_SCOPE',
  );
  assert.equal(enforceSingleBatchScope([{ dispatchScope: 'ad_review' }, { dispatchScope: 'ad_review' }]), 'ad_review');
});


test('20261011 迁移物理删除全部旧 overload 并保留 9/7/4 契约', () => {
  for (const signature of [
    'bess_assign_next(date,text,text,jsonb,timestamptz,jsonb)',
    'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb)',
    'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint)',
    'bess_calibrate_cursor(date,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,text,jsonb,bigint)',
    'bess_update_roster_status(date,jsonb,bigint)',
  ]) {
    assert.match(hardeningSql, new RegExp(`to_regprocedure\\('public\\.' \\|\\| v_sig\\)|${signature.replace(/[()]/g, '\\$&')}`, 'i'));
  }
  assert.match(hardeningSql, /revoke execute[\s\S]*drop function public\.%s/i);
  assert.match(hardeningSql, /bess_assign_next\(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint\)/i);
  assert.match(hardeningSql, /bess_calibrate_cursor\(date,text,text,text,jsonb,bigint,bigint\)/i);
  assert.match(hardeningSql, /assignment_seq bigint not null default 0/i);
  assert.match(hardeningSql, /CAS_FORWARD_CURSOR_MISMATCH/i);
  assert.match(hardeningSql, /CAS_REVERSE_CURSOR_MISMATCH/i);
  const replaceStart = hardeningSql.indexOf('create or replace function public.bess_replace_ad_rosters(');
  const replaceEnd = hardeningSql.indexOf('create or replace function public.bess_assign_next(', replaceStart);
  const replaceSql = hardeningSql.slice(replaceStart, replaceEnd);
  assert.match(replaceSql, /forward_version\s*=\s*state\.forward_version\s*\+\s*1/i);
  assert.match(replaceSql, /reverse_version\s*=\s*state\.reverse_version\s*\+\s*1/i);
});

test('内存派单使用方向 CAS 并原子递增 assignment_seq', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2026-10-11', roster: ['甲', '乙'], expiresAt: '2026-10-12T16:00:00Z' });
  const first = await store.assign({
    dayKey: '2026-10-11', requestId: 'r1', direction: 'forward', context: {},
    expectedVersion: 1, expectedCursorVersion: 1,
  });
  assert.equal(first.assignment_seq, 1);
  assert.equal(first.forward_version, 2);
  const second = await store.assign({
    dayKey: '2026-10-11', requestId: 'r2', direction: 'forward', context: {},
    expectedVersion: 1, expectedCursorVersion: 2,
  });
  assert.equal(second.assignment_seq, 2);
  await assert.rejects(
    store.assign({ dayKey: '2026-10-11', requestId: 'r3', direction: 'forward', context: {}, expectedVersion: 1, expectedCursorVersion: 1 }),
    (error) => error.code === 'ASSIGNMENT_CONFLICT',
  );
});
