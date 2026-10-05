import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../db/migrations/20260924_ad_roster_scope.sql', import.meta.url), 'utf8');

test('AD 名单迁移以 day_key + scope 隔离状态和分配记录', () => {
  assert.match(sql, /add column if not exists scope text not null default 'default'/i);
  assert.match(sql, /primary key \(day_key, scope\)/i);
  assert.match(sql, /unique \(day_key, scope, request_id\)/i);
  assert.match(sql, /foreign key \(day_key, scope\)/i);
});

test('三个派单 RPC 都接收 scope 并同时按 scope 过滤', () => {
  assert.match(sql, /function public\.bess_assign_next\(\s*p_day_key date,\s*p_scope text,/i);
  assert.match(sql, /state\.day_key = p_day_key and state\.scope = p_scope/i);
  assert.match(sql, /assignment\.day_key = p_day_key and assignment\.scope = p_scope/i);
  assert.match(sql, /function public\.bess_update_roster_status\(\s*p_day_key date,\s*p_scope text,/i);
  assert.match(sql, /function public\.bess_calibrate_cursor\(\s*p_day_key date,\s*p_scope text,/i);
  assert.match(sql, /function public\.bess_assign_specific\([\s\S]*?p_scope text/i);
  assert.match(sql, /direction in \('forward', 'reverse', 'specified'\)/i);
});

test('四参数 calibrate 仅按旧输入名删除基线函数，兼容部分迁移状态', () => {
  assert.match(sql, /to_regprocedure\(\s*'public\.bess_calibrate_cursor\(date,text,text,jsonb\)'/i);
  assert.match(sql, /p\.proargnames = array\['p_day_key', 'p_direction', 'p_assignee', 'p_roster'\]/i);
  assert.match(sql, /drop function public\.bess_calibrate_cursor\(date,text,text,jsonb\)/i);
  assert.match(sql, /create or replace function public\.bess_calibrate_cursor\(\s*p_day_key date,\s*p_scope text,/i);
  assert.doesNotMatch(sql, /drop function public\.bess_calibrate_cursor\(date,text,text,text,jsonb\)/i);
});

test('20261005 后重跑会保存并恢复所有被历史脚本覆盖的同签名函数', () => {
  assert.match(sql, /create temporary table bess_20260924_later_function_defs[\s\S]*pg_catalog\.pg_get_functiondef/i);
  assert.match(sql, /to_regprocedure\('public\.bess_sync_legacy_ad_shadow\(date\)'\) is not null/i);
  for (const signature of [
    'bess_assign_next\\(date,text,text,text,jsonb,timestamp with time zone,jsonb\\)',
    'bess_assign_specific\\(date,text,text,text,jsonb\\)',
    'bess_update_roster_status\\(date,text,jsonb,bigint\\)',
  ]) assert.match(sql, new RegExp(signature, 'i'));
  assert.match(sql, /select definition from bess_20260924_later_function_defs[\s\S]*execute item\.definition/i);
  assert.match(sql, /revoke all on function public\.bess_calibrate_cursor\(date,text,text,jsonb\)/i);
});

test('迁移重跑不会重新收窄后续 AD 双 scope 约束', () => {
  assert.match(sql, /scope in \('default', 'ad', 'ad_review', 'ad_game'\)/i);
});

test('旧 RPC 撤权并要求暂停派单后协调切换 scope-aware 新版本', () => {
  assert.match(sql, /coordinated cutover/i);
  assert.match(sql, /revoke all on function public\.bess_assign_next\(date,text,text,jsonb,timestamptz,jsonb\)/i);
  assert.doesNotMatch(sql, /grant execute on function public\.bess_assign_next\(date,text,text,jsonb,timestamptz,jsonb\) to service_role/i);
  assert.match(sql, /grant execute on function public\.bess_assign_next\(date,text,text,text,jsonb,timestamptz,jsonb\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*?to (public|anon|authenticated)/i);
});
