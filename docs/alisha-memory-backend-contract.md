# 阿丽莎规则型云端记忆 · 后端契约 v1

本文档对应主站前端的 `src/api/alishaMemory.js`。可部署的服务端实现位于 `server/alishaMemoryService.js`、`server/alishaMemoryApi.js` 与 `api/alisha/memory/`，默认通过 Supabase Postgres 持久化，并与内容后端保持解耦。

部署前先在 Supabase SQL Editor 执行 `db/alisha-memory.sql`；已部署 v1 的环境执行增量迁移 `db/alisha-memory-hardening.sql`。Vercel 需要配置 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`ALISHA_CONTENT_API_URL`、`ALISHA_ALLOWED_ORIGINS`、`ALISHA_VISITOR_SIGNING_SECRET`、`ALISHA_RATE_LIMIT_SALT`、`ALISHA_LEGACY_ID_CUTOFF` 和 `CRON_SECRET`。主站使用 `VITE_ALISHA_MEMORY_API_URL` 指向 Functions 部署地址。

## 产品边界

- 匿名访客 ID 只用于记忆连续性，不代表登录账号；服务端通过 HMAC 签名的 HttpOnly Cookie 防止客户端任意冒用其他 UUID。
- v1 只召回已经通过公开内容接口返回的 Daily，不能借推荐接口暴露私密或未发布内容。
- 应用层不保存原始 IP、完整 User-Agent、精确位置或用户输入正文。
- 每位访客每天最多投递一条记忆；同一内容 30 天内不重复。
- 事件明细保留 90 天；聚合档案在 180 天无访问后删除。

## PostgreSQL 数据表

以 `db/alisha-memory.sql` 为唯一可执行版本。下面的结构只用于阅读说明。

实际结构包含访客档案、幂等事件和记忆投递三张表，并启用 RLS。浏览器没有任何表级访问策略，只有 Vercel Functions 持有的 service role 可以读写。生产迁移应执行版本化 SQL，不在请求期间运行 DDL。

## 身份与请求约束

前端先调用 `POST /api/alisha/memory/identity` 建立签名会话。服务端将 UUID 写入 180 天有效的 HttpOnly Cookie；普通记忆接口只接受该 Cookie，不再信任客户端请求头。`X-Alisha-Visitor-Id` 只在 `ALISHA_LEGACY_ID_CUTOFF` 之前用于一次性迁移已有匿名档案。

服务端必须：

1. 使用至少 32 字符的服务器密钥签名 Cookie，并以常量时间比较签名。
2. 将 UUID 视为匿名分区键，不把它升级为登录账号。
3. 使用 Supabase 原子计数器对单 IP 和单 visitor ID 分别限流；数据库只保存 IP 的 HMAC，不保存原始 IP。
4. CORS 仅允许主站正式域名，并只对精确来源启用凭据。
5. 任何接口都不得返回非公开内容或管理员信息。
6. 数据表与限流函数仅向 `service_role` 授权，浏览器端不持有数据库密钥。

如后续需要跨设备同步，应使用正式登录身份建立单独的 `user_id` 关联，不应把匿名 UUID 升格为账号凭据。

### `POST /api/alisha/memory/identity`

建立或续期匿名签名会话，返回 `{ "visitorId": "..." }`。已有 Cookie 有效时沿用原 UUID；没有 Cookie 时仅在迁移截止时间之前接受旧请求头，否则生成新的 UUID。

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

### `GET /api/alisha/memory/cleanup`

只接受 Vercel Cron 自动发送的 `Authorization: Bearer <CRON_SECRET>`。每天清理 90 天前的事件、180 天前未活跃的档案和投递，以及两天前的限流窗口。未携带正确密钥返回 `401`。

## 推荐质量与监控

- 北极星指标：打开记忆后停留超过 20 秒、打开媒体或继续访问相关内容的次数。
- 保护指标：当日关闭率、七日重复率、接口错误率和推荐空结果率。
- 目标：同一访客连续 10 次推荐的内容重复率低于 15%，接口失败时前端必须无感降级到本地规则。
