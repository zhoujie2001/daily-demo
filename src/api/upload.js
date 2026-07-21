import { apiUrl, authHeaders } from './client';

/**
 * 上传单个/多个文件到后端 /api/upload 接口。
 * 返回后端给出的 URL 数组。
 */
const DEFAULT_UPLOAD_TIMEOUT = 3 * 60 * 1000;

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function uploadFiles(files, token, { timeoutMs = DEFAULT_UPLOAD_TIMEOUT } = {}) {
  const formData = new FormData();
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (list.length === 0) {
    throw new Error('没有可上传的文件');
  }
  list.forEach((file) => formData.append('files', file, file.name));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(apiUrl('/api/upload'), {
      method: 'POST',
      headers: { ...authHeaders(token) },
      body: formData,
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      throw new Error(`上传超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试`, { cause });
    }
    throw new Error('上传请求失败，请检查网络或 API 跨域配置', { cause });
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await res.text();
  const data = parseJson(responseText);
  if (!res.ok) {
    const detail = data?.message || data?.error || responseText.slice(0, 160);
    const err = new Error(detail || `文件上传失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }

  if (!data) {
    throw new Error('上传接口返回了无法解析的响应');
  }
  const urls = Array.isArray(data.urls) ? data.urls : [];
  if (urls.length !== list.length || urls.some((url) => !url)) {
    throw new Error(`上传接口返回异常：提交 ${list.length} 个文件，只收到 ${urls.length} 个地址`);
  }
  return urls;
}
