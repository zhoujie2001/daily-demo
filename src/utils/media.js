import { API_BASE } from '../config';

/**
 * 归一化媒体资源 URL：
 * - 已经是绝对 URL：原样返回
 * - 本地静态素材（images/xxx、videos/xxx）：原样返回
 * - 相对后端路径：拼接 API_BASE
 */
export function resolveMediaUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/images/') || url.startsWith('/videos/')) {
    // Determine the base path based on environment
    // In production, GitHub Pages requires the repo name as the base path
    const isProduction = import.meta.env.PROD;
    const basePath = isProduction && window.location.hostname.includes('github.io')
      ? '/personal-site'
      : '';
    return `${basePath}${url}`;
  }
  if (url.startsWith('images/') || url.startsWith('videos/')) {
    const isProduction = import.meta.env.PROD;
    const basePath = isProduction && window.location.hostname.includes('github.io')
      ? '/personal-site'
      : '';
    return `${basePath}/${url}`;
  }
  const prefix = url.startsWith('/') ? '' : '/';
  return `${API_BASE}${prefix}${url}`;
}
