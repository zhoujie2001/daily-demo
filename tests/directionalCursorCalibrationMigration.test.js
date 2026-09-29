import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../db/migrations/20260929_directional_cursor_calibration.sql', import.meta.url), 'utf8');

test('游标校准 RPC 要求显式方向并保持另一方向游标不变', () => {
  assert.match(sql, /function public\.bess_calibrate_cursor\(\s*p_day_key date,\s*p_scope text,\s*p_direction text,/i);
  assert.match(sql, /p_direction not in \('forward', 'reverse'\)/i);
  assert.match(sql, /if p_direction = 'forward' then[\s\S]*set forward_cursor = v_index \+ 1,[\s\S]*else[\s\S]*set reverse_cursor = jsonb_array_length\(v_state\.roster\) - v_index,/i);
  assert.doesNotMatch(sql, /set forward_cursor = v_index \+ 1,\s*reverse_cursor =/i);
  assert.match(sql, /grant execute on function public\.bess_calibrate_cursor\(date,text,text,text,jsonb\)\s+to service_role/i);
});
