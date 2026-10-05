import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { enforceSingleBatchScope } from '../lib/dispatch/dispatch-service.js';

const sql = readFileSync(new URL('../db/migrations/20261005_ad_directional_scopes.sql', import.meta.url), 'utf8');

const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');

function functionSql(name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = sql.indexOf('create or replace function public.', start + 1);
  return sql.slice(start, next === -1 ? sql.length : next);
}

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
  assert.match(verification, /'default'.*'ad'.*'ad_review'.*'ad_game'/i);
  assert.match(verification, /begin transaction read only/i);
});

test('验收脚本精确校验枚举域并保留基础 schema/序列契约', () => {
  assert.match(verification, /pg_get_constraintdef\(c\.oid\) =\s*'CHECK \(\(scope = ANY \(ARRAY\[/i);
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

test('assign_next 验收精确锁定三个默认表达式和五个 OUT 类型', () => {
  assert.match(verification, /pg_get_expr\(p\.proargdefaults, 0\)[\s\S]*?NULL::jsonb, NULL::timestamp with time zone, ''\{\}''::jsonb/i);
  assert.match(verification, /p\.proallargtypes = array\[[\s\S]*?'date'::regtype,[\s\S]*?'jsonb'::regtype, 'timestamptz'::regtype, 'jsonb'::regtype,[\s\S]*?'text'::regtype, 'jsonb'::regtype, 'text'::regtype, 'boolean'::regtype,[\s\S]*?'text'::regtype[\s\S]*?\]::oid\[\]/i);
  assert.match(verification, /p\.proargmodes = array\['i','i','i','i','i','i','i','t','t','t','t','t'\]::"char"\[\]/i);
  assert.match(verification, /'assignee','roster','direction','replayed','original_message_id'/i);
});

test('内存契约：双 scope 名单同序、游标和 assignment 隔离、离岗与恢复全局共享', async () => {
  const store = createMemoryBatchStore({ now: () => new Date('2026-10-05T08:00:00Z') });
  const init = { dayKey: '2026-10-05', scope: 'ad_review', roster: ['甲甲', '乙乙'], expiresAt: '2026-10-06T16:00:00Z' };
  await store.initializeRoster(init);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).roster, ['甲甲', '乙乙']);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).roster, ['甲甲', '乙乙']);

  await store.assign({ dayKey: init.dayKey, scope: 'ad_review', requestId: 'same', direction: 'reverse', context: {} });
  assert.equal((await store.getDailyState(init.dayKey, 'ad_review')).reverse_cursor, 1);
  assert.equal((await store.getDailyState(init.dayKey, 'ad_game')).reverse_cursor, 0);
  await store.replaceAdRosters({
    dayKey: init.dayKey, roster: ['乙乙', '甲甲'], expectedReviewVersion: 1, expectedGameVersion: 1,
  });
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).roster, ['乙乙', '甲甲']);
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).roster, ['乙乙', '甲甲']);
  assert.equal((await store.getDailyState(init.dayKey, 'ad_review')).reverse_cursor, 1);
  assert.equal((await store.getDailyState(init.dayKey, 'ad_game')).reverse_cursor, 0);
  const game = await store.assignSpecific({ dayKey: init.dayKey, scope: 'ad_game', requestId: 'same', assignee: '甲甲', context: {} });
  assert.equal(game.replayed, false);

  await store.updateRosterStatus({ dayKey: init.dayKey, scope: 'ad_review', offDuty: ['甲甲'], expectedVersion: 2 });
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_game')).off_duty, ['甲甲']);
  await store.updateRosterStatus({ dayKey: init.dayKey, scope: 'ad_game', offDuty: [], expectedVersion: 3 });
  assert.deepEqual((await store.getDailyState(init.dayKey, 'ad_review')).off_duty, []);
});

test('跨 scope 批次 fail-closed', () => {
  assert.throws(
    () => enforceSingleBatchScope([{ dispatchScope: 'ad_review' }, { dispatchScope: 'ad_game' }]),
    (error) => error.code === 'MIXED_DISPATCH_SCOPE',
  );
  assert.equal(enforceSingleBatchScope([{ dispatchScope: 'ad_review' }, { dispatchScope: 'ad_review' }]), 'ad_review');
});
