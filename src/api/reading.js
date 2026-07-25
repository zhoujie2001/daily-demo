import { authHeaders, requestJson } from './client.js';
import { BOOK_COVER_API_BASE } from '../config.js';
import { searchPublicBookCovers } from '../utils/bookCoverLookup.js';

const BOOK_COVER_LOOKUP_VERSION = '20260725-1';

function resolveCoverUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return '';
  }
}

export async function searchServerBookCovers(
  { title = '', author = '', isbn = '' },
  options = {}
) {
  const params = new URLSearchParams();
  if (title.trim()) params.set('title', title.trim());
  if (author.trim()) params.set('author', author.trim());
  if (isbn.trim()) params.set('isbn', isbn.trim());
  params.set('v', options.lookupVersion || BOOK_COVER_LOOKUP_VERSION);

  const apiBase = String(options.apiBase || BOOK_COVER_API_BASE).replace(/\/+$/, '');
  const requestUrl = `${apiBase}/api/book-search?${params}`;
  const response = await (options.fetchImpl || fetch)(requestUrl, {
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `封面搜索失败: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const responseBase = response.url || requestUrl;
  return (Array.isArray(data.candidates) ? data.candidates : [])
    .map((candidate) => ({
      ...candidate,
      coverUrl: resolveCoverUrl(candidate.coverUrl, responseBase),
    }))
    .filter((candidate) => candidate.coverUrl);
}

export async function searchBookCovers({ title = '', author = '', isbn = '' }, options = {}) {
  const query = { title, author, isbn };
  let serverResponded = false;
  let serverSearchError = null;
  let publicSearchError = null;

  try {
    const candidates = await searchServerBookCovers(query, options);
    serverResponded = true;
    if (candidates.length) return candidates;
  } catch (error) {
    serverSearchError = error;
  }

  try {
    const candidates = await searchPublicBookCovers(query, options);
    if (candidates.length) return candidates;
    return [];
  } catch (error) {
    publicSearchError = error;
  }

  // 服务端已经正常响应但没有候选时，说明只是没找到匹配项；
  // 不要把浏览器直连公共书库失败误报成“封面服务无法连接”。
  if (serverResponded) return [];
  throw serverSearchError || publicSearchError || new Error('暂时无法连接书籍封面服务');
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
