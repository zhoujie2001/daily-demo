import { authHeaders, requestJson } from './client';

export function fetchPhotos() {
  return requestJson('/api/photos');
}

export function createPhoto(data, token) {
  return requestJson('/api/photos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function updatePhoto(id, data, token) {
  return requestJson(`/api/photos/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function deletePhoto(id, token) {
  return requestJson(`/api/photos/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(token) },
  }).catch((err) => {
    if (err.status && err.status >= 400) throw err;
    return true;
  });
}
