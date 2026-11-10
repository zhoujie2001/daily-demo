-- Isolated test schema extension. Load qianchuan-sql-baseline.sql first.
-- Pending columns mirror db/bess-dispatch.sql, enabling REAL root/handoff/outbox RPCs.
alter table public.bess_dispatch_pending_forms
  add column request_id text unique,
  add column original_message_id text,
  add column chat_id text,
  add column expires_at timestamptz,
  add column completed_at timestamptz,
  add column created_at timestamptz not null default now();
