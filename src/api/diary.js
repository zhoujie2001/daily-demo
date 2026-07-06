import { authHeaders, requestJson } from './client';

export function fetchDiary() {
  return requestJson('/api/diary');
}

export function createDiary(data, token) {
  return requestJson('/api/diary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function updateDiary(id, data, token) {
  return requestJson(`/api/diary/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function deleteDiary(id, token) {
  return requestJson(`/api/diary/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(token) },
  }).catch((err) => {
    // DELETE 有些实现不返回 body，容错一下
    if (err && err.status === undefined) throw err;
    if (err.status && err.status >= 400) throw err;
    return true;
  });
}
