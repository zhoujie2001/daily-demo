# Daily Demo · 周杰 / Dylan 的个人博客

一个基于 **React + Vite** 的个人博客前端，聚合 About / Daily / Reading / Travel / Photography / Links 六个板块，
并支持管理员登录后进行内容管理。前端部署在 GitHub Pages，后端部署在 Vercel（本仓库不含后端源码）。

- 线上地址：<https://zhoujie2001.github.io/daily-demo/>
- 后端地址：<https://daily-demo-backend.vercel.app/>

## 目录结构

```text
src/
├── App.jsx                # 顶层布局：Sidebar + 各 section
├── main.jsx               # React 入口
├── index.css              # 全局样式
├── config.js              # API_BASE 配置（读取 VITE_API_URL）
├── api/                   # 纯请求层（auth / diary / photos / videos / upload）
├── hooks/                 # 业务 Hook（useAdminAuth / useDiary / usePhotos / useVideos / useHorizontalAutoScroll）
├── utils/                 # 工具函数（媒体 URL 归一化等）
├── data/                  # 本地静态数据 & 兜底列表
└── components/            # UI 组件
    ├── AdminLogin.jsx
    ├── Sidebar.jsx
    ├── About.jsx
    ├── Reading.jsx
    ├── Links.jsx
    ├── Lightbox.jsx
    ├── daily/             # Daily 板块（时间线 / 内容流 / 编辑器）
    ├── travel/            # Travel 视频轨道
    └── photography/       # Photography 照片墙
```

## 技术栈

- React 19 + Vite 6
- Lucide React（图标）
- Tailwind CSS 4（已接入，尚未大规模使用）
- Framer Motion（预留）
- ESLint 9

## 环境变量

复制 `.env.example` 为 `.env.local` 并按需修改：

```bash
cp .env.example .env.local
```

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `VITE_API_URL` | 后端 API 根地址（不含末尾斜杠） | `https://daily-demo-backend.vercel.app` |
| `VITE_BOOK_COVER_API_URL` | 本仓库 Vercel 书籍搜索与封面代理地址 | `https://www.littlearisa88.com` |

## 本地开发

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址即可。若后端不可用，页面会自动回退到本地静态数据继续展示。

## 生产构建

```bash
npm run build       # 构建到 dist/
npm run preview     # 本地预览生产产物
```

## 部署

- **推荐**：推送到 `main` 分支后由 `.github/workflows/deploy.yml` 自动构建并发布到 GitHub Pages。
- **备用**：本地执行 `npm run deploy` 使用 gh-pages 手动发布。

## 管理员模式

- 双击左侧栏或主页顶部的名字标题（`周杰 / Dylan`）即可唤出管理员登录弹窗。
- 用户名与密码由用户在弹窗中输入，源码中不再保留任何默认账号。
- 登录后会把 JWT 写入 `localStorage.adminToken`，后续管理操作会自动带 `Authorization: Bearer <token>`。
- 点击左侧栏的 `Logout` 可退出登录。

## 数据接口

前端已接入的后端接口（详见 `src/api/`）：

- `POST /api/auth/login`
- `GET/POST/PUT/DELETE /api/diary[/:id]`
- `GET/POST/PUT/DELETE /api/photos[/:id]`
- `GET/POST/PUT/DELETE /api/videos[/:id]`
- `POST /api/upload`

阿丽莎云端记忆由本仓库的 Vercel Functions 提供：

- `GET /api/alisha/memory/profile`
- `POST /api/alisha/memory/events`
- `GET /api/alisha/memory/recommendation`
- `POST /api/alisha/memory/feedback`
- `DELETE /api/alisha/memory`

部署配置、签名访客会话、分布式限流和自动清理见 `docs/alisha-memory-backend-contract.md`。

飞书卡片回调由 `POST /api/lark/callback` 接收。当前版本已实现 BESS P1 自动派单闭环：

