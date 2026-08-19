# 阿丽莎规则型云端记忆 · 后端契约 v1

本文档对应主站前端的 `src/api/alishaMemory.js`。可部署的服务端实现位于 `server/alishaMemoryService.js`、`server/alishaMemoryApi.js` 与 `api/alisha/memory/`，默认通过 Supabase Postgres 持久化，并与内容后端保持解耦。

部署前先在 Supabase SQL Editor 执行 `db/alisha-memory.sql`，然后为 Vercel 配置 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`ALISHA_CONTENT_API_URL` 和 `ALISHA_ALLOWED_ORIGINS`。主站使用 `VITE_ALISHA_MEMORY_API_URL` 指向 Functions 部署地址。

## 产品边界

- 匿名访客 ID 只用于记忆连续性，不代表登录或身份认证。
- v1 只召回已经通过公开内容接口返回的 Daily，不能借推荐接口暴露私密或未发布内容。
- 应用层不保存原始 IP、完整 User-Agent、精确位置或用户输入正文。
- 每位访客每天最多投递一条记忆；同一内容 30 天内不重复。
- 事件明细保留 90 天；聚合档案在 180 天无访问后删除。

## PostgreSQL 数据表

以 `db/alisha-memory.sql` 为唯一可执行版本。下面的结构只用于阅读说明。

实际结构包含访客档案、幂等事件和记忆投递三张表，并启用 RLS。浏览器没有任何表级访问策略，只有 Vercel Functions 持有的 service role 可以读写。生产迁移应执行版本化 SQL，不在请求期间运行 DDL。

## 身份与请求约束

前端在 `X-Alisha-Visitor-Id` 中发送 UUID。服务端必须：

1. 严格校验 UUID；无效值返回 `400`。
2. 将它视为匿名分区键，而不是授权凭据。
3. 对单 IP 和单 visitor ID 分别限流。
4. CORS 仅允许主站正式域名，并允许 `X-Alisha-Visitor-Id` 请求头。
5. 任何接口都不得依靠该 ID 返回非公开内容或管理员信息。

如后续需要跨设备同步，应使用正式登录身份建立单独的 `user_id` 关联，不应把匿名 UUID 升格为账号凭据。

## API

### `GET /api/alisha/memory/profile`

```json
{
  "profile": {
    "version": 1,
    "firstSeenAt": "2026-08-18T02:00:00.000Z",
    "lastSeenAt": "2026-08-18T02:00:00.000Z",
    "visitDays": ["2026-08-18"],
    "sectionVisits": { "daily": 4, "photography": 2 },
    "deliveries": []
  }
}
```

### `POST /api/alisha/memory/events`

一次最多接收 20 条事件；`eventId` 用于幂等去重。允许的类型仅为：

- `session_started`
- `session_ended`
- `section_viewed`
- `memory_delivered`

未知字段应丢弃，`context` 序列化后不得超过 2 KB。

### `GET /api/alisha/memory/recommendation?section=daily&day=2026-08-18`

服务端先做可见性过滤，再按下列规则评分：

```text
同月同日 +52
长期未浏览，最高 +28
包含公开媒体，最高 +8
匹配高频栏目/标签，最高 +12
30 天内已经投递：淘汰
当天已经投递：不返回推荐
```

无候选时返回 `204`；有候选时返回：

```json
{
  "recommendation": {
    "id": "delivery-or-memory-id",
    "contentId": "post-42",
    "title": "阿丽莎想起了一天",
    "excerpt": "那天下午成都下了一场很慢的雨……",
    "reason": "同一天，不同年份"
  }
}
```

### `POST /api/alisha/memory/feedback`

请求体为 `{ "memoryId": "...", "action": "opened|dismissed" }`。只能更新当前访客自己的投递记录。

### `DELETE /api/alisha/memory`

在一个事务内删除该访客的档案、事件和投递记录，成功返回 `204`。前端加入记忆设置入口时，应同时清除本机 `daily-demo-alisha-memory-v1` 与 `daily-demo-alisha-visitor-v1`。

## 推荐质量与监控

- 北极星指标：打开记忆后停留超过 20 秒、打开媒体或继续访问相关内容的次数。
- 保护指标：当日关闭率、七日重复率、接口错误率和推荐空结果率。
- 目标：同一访客连续 10 次推荐的内容重复率低于 15%，接口失败时前端必须无感降级到本地规则。
