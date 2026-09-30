import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../db/migrations/20260930_directional_assign_cursors.sql', import.meta.url), 'utf8');

test('20260930 仅替换 scope-aware 生产签名并保留五列返回契约', () => {
  assert.match(sql, /function public\.bess_assign_next\(\s*p_day_key date,\s*p_scope text,\s*p_request_id text,\s*p_direction text,\s*p_roster jsonb default null,\s*p_expires_at timestamptz default null,\s*p_context jsonb default '\{\}'::jsonb\s*\) returns table \(\s*assignee text,\s*roster jsonb,\s*direction text,\s*replayed boolean,\s*original_message_id text/is);
  assert.match(sql, /to_regprocedure\(\s*'public\.bess_assign_next\(date,text,text,text,jsonb,timestamp with time zone,jsonb\)'/i);
  assert.doesNotMatch(sql, /drop\s+function/i);
  assert.match(sql, /grant execute on function public\.bess_assign_next\(date,text,text,text,jsonb,timestamptz,jsonb\)\s+to service_role/i);
});

test('20260930 在 scope 行锁和幂等重放后仅推进当前方向游标', () => {
  assert.match(sql, /where state\.day_key = p_day_key\s+and state\.scope = p_scope\s+and state\.expires_at > now\(\)\s+for update/is);
  assert.match(sql, /where assignment\.day_key = p_day_key\s+and assignment\.scope = p_scope\s+and assignment\.request_id = p_request_id/is);
  const replayAt = sql.indexOf('if found then');
  const cursorAt = sql.indexOf("if p_direction = 'forward' then", sql.indexOf('for v_i in'));
  assert.ok(replayAt > 0 && replayAt < cursorAt);
  assert.match(sql, /if p_direction = 'forward' then\s+update[\s\S]*?set forward_cursor = v_index \+ 1,[\s\S]*?where state\.day_key = p_day_key\s+and state\.scope = p_scope;\s+else\s+update[\s\S]*?set reverse_cursor = v_count - v_index,[\s\S]*?where state\.day_key = p_day_key\s+and state\.scope = p_scope;/i);
  assert.doesNotMatch(sql, /set forward_cursor = v_index \+ 1,\s*reverse_cursor =/i);
});

test('20260930 离岗跳过发生在方向游标更新前且不会改变另一方向', () => {
  const skipAt = sql.indexOf('for v_i in 0..v_count-1 loop');
  const updateAt = sql.indexOf("if p_direction = 'forward' then\n    update", skipAt);
  assert.ok(skipAt > 0 && updateAt > skipAt);
  assert.match(sql.slice(skipAt, updateAt), /v_state\.off_duty \? assignee/);
  assert.match(sql.slice(skipAt, updateAt), /v_index := \(v_index \+ 1\) % v_count/);
  assert.match(sql.slice(skipAt, updateAt), /v_index := \(v_index - 1 \+ v_count\) % v_count/);
});
