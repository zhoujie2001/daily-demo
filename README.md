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

## 兜底策略

- Daily：后端不可用时回退到 `src/data/dailyData.json`
- Photography / Travel：后端返回空时展示 `public/images` / `public/videos` 中的静态素材
