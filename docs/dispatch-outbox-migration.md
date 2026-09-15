# Dispatch Outbox 迁移与回滚

## 部署顺序

1. 在生产 Supabase SQL Editor 以事务执行 `db/migrations/20260915_dispatch_outbox.sql`。
## 验证

1. 确认五个 RPC 均存在且只有 `service_role` 可执行：
   - `bess_enqueue_dispatch_outbox`
   - `bess_claim_dispatch_outbox`
   - `bess_complete_dispatch_outbox`
   - `bess_retry_dispatch_outbox`
   - `bess_nudge_dispatch_outbox`
3. 部署 Vercel 应用；确认 `/api/cron/bess-dispatch-outbox` 已注册为每分钟 Cron。
4. 用签名的不存在批次调用 `/api/dispatch/status`，确认有界返回 `found=false`。
5. 用测试群的唯一 `batch_id` 调用 `/send`，确认先返回 `202/SENDING + operation_id`，随后 `/status` 返回 `SENT + operation_id + message_id`。

迁移只增加表达式索引和 RPC，继续复用 `bess_dispatch_pending_forms`，不会删除、重命名或覆盖现有表列。旧的 `SENDING` 行在同一批次再次入队时原位升级成 Outbox 上下文。

## 回滚

先回滚 Vercel 到迁移前部署，再执行：

```sql
begin;
drop function if exists public.bess_nudge_dispatch_outbox(text,timestamptz);
drop function if exists public.bess_retry_dispatch_outbox(text,text,text,text,timestamptz,boolean);
drop function if exists public.bess_complete_dispatch_outbox(text,text,text,text,timestamptz);
drop function if exists public.bess_claim_dispatch_outbox(text,integer,integer,integer,timestamptz);
drop function if exists public.bess_enqueue_dispatch_outbox(text,text,text,text,text,jsonb,text,jsonb,text,timestamptz,timestamptz);
drop index if exists public.bess_dispatch_pending_forms_outbox_status_idx;
drop index if exists public.bess_dispatch_pending_forms_outbox_expiry_idx;
commit;
```

回滚不删除 `bess_dispatch_pending_forms` 中已有业务行。新版本写入的 `QUEUED/RETRY/PROCESSING/DEAD` 行会被旧版本视为未完成；如需重放，必须使用原 `batch_id + chat_id`，不得生成新批次。
