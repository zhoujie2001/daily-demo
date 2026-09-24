# Dispatch Outbox 可选迁移与回滚

## 兼容性与部署顺序

应用可以先于数据库迁移部署。`/send` 先将任务持久发布到 Vercel Queue，私有 consumer 再将任务写入 Supabase Outbox 并发送 Lark 卡片。Supabase 慢查询和 Lark 发卡不再位于 `/send` 请求链路中。

所有 Outbox 操作会优先调用 RPC；PostgREST 返回函数不存在（HTTP 404 / `PGRST202`）时，自动降级到现有 `bess_dispatch_pending_forms` 表的 REST/CAS 路径：

- `/send` 仍可幂等入队，不因 RPC 缺失失败；
- worker 使用 `status + operationId + workerToken + leaseExpiresAt` 条件 PATCH 抢租约；
- 成功、重试和 DEAD 均写回原行 `request_context`；
- 稳定 `operation_id` 同时作为 Lark `uuid`，在 REST claim 竞争或 complete 超时恢复时最终防重。

因此 `db/migrations/20260915_dispatch_outbox.sql` **不是部署前硬依赖**。它只增加表达式索引和原子 RPC，用于提高扫描性能、减少 REST 往返并强化数据库侧原子性。推荐顺序：

1. 部署应用，确认 Vercel Queue consumer 已注册且 REST fallback 正常；
2. 有生产 Supabase 权限时执行 migration；
3. 无需再次发版，应用会自动使用 RPC 快路径。

## 验证

1. 未执行 migration 的环境：让五个 RPC 返回 404/`PGRST202`，用唯一 `batch_id` 调用 `/send`，确认快速返回 `202/QUEUED + operation_id`，并确认并发 consumer 只有一个获得同一 Supabase 租约。
2. 执行 migration 后，确认五个 RPC 均存在且只有 `service_role` 可执行：
   - `bess_enqueue_dispatch_outbox`
   - `bess_claim_dispatch_outbox`
   - `bess_complete_dispatch_outbox`
   - `bess_retry_dispatch_outbox`
   - `bess_nudge_dispatch_outbox`
3. 确认 `api/cron/bess-dispatch-outbox.js` 在 Vercel 中显示为 `bess-dispatch-v2` 的私有 Queue consumer。它没有公网 URL，不要将该路径当作 Cron 手工调用。`bess-dispatch-cleanup` 每日 Cron 会额外尝试恢复 1 条已持久化的 Outbox 任务。
4. 用签名的尚未物化批次调用 `/api/dispatch/status`，确认有界返回 `200/QUEUED + found=false + transient=true`。
5. 用测试群的唯一 `batch_id` 调用 `/send`，确认先返回 `202/QUEUED + operation_id`，随后 `/status` 返回 `SENT + operation_id + message_id`。
6. 重放同一 `chat_id + batch_id`，确认 `operation_id` 和最终 `message_id` 不变，群内只有一张卡。

## 调用方契约

- `/send` 返回 `202/QUEUED` 表示队列已持久接受，调用方应轮询 `/status`；
- `/send` 返回 `503/DISPATCH_QUEUE_TIMEOUT` 且 `accepted_unknown=true` 时，仍使用原 `batch_id` 查询或重试，禁止换新批次或直接发卡；
- `/status` 返回 `503/STATUS_TEMPORARILY_UNAVAILABLE` 只代表 Supabase 状态链路短暂不可用，不代表发卡失败，不允许触发冗余直发；
- Vercel Queue 提供 at-least-once 投递，Supabase Outbox CAS 和 Lark 稳定 `uuid=operation_id` 共同承担幂等防重。

## 延迟快路径与可观测性

`/status` 使用 Vercel Runtime Cache 作为可丢失的区域热状态层，Supabase 仍是唯一持久事实源：

- `/send` 在 Queue 接受后缓存 `QUEUED` 15 秒；幂等重放不会用 `QUEUED` 覆盖既有终态；
- consumer 只有在 Supabase 成功提交状态后才缓存 `SENT`、`RETRY` 或 `DEAD`；
- `SENT` 缓存 24 小时，失败终态缓存 5 分钟，中间态缓存 15 秒；
- Cache miss、超时或错误均 fail-open 到 Supabase，不会改变幂等与最终一致性；
- 缓存中的中间态只负责快速响应，不会在每次轮询时触发数据库恢复；缓存过期并读到 Supabase 中间态后才会用 `waitUntil` 唤醒恢复，避免轮询风暴。

生产函数和 Queue 固定在 `hnd1`，与东京 Supabase (`ap-northeast-1`) 保持邻近。除非生产数据库迁区，否则不要单独修改函数区域。

响应诊断字段：

- `/send` 的 `Server-Timing` 包含 `auth`、`enrich`、`queue`、`cache` 和 `total`；
- `/status` 的 `Server-Timing` 包含 `auth`、`cache`，缓存未命中时另含 `database`；
- `/status` 的 `X-Bess-Status-Source` 为 `runtime-cache` 或 `supabase`；
- worker 日志包含 `claim_duration_ms`、`lark_duration_ms`、`completion_duration_ms`，数据库请求日志继续包含 `operation`、`duration_ms`、`timeout_ms` 和脱敏 request id。

上线验收建议连续采样至少 30 次，冷热请求各占一半：

| 指标 | 目标 | 失败判定 |
| --- | --- | --- |
| `/send` Queue 接受 P95 | `< 3s` | P95 `>= 5s` 或出现同步 Lark/Supabase 调用 |
| `/status` Cache hit P95 | `< 300ms` | P95 `>= 1s` 或仍出现数据库日志 |
| `/status` Cache miss 总时长 | `< 1.8s` | 超过约 1.8 秒仍未返回可重试结果 |
| `QUEUED → SENT` P95 | `< 15s` | 长期停留中间态或产生重复卡片 |
| 幂等重放 | 同一 `operation_id/message_id` | 群内出现第二张卡或终态被回退 |

Runtime Cache 命中率和错误应在 Vercel **Observability → Runtime Cache** 查看。缓存不是持久队列，禁止用它替代 Vercel Queue 或 Supabase Outbox。

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
