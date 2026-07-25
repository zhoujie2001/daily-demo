const GOOGLE_BOOKS_ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_ENDPOINT = 'https://openlibrary.org/search.json';
const DOUBAN_BOOK_SEARCH_ENDPOINT = 'https://search.douban.com/book/subject_search';
const COVER_HOSTS = new Set([
  'books.google.com',
  'books.googleusercontent.com',
  'covers.openlibrary.org',
]);

const SEARCH_CACHE_TTL = 6 * 60 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 100;
const searchCache = new Map();
const VERIFIED_BOOKS = [
  {
    title: '查拉图斯特拉如是说',
    authors: ['[德] 尼采'],
    year: '2007',
    isbn: '',
    coverSource: 'https://img9.doubanio.com/view/subject/m/public/s2857294.jpg',
    sourceUrl: 'https://book.douban.com/subject/2359052/',
  },
];

function cleanInput(value, maxLength = 160) {
  return String(Array.isArray(value) ? value[0] : value || '').trim().slice(0, maxLength);
}

export function normalizeBookText(value) {
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

function isTrustedCoverHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return COVER_HOSTS.has(normalized) || /^img\d+\.doubanio\.com$/.test(normalized);
}

export function normalizeCoverSource(rawUrl) {
  const value = cleanInput(rawUrl, 2000);
  if (!value) throw new Error('封面地址为空');

  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || !isTrustedCoverHost(url.hostname)) {
    throw new Error('不支持的封面来源');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

export function createCoverProxyUrl(rawUrl) {
  const source = normalizeCoverSource(rawUrl);
  return `/api/book-cover?url=${encodeURIComponent(source)}`;
}

function imageFromGoogle(volumeInfo = {}) {
  const links = volumeInfo.imageLinks || {};
  return links.extraLarge || links.large || links.medium || links.small || links.thumbnail || links.smallThumbnail || '';
}

function mapGoogleCandidate(item) {
  const info = item?.volumeInfo || {};
  const coverSource = imageFromGoogle(info);
  if (!item?.id || !info.title || !coverSource) return null;

  try {
    const normalizedCover = normalizeCoverSource(coverSource);
    return {
      id: `google:${item.id}`,
      source: 'google',
      sourceId: item.id,
      title: cleanInput(info.title),
      authors: Array.isArray(info.authors) ? info.authors.map((name) => cleanInput(name, 100)).filter(Boolean) : [],
      year: getYear(info.publishedDate),
      isbn: firstIsbn(info.industryIdentifiers),
      coverUrl: createCoverProxyUrl(normalizedCover),
      sourceUrl: cleanInput(info.infoLink || info.canonicalVolumeLink || '', 1000),
    };
  } catch {
    return null;
  }
}

function mapOpenLibraryCandidate(item) {
  if (!item?.key || !item?.title || !item?.cover_i) return null;

  const coverSource = `https://covers.openlibrary.org/b/id/${encodeURIComponent(item.cover_i)}-M.jpg?default=false`;
  return {
    id: `openlibrary:${item.key}`,
    source: 'openlibrary',
    sourceId: item.key,
    title: cleanInput(item.title),
    authors: Array.isArray(item.author_name) ? item.author_name.map((name) => cleanInput(name, 100)).filter(Boolean) : [],
    year: getYear(item.first_publish_year),
    isbn: normalizeIsbn(Array.isArray(item.isbn) ? item.isbn[0] : item.isbn),
    coverUrl: createCoverProxyUrl(coverSource),
    sourceUrl: `https://openlibrary.org${item.key}`,
  };
}

function extractAssignedJson(html, assignment = 'window.__DATA__') {
  const source = String(html || '');
  const assignmentIndex = source.indexOf(assignment);
  if (assignmentIndex < 0) return null;

  const start = source.indexOf('{', assignmentIndex + assignment.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function doubanAuthors(abstract) {
  return cleanInput(abstract, 1000)
    .split(/\s+\/\s+/)
    .slice(0, 3)
    .map((value) => cleanInput(value, 100))
    .filter(Boolean);
}

function mapDoubanCandidate(item) {
  if (!item?.id || !item?.title || !item?.cover_url) return null;

  try {
    const coverSource = normalizeCoverSource(item.cover_url);
    return {
      id: `douban:${item.id}`,
      source: 'douban',
      sourceId: String(item.id),
      title: cleanInput(item.title),
      authors: doubanAuthors(item.abstract),
      year: getYear(item.abstract),
      isbn: '',
      coverUrl: createCoverProxyUrl(coverSource),
      sourceUrl: cleanInput(item.url || `https://book.douban.com/subject/${item.id}/`, 1000),
    };
  } catch {
    return null;
  }
}

export function parseDoubanSearchPage(html) {
  const data = extractAssignedJson(html);
  return (Array.isArray(data?.items) ? data.items : []).map(mapDoubanCandidate).filter(Boolean);
}

function verifiedBookCandidates(query) {
  const normalizedTitle = normalizeBookText(query.title);
  if (!normalizedTitle) return [];

  return VERIFIED_BOOKS
    .filter((book) => normalizeBookText(book.title) === normalizedTitle)
    .map((book, index) => ({
      id: `verified:${normalizedTitle}:${index}`,
      source: 'verified',
      sourceId: '',
      title: book.title,
      authors: book.authors,
      year: book.year,
      isbn: book.isbn,
      coverUrl: createCoverProxyUrl(book.coverSource),
      sourceUrl: book.sourceUrl,
    }));
}

export function scoreBookCandidate(candidate, query) {
  const title = normalizeBookText(query.title);
  const author = normalizeBookText(query.author);
  const isbn = normalizeIsbn(query.isbn);
  const candidateTitle = normalizeBookText(candidate.title);
  const candidateAuthors = normalizeBookText(candidate.authors?.join(' '));
  const candidateIsbn = normalizeIsbn(candidate.isbn);

  let score = 0;
  if (isbn && candidateIsbn === isbn) score += 300;
  if (title && candidateTitle === title) score += 140;
  else if (title && (candidateTitle.includes(title) || title.includes(candidateTitle))) score += 80;
  if (author && candidateAuthors === author) score += 70;
  else if (author && (candidateAuthors.includes(author) || author.includes(candidateAuthors))) score += 40;
  if (candidate.coverUrl) score += 15;
  if (candidate.source === 'douban') score += 3;
  if (candidate.source === 'google') score += 2;
  return score;
}

export function rankBookCandidates(candidates, query, limit = 8) {
  const seenCovers = new Set();
  return candidates
    .filter(Boolean)
    .map((candidate) => ({ ...candidate, score: scoreBookCandidate(candidate, query) }))
    .sort((a, b) => b.score - a.score)
    .filter((candidate) => {
      if (!candidate.coverUrl || seenCovers.has(candidate.coverUrl)) return false;
      seenCovers.add(candidate.coverUrl);
      return true;
    })
    .slice(0, limit);
}

async function fetchJson(fetchImpl, url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`上游服务返回 ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(fetchImpl, url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; daily-demo-book-cover/1.0)',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`上游服务返回 ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchGoogleBooks(query, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
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
  const apiKey = cleanInput(options.apiKey || process.env.GOOGLE_BOOKS_API_KEY || '', 256);
  if (apiKey) params.set('key', apiKey);

  const data = await fetchJson(fetchImpl, `${GOOGLE_BOOKS_ENDPOINT}?${params}`);
  return (Array.isArray(data.items) ? data.items : []).map(mapGoogleCandidate).filter(Boolean);
}

export async function searchOpenLibrary(query, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const params = new URLSearchParams({
    fields: 'key,title,author_name,first_publish_year,isbn,cover_i',
    limit: '10',
    lang: 'zh',
  });
  if (query.title) params.set('title', cleanInput(query.title));
  if (query.author) params.set('author', cleanInput(query.author));
  if (query.isbn) params.set('isbn', normalizeIsbn(query.isbn));
  const data = await fetchJson(fetchImpl, `${OPEN_LIBRARY_ENDPOINT}?${params}`);
  return (Array.isArray(data.docs) ? data.docs : []).map(mapOpenLibraryCandidate).filter(Boolean);
}

export async function searchDoubanBooks(query, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const searchText = cleanInput(query.isbn || query.title);
  if (!searchText) return [];

  const params = new URLSearchParams({
    search_text: searchText,
    cat: '1001',
  });
  const html = await fetchText(fetchImpl, `${DOUBAN_BOOK_SEARCH_ENDPOINT}?${params}`);
  return parseDoubanSearchPage(html);
}

function getCacheKey(query) {
  return [normalizeBookText(query.title), normalizeBookText(query.author), normalizeIsbn(query.isbn)].join('|');
}

function readCache(key) {
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > SEARCH_CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeCache(key, value) {
  if (searchCache.size >= SEARCH_CACHE_LIMIT) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { createdAt: Date.now(), value });
}

export async function lookupBooks(rawQuery, options = {}) {
  const query = {
    title: cleanInput(rawQuery.title),
    author: cleanInput(rawQuery.author),
    isbn: normalizeIsbn(rawQuery.isbn),
  };
  if (!query.title && !query.isbn) {
    const error = new Error('请至少输入书名或 ISBN');
    error.status = 400;
    throw error;
  }

  const cacheKey = getCacheKey(query);
  if (!options.skipCache) {
    const cached = readCache(cacheKey);
    if (cached) return cached;
  }

  const verified = verifiedBookCandidates(query);
  if (verified.length) {
    const value = { query, candidates: rankBookCandidates(verified, query) };
    writeCache(cacheKey, value);
    return value;
  }

  const searches = await Promise.allSettled([
    searchGoogleBooks(query, options),
    searchOpenLibrary(query, options),
    searchDoubanBooks(query, options),
  ]);
  const successful = searches.filter((result) => result.status === 'fulfilled');
  if (!successful.length) {
    const error = new Error('暂时无法连接书籍封面服务');
    error.status = 502;
    throw error;
  }

  const candidates = rankBookCandidates(successful.flatMap((result) => result.value), query);
  const value = { query, candidates };
  if (candidates.length) writeCache(cacheKey, value);
  return value;
}

export async function fetchCoverImage(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  let url = normalizeCoverSource(rawUrl);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
          'User-Agent': 'daily-demo/1.0 (book cover lookup)',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('封面重定向异常');
      url = normalizeCoverSource(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      const error = new Error(`封面服务返回 ${response.status}`);
      error.status = response.status === 404 ? 404 : 502;
      throw error;
    }

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(contentType)) {
      const error = new Error('上游内容不是受支持的图片');
      error.status = 415;
      throw error;
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
      const error = new Error('封面图片过大');
      error.status = 413;
      throw error;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) {
      const error = new Error(bytes.length ? '封面图片过大' : '封面图片为空');
      error.status = bytes.length ? 413 : 502;
      throw error;
    }
    return { bytes, contentType, sourceUrl: url };
  }

  throw new Error('无法获取封面');
}
