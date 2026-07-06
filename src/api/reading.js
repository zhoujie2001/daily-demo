import { authHeaders, requestJson } from './client';

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
