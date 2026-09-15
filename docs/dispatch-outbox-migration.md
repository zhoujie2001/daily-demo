# Dispatch Outbox 可选迁移与回滚

## 兼容性与部署顺序

应用可以先于数据库迁移部署。所有 Outbox 操作会优先调用 RPC；PostgREST 返回函数不存在（HTTP 404 / `PGRST202`）时，自动降级到现有 `bess_dispatch_pending_forms` 表的 REST/CAS 路径：

- `/send` 仍可幂等入队，不因 RPC 缺失失败；
- worker 使用 `status + operationId + workerToken + leaseExpiresAt` 条件 PATCH 抢租约；
- 成功、重试和 DEAD 均写回原行 `request_context`；
- 稳定 `operation_id` 同时作为 Lark `uuid`，在 REST claim 竞争或 complete 超时恢复时最终防重。

因此 `db/migrations/20260915_dispatch_outbox.sql` **不是部署前硬依赖**。它只增加表达式索引和原子 RPC，用于提高扫描性能、减少 REST 往返并强化数据库侧原子性。推荐顺序：

1. 部署应用并确认 REST fallback 正常；
2. 有生产 Supabase 权限时执行 migration；
3. 无需再次发版，应用会自动使用 RPC 快路径。

## 验证

1. 未执行 migration 的环境：让五个 RPC 返回 404/`PGRST202`，用唯一 `batch_id` 调用 `/send`，确认返回 `202/SENDING + operation_id`，并确认并发 worker 只有一个获得同一租约。
2. 执行 migration 后，确认五个 RPC 均存在且只有 `service_role` 可执行：
   - `bess_enqueue_dispatch_outbox`
   - `bess_claim_dispatch_outbox`
   - `bess_complete_dispatch_outbox`
   - `bess_retry_dispatch_outbox`
   - `bess_nudge_dispatch_outbox`
3. 确认 `/api/cron/bess-dispatch-outbox` 已注册为每日兜底 Cron（Hobby 计划不允许分钟级 Cron）；每次 `/send` 都会异步启动 worker，后续发送会顺带恢复旧任务，`/status` 只做 DB nudge。
4. 用签名的不存在批次调用 `/api/dispatch/status`，确认有界返回 `found=false`。
5. 用测试群的唯一 `batch_id` 调用 `/send`，确认先返回 `202/SENDING + operation_id`，随后 `/status` 返回 `SENT + operation_id + message_id`。

迁移继续复用 `bess_dispatch_pending_forms`，不会删除、重命名或覆盖现有表列。旧的 `SENDING` 行在同一批次再次入队时会通过带旧状态及 fingerprint 的条件 PATCH 原位升级为 Outbox 上下文。

## 回滚

应用不依赖 RPC，数据库增强可独立回滚，无需先回滚 Vercel：

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

回滚不删除 `bess_dispatch_pending_forms` 中已有业务行；应用会在下一次 RPC 404/`PGRST202` 后自动回到 REST/CAS 路径。已有 `QUEUED/RETRY/PROCESSING/DEAD` 行继续可恢复；如需重放，必须使用原 `batch_id + chat_id`，不得生成新批次。
