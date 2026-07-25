const GOOGLE_BOOKS_ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_ENDPOINT = 'https://openlibrary.org/search.json';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 80;
const resultCache = new Map();

function cleanInput(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeBookLookupText(value) {
  return cleanInput(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[《》〈〉「」『』“”"'’·:：,，.。!！?？()（）[\]【】\s_-]+/g, '');
}

function normalizeIsbn(value) {
  return cleanInput(value, 32).toUpperCase().replace(/[^0-9X]/g, '');
}

function getYear(value) {
  const match = String(value || '').match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : '';
}

function firstIsbn(identifiers = []) {
  const isbn13 = identifiers.find((entry) => entry?.type === 'ISBN_13')?.identifier;
  const isbn10 = identifiers.find((entry) => entry?.type === 'ISBN_10')?.identifier;
  return normalizeIsbn(isbn13 || isbn10 || '');
}

function normalizeImageUrl(rawUrl) {
  const value = cleanInput(rawUrl, 2000);
  if (!value) return '';

  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function imageFromGoogle(volumeInfo = {}) {
  const links = volumeInfo.imageLinks || {};
  return links.extraLarge
    || links.large
    || links.medium
    || links.small
    || links.thumbnail
    || links.smallThumbnail
    || '';
}

function mapGoogleCandidate(item) {
  const info = item?.volumeInfo || {};
  const coverUrl = normalizeImageUrl(imageFromGoogle(info));
  if (!item?.id || !info.title || !coverUrl) return null;

  return {
    id: `google:${item.id}`,
    source: 'google',
    sourceId: item.id,
    title: cleanInput(info.title),
    authors: Array.isArray(info.authors)
      ? info.authors.map((name) => cleanInput(name, 100)).filter(Boolean)
      : [],
    year: getYear(info.publishedDate),
    isbn: firstIsbn(info.industryIdentifiers),
    coverUrl,
    sourceUrl: normalizeImageUrl(info.infoLink || info.canonicalVolumeLink || ''),
  };
}

function mapOpenLibraryCandidate(item) {
  if (!item?.key || !item?.title || !item?.cover_i) return null;

  return {
    id: `openlibrary:${item.key}`,
    source: 'openlibrary',
    sourceId: item.key,
    title: cleanInput(item.title),
    authors: Array.isArray(item.author_name)
      ? item.author_name.map((name) => cleanInput(name, 100)).filter(Boolean)
      : [],
    year: getYear(item.first_publish_year),
    isbn: normalizeIsbn(Array.isArray(item.isbn) ? item.isbn[0] : item.isbn),
    coverUrl: `https://covers.openlibrary.org/b/id/${encodeURIComponent(item.cover_i)}-L.jpg?default=false`,
    sourceUrl: `https://openlibrary.org${item.key}`,
  };
}

export function scorePublicBookCandidate(candidate, query) {
  const title = normalizeBookLookupText(query.title);
  const author = normalizeBookLookupText(query.author);
  const isbn = normalizeIsbn(query.isbn);
  const candidateTitle = normalizeBookLookupText(candidate.title);
  const candidateAuthors = normalizeBookLookupText(candidate.authors?.join(' '));
  const candidateIsbn = normalizeIsbn(candidate.isbn);

  let score = 0;
  if (isbn && candidateIsbn === isbn) score += 300;
  if (title && candidateTitle === title) score += 140;
  else if (title && (candidateTitle.includes(title) || title.includes(candidateTitle))) score += 80;
  if (author && candidateAuthors === author) score += 70;
  else if (author && (candidateAuthors.includes(author) || author.includes(candidateAuthors))) score += 40;
  if (candidate.coverUrl) score += 15;
  if (candidate.source === 'google') score += 2;
  return score;
}

export function rankPublicBookCandidates(candidates, query, limit = 8) {
  const seenCovers = new Set();
  return candidates
    .filter(Boolean)
    .map((candidate) => ({ ...candidate, score: scorePublicBookCandidate(candidate, query) }))
    .sort((a, b) => b.score - a.score)
    .filter((candidate) => {
      if (!candidate.coverUrl || seenCovers.has(candidate.coverUrl)) return false;
      seenCovers.add(candidate.coverUrl);
      return true;
    })
    .slice(0, limit);
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`书籍数据源返回 ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchGoogleBookCovers(query, options = {}) {
  const terms = [];
  if (query.isbn) terms.push(`isbn:${normalizeIsbn(query.isbn)}`);
  if (query.title) terms.push(`intitle:"${cleanInput(query.title).replaceAll('"', '')}"`);
  if (query.author) terms.push(`inauthor:"${cleanInput(query.author).replaceAll('"', '')}"`);

  const params = new URLSearchParams({
    q: terms.join(' '),
    maxResults: '10',
    printType: 'books',
    projection: 'lite',
  });
  const data = await fetchJson(
    options.fetchImpl || fetch,
    `${GOOGLE_BOOKS_ENDPOINT}?${params}`,
    options.timeoutMs || 6500
  );
  return (Array.isArray(data.items) ? data.items : []).map(mapGoogleCandidate).filter(Boolean);
}

export async function searchOpenLibraryBookCovers(query, options = {}) {
  const params = new URLSearchParams({
    fields: 'key,title,author_name,first_publish_year,isbn,cover_i',
    limit: '10',
    lang: 'zh',
  });
  if (query.title) params.set('title', cleanInput(query.title));
  if (query.author) params.set('author', cleanInput(query.author));
  if (query.isbn) params.set('isbn', normalizeIsbn(query.isbn));

  const data = await fetchJson(
    options.fetchImpl || fetch,
    `${OPEN_LIBRARY_ENDPOINT}?${params}`,
    options.timeoutMs || 6500
  );
  return (Array.isArray(data.docs) ? data.docs : []).map(mapOpenLibraryCandidate).filter(Boolean);
}

function cacheKey(query) {
  return [
    normalizeBookLookupText(query.title),
    normalizeBookLookupText(query.author),
    normalizeIsbn(query.isbn),
  ].join('|');
}

function readCache(key) {
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL) {
    resultCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeCache(key, value) {
  if (resultCache.size >= CACHE_LIMIT) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey) resultCache.delete(oldestKey);
  }
  resultCache.set(key, { createdAt: Date.now(), value });
}

export async function searchPublicBookCovers(rawQuery, options = {}) {
  const query = {
    title: cleanInput(rawQuery.title),
    author: cleanInput(rawQuery.author),
    isbn: normalizeIsbn(rawQuery.isbn),
  };
  if (!query.title && !query.isbn) throw new Error('请至少输入书名或 ISBN');

  const key = cacheKey(query);
  if (!options.skipCache) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const searches = await Promise.allSettled([
    searchGoogleBookCovers(query, options),
    searchOpenLibraryBookCovers(query, options),
  ]);
  const successful = searches.filter((result) => result.status === 'fulfilled');
  if (!successful.length) throw new Error('暂时无法连接书籍封面服务');

  const candidates = rankPublicBookCandidates(
    successful.flatMap((result) => result.value),
    query
  );
  writeCache(key, candidates);
  return candidates;
}
