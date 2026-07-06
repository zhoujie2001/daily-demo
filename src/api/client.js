import { API_BASE } from '../config';

/** 拼接完整的 API URL */
export function apiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

/** 生成鉴权头 */
export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 通用 JSON 请求，非 2xx 会抛错 */
export async function requestJson(path, options = {}) {
  const res = await fetch(apiUrl(path), options);
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
