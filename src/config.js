// 全局运行时配置
// 后端 API 地址通过环境变量注入，方便本地开发 / 预发 / 正式环境切换。
// - 本地：在项目根目录创建 .env.local，写入 VITE_API_URL=http://localhost:3000
// - 生产：默认走线上 Vercel 部署地址
export const API_BASE =
  import.meta.env.VITE_API_URL || 'https://api.littlearisa88.com';
