import { apiUrl, authHeaders } from './client';

/**
 * 上传单个/多个文件到后端 /api/upload 接口。
 * 返回后端给出的 URL 数组。
 */
export async function uploadFiles(files, token) {
  const formData = new FormData();
  const list = Array.isArray(files) ? files : [files];
  list.forEach((file) => formData.append('files', file));

  const res = await fetch(apiUrl('/api/upload'), {
    method: 'POST',
    headers: { ...authHeaders(token) },
    body: formData,
  });
  if (!res.ok) {
    const err = new Error(`Upload failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.urls || [];
}
