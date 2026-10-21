# Gate 1 → Vercel Queue 恢复闭环

## 状态判定

持久化 handoff 是唯一恢复事实源，`operation_id` 在登记、Queue 消息、Outbox 和发卡 UUID 间保持不变。

- `CONFIRMED`：同一 `operation_id` 已进入 `QUEUED / RETRY / PROCESSING / SENT / DEAD`，不得再次发布 Queue。
- `SAFE_TO_RETRY`：仅限尚无任何 publish claim 证据的 `HANDOFF_PENDING`，或已持久化 `authoritativeNonAcceptance=true` 的确定拒绝；恢复仍须原子 claim。
- `NEEDS_RECONCILIATION`：publish 超时、网络失败、publish 成功但确认落库失败，或已有 publish claim 证据。可能已经越过入队边界，自动恢复和人工入口均禁止盲目重发，等待晚到确认或人工对账。

自动 reconciler 只重放 `SAFE_TO_RETRY`，并复用持久化 Queue 消息与原 `operation_id`。不确定结果保留审计时间、claim、错误和重试次数，不回退 operation identity。

## 运维入口

入口复用现有动态函数，不新增 Vercel Function：`/api/dispatch/handoff-recovery`。使用 `Authorization: Bearer $CRON_SECRET`，响应均 `Cache-Control: no-store`。

### 只读探测

```http
GET /api/dispatch/handoff-recovery?chat_id=<chat>&batch_id=<batch>
Authorization: Bearer <CRON_SECRET>
```

返回 `classification`、`reason`、`operation_id` 和脱敏审计 evidence。该操作不 claim、不写库、不入队、不发卡。

### 受控恢复

```http
POST /api/dispatch/handoff-recovery
Authorization: Bearer <CRON_SECRET>
Content-Type: application/json

{
  "chat_id": "...",
  "batch_id": "...",
  "operation_id": "探测返回的原值",
  "recovery_action": "retry_if_safe"
}
```

安全边界：

1. 必须显式携带并精确匹配原 `operation_id`；
2. 仅 `SAFE_TO_RETRY` 可发布；`NEEDS_RECONCILIATION` 返回 409 且零副作用；
3. 并发调用由现有 handoff publish lease/CAS 保证只有一个发布者；
4. 发布或确认结果再次不确定时只写 `ACCEPTED_UNKNOWN`，不会继续重发；
5. `dry_run=true` 仅做鉴权、解码、规范化和卡片构建，不创建 store、不持久化、不入队、不发卡。

## 对账建议

对 `NEEDS_RECONCILIATION`，先按 `operation_id` 检查 Vercel Queue/consumer 日志和 Supabase 状态。若看到 `QUEUED/PROCESSING/SENT`，等待状态收敛；不要改 `batch_id` 或绕过 Queue 直接发卡。只有能够形成权威“未接收”证据并由既有状态机持久化后，才可使用 `retry_if_safe`。
