import { requestJson } from './client';

export function fetchPlaylist(id) {
  if (!id) {
    return Promise.reject(new Error('playlist id required'));
  }
  return requestJson(`/api/song?id=${encodeURIComponent(id)}`);
}
