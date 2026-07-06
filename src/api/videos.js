import { authHeaders, requestJson } from './client';

export function fetchVideos() {
  return requestJson('/api/videos');
}

export function createVideo(data, token) {
  return requestJson('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function updateVideo(id, data, token) {
  return requestJson(`/api/videos/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(data),
  });
}

export function deleteVideo(id, token) {
  return requestJson(`/api/videos/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(token) },
  }).catch((err) => {
    if (err.status && err.status >= 400) throw err;
    return true;
  });
}
