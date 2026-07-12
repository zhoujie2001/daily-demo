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
    // Vercel deployment uses root mapping, so we don't need the repository prefix
    // Only add prefix if it's deployed to GitHub Pages non-custom domain
    const isProduction = import.meta.env.PROD;
    const isGithubPagesUrl = isProduction && window.location.hostname === 'zhoujie2001.github.io';
    const basePath = isGithubPagesUrl ? '/personal-site' : '';
    return `${basePath}${url}`;
  }
  if (url.startsWith('images/') || url.startsWith('videos/')) {
    const isProduction = import.meta.env.PROD;
    const isGithubPagesUrl = isProduction && window.location.hostname === 'zhoujie2001.github.io';
    const basePath = isGithubPagesUrl ? '/personal-site' : '';
    return `${basePath}/${url}`;
  }
  const prefix = url.startsWith('/') ? '' : '/';
  return `${API_BASE}${prefix}${url}`;
}
