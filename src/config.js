// 全局运行时配置
// 后端 API 地址通过环境变量注入，方便本地开发 / 预发 / 正式环境切换。
// - 本地：在项目根目录创建 .env.local，写入 VITE_API_URL=http://localhost:3000
// - 生产：默认走线上 Vercel 部署地址
const env = import.meta.env || {};

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback).trim().replace(/\/+$/, '');
}

export const API_BASE = normalizeBaseUrl(
  env.VITE_API_URL,
  'https://api.littlearisa88.com'
);

// 书籍封面函数跟随本仓库的 Vercel 部署，不使用 GitHub Pages 同域 /api。
// 单独配置可避免把内容后端与封面代理错误地指向同一个项目。
export const BOOK_COVER_API_BASE = normalizeBaseUrl(
  env.VITE_BOOK_COVER_API_URL,
  'https://www.littlearisa88.com'
);

// 阿丽莎记忆由本仓库的 Vercel Functions 提供，与内容后端解耦。
export const ALISHA_MEMORY_API_BASE = normalizeBaseUrl(
  env.VITE_ALISHA_MEMORY_API_URL,
  BOOK_COVER_API_BASE
);
