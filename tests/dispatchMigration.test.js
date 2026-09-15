import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../db/bess-dispatch.sql', import.meta.url), 'utf8');
const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');

test('migration 提供可重复执行的单往返原子接单 RPC', () => {
  assert.match(migration, /create or replace function public\.bess_claim_ingest\(/i);
  assert.match(migration, /insert into public\.bess_dispatch_pending_forms[\s\S]*?on conflict \(form_message_id\) do nothing/i);
  assert.match(migration, /for update;/i);
  assert.match(migration, /return query select 'IN_FLIGHT'/i);
  assert.match(migration, /return query select 'RESUMED'/i);
  assert.match(migration, /request_context ->> 'kind'\) is distinct from 'dispatch_ingest'/i,
    '缺 kind 的旧行必须拒绝，不得被 NULL 三值逻辑绕过后覆盖');
  assert.match(migration, /request_context ->> 'fingerprint'\) is distinct from p_fingerprint/i,
    '缺 fingerprint 的旧行必须返回冲突，不得被覆盖');
  assert.match(migration, /begin\s+v_existing_lease := nullif\([\s\S]*?::timestamptz;\s+exception when others then\s+v_existing_lease := null;\s+end;/i,
    '畸形 lease 必须安全降级为过期，不能让 RPC 强转异常');
  assert.match(migration, /coalesce\(v_existing_lease, '-infinity'::timestamptz\) > now\(\)/i);
});

test('原子接单 RPC 遵循最小权限并纳入只读验收', () => {
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration, /revoke all on function public\.bess_claim_ingest[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(migration, /grant execute on function public\.bess_claim_ingest[\s\S]*?to service_role;/i);
  assert.match(verification, /缺少原子接单 RPC bess_claim_ingest/);
  assert.match(verification, /PUBLIC 仍可执行 bess_claim_ingest/);
});


const outboxMigration = readFileSync(new URL('../db/migrations/20260915_dispatch_outbox.sql', import.meta.url), 'utf8');
const outboxRunbook = readFileSync(new URL('../docs/dispatch-outbox-migration.md', import.meta.url), 'utf8');

test('outbox migration 包含原子入队、租约 claim、提交、重试与恢复 RPC', () => {
  for (const name of [
    'bess_enqueue_dispatch_outbox', 'bess_claim_dispatch_outbox',
    'bess_complete_dispatch_outbox', 'bess_retry_dispatch_outbox', 'bess_nudge_dispatch_outbox',
  ]) assert.match(outboxMigration, new RegExp(`create or replace function public\\.${name}\\(`, 'i'));
  assert.match(outboxMigration, /for update skip locked/i);
  assert.match(outboxMigration, /'status', case when p_dead then 'DEAD' else 'RETRY' end/i);
  assert.match(outboxMigration, /pending\.request_context ->> 'operationId' = p_operation_id/i);
  assert.match(outboxMigration, /grant execute[\s\S]*?to service_role/i);
});

test('outbox migration runbook 包含部署顺序、验证及回滚', () => {
  assert.match(outboxRunbook, /部署顺序/);
  assert.match(outboxRunbook, /验证/);
  assert.match(outboxRunbook, /回滚/);
  assert.match(outboxRunbook, /drop function/i);
});