- 首次点击在原卡片下创建话题并发送 Card JSON 2.0 名单表单，真实姓名支持逗号、顿号、分号、换行分隔，拒绝纯数字/工号；
- 名单使用 Node.js `crypto.randomInt` 做 Fisher–Yates 安全随机打乱，仅在 Asia/Shanghai 当日有效；请求惰性清理，Vercel Cron 每日 00:10 调用 `/api/cron/bess-dispatch-cleanup`；
- 千川按黄色正序轮转；本地推、本地、存量、其它、EHC 按蓝色倒序轮转，两套游标互不影响；首次表单提交会立即处理最初需求且不读表格锚点；当天名单已存在的后续派单会按日期筛选表格当天记录，从末行向上取首个仍在 roster 的人工负责人，并沿业务方向派给下一位，无有效锚点时回退原游标；
- Supabase 继续使用现有 `bess_assign_next` RPC 完成游标递增与 assignment 幂等写入；后续派单找到人工锚点时，服务端先按 `day_key + request_id` 查询 assignment，重放请求直接交给 RPC 返回原结果，新请求才通过 REST 将对应方向游标校准到锚点下一位后调用 RPC。该锚点能力不需要数据库 schema 或 RPC 迁移；
- 按 `action.value` 中的 `sheet_url`、`sheet_id`、`row_index` 写回电子表格。负责人列优先使用 `assignee_field_id`（列字母），否则按 `assignee_field_name` 查首行；日期列同理使用 `date_field_id` / `date_field_name`。旧卡会按固定工作表补缺省列：`TQuzLA` 为 H「提需时间」/J「执行人」，`p7Wqx4` 日期为 D「创建时间」；写入后 GET 回读完全一致才成功；
- 成功后原按钮置灰为「✅ 已派单」，话题结果卡展示负责人、方向及完整正/倒序彩色名单；回调在 3 秒内响应，超时后通过 `waitUntil` 继续可靠执行，`api/lark/callback.js` 的 Vercel `maxDuration` 为 30 秒；每个 Supabase/飞书调用仍有独立有界超时，失败可幂等重试。

### P1 部署步骤

1. 在 Supabase SQL Editor 先执行主迁移 [`db/bess-dispatch.sql`](db/bess-dispatch.sql)，再执行只读验收脚本 [`db/bess-dispatch-verify.sql`](db/bess-dispatch-verify.sql)。主迁移可安全重复执行，不删除或覆盖已有业务数据；它会创建或补齐 daily state、pending form、assignments 和保持现有 Node 调用签名的 `bess_assign_next` 原子 RPC，并对三张表启用及强制 RLS，仅向 `service_role` 授予必要的表、序列和 RPC 权限。验收脚本不会修改数据库，会检查结构、约束、索引、RLS、策略、权限以及 RPC 属性和返回结构，不符合预期时会集中抛错。pending 仅在表格写回、结果卡发送和原卡更新全部成功后标记完成，失败重试会复用原 assignment 与原消息关联。
2. 在 Vercel 配置 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET`、`LARK_VERIFICATION_TOKEN`、`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_ENCRYPT_KEY`、`LARK_DISPATCH_ALLOWED_CHAT_IDS`。服务端变量禁止加 `VITE_` 前缀。
3. 飞书应用需开通消息读取/回复/更新、卡片回调，以及电子表格读取和写入权限；目标表格必须授权给该应用。
4. 按钮 `action.value` 必须携带 `request_id`、`request_name`、`business_type`、`sheet_url`、`sheet_id`、`row_index`，以及 `assignee_field_id`（推荐，列字母）或 `assignee_field_name`；新卡同时应携带 `date_field_id`（推荐）或 `date_field_name`，上述固定工作表的旧卡可由服务端补齐日期列。
5. 部署后确认 Vercel Cron 已注册；其 cron 表达式 `10 16 * * *` 为 UTC 16:10，即上海时间次日 00:10。Vercel 会自动用 `Authorization: Bearer $CRON_SECRET` 调用。

回调完成 URL 验证、Verification Token / App ID 校验和加密载荷解密；业务错误保持 HTTP 200 + Toast，鉴权错误才返回 4xx。日志只记录脱敏业务字段，不记录 Token、Secret 或 service role key。

## 兜底策略

- Daily：后端不可用时回退到 `src/data/dailyData.json`
- Photography / Travel：后端返回空时展示 `public/images` / `public/videos` 中的静态素材
