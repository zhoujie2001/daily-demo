import { apiUrl, authHeaders } from './client';

/**
 * 上传单个/多个文件到后端 /api/upload 接口。
 * 返回后端给出的 URL 数组。
 */
export async function uploadFiles(files, token) {
  const formData = new FormData();
  const list = Array.isArray(files) ? files : [files];
  list.forEach((file) => formData.append('files', file, file.name));

  let res;
  try {
    res = await fetch(apiUrl('/api/upload'), {
      method: 'POST',
      headers: { ...authHeaders(token) },
      body: formData,
    });
  } catch (cause) {
    throw new Error('上传请求失败，请检查网络或 API 跨域配置', { cause });
  }
  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data.message || data.error || '';
    } catch {
      // The status code below is still useful when the server returns no JSON.
    }
    const err = new Error(detail || `文件上传失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const urls = Array.isArray(data.urls) ? data.urls : [];
  if (urls.length !== list.length || urls.some((url) => !url)) {
    throw new Error(`上传接口返回异常：提交 ${list.length} 个文件，只收到 ${urls.length} 个地址`);
  }
  return urls;
}
