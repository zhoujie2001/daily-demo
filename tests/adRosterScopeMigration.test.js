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

test('旧 RPC 撤权并要求暂停派单后协调切换 scope-aware 新版本', () => {
  assert.match(sql, /coordinated cutover/i);
  assert.match(sql, /revoke all on function public\.bess_assign_next\(date,text,text,jsonb,timestamptz,jsonb\)/i);
  assert.doesNotMatch(sql, /grant execute on function public\.bess_assign_next\(date,text,text,jsonb,timestamptz,jsonb\) to service_role/i);
  assert.match(sql, /grant execute on function public\.bess_assign_next\(date,text,text,text,jsonb,timestamptz,jsonb\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*?to (public|anon|authenticated)/i);
});
