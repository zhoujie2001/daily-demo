import { authHeaders, requestJson } from './client';

export async function searchBookCovers({ title = '', author = '', isbn = '' }) {
  const params = new URLSearchParams();
  if (title.trim()) params.set('title', title.trim());
  if (author.trim()) params.set('author', author.trim());
  if (isbn.trim()) params.set('isbn', isbn.trim());

  const response = await fetch(`/api/book-search?${params}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `封面搜索失败: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return Array.isArray(data.candidates) ? data.candidates : [];
}

export function fetchBooks() {
  return requestJson('/api/reading');
}

export function createBook(data, token) {
  return requestJson('/api/reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function updateBook(id, data, token) {
  return requestJson(`/api/reading/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function deleteBook(id, token) {
  return requestJson(`/api/reading/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(token) },
  }).catch((err) => {
    if (err && err.status === undefined) throw err;
    if (err.status && err.status >= 400) throw err;
    return true;
  });
}
