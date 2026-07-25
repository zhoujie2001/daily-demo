import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutomaticallyReplaceBookCover,
  isKnownUnavailableBookCoverUrl,
  isManagedBookCoverUrl,
  searchBookCovers,
  searchServerBookCovers,
} from '../src/api/reading.js';

function jsonResponse(data, options = {}) {
  const status = options.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url,
    json: async () => data,
  };
}

test('静态博客优先通过 Vercel 函数搜索封面并使用同源图片代理', async () => {
  const requestedUrls = [];
  const apiBase = 'https://book-api.example.com';
  const requestUrl = `${apiBase}/api/book-search?title=${encodeURIComponent('查拉图斯特拉如是说')}&author=${encodeURIComponent('尼采')}&v=test-version`;
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    return jsonResponse({
      candidates: [{
        id: 'google:gBoWzgEACAAJ',
        title: '查拉图斯特拉如是说',
        authors: ['尼采'],
        coverUrl: '/api/book-cover?url=https%3A%2F%2Fbooks.google.com%2Fcover.jpg',
      }],
    }, { url: requestUrl });
  };

  const candidates = await searchBookCovers(
    { title: '查拉图斯特拉如是说', author: '尼采' },
    { fetchImpl, apiBase, lookupVersion: 'test-version', skipCache: true }
  );

  assert.deepEqual(requestedUrls, [requestUrl]);
  assert.equal(candidates[0].id, 'google:gBoWzgEACAAJ');
  assert.equal(
    candidates[0].coverUrl,
    'https://book-api.example.com/api/book-cover?url=https%3A%2F%2Fbooks.google.com%2Fcover.jpg'
  );
});

test('Vercel 函数不可用时才降级到浏览器公共书库查询', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requestedUrls.push(value);
    if (value.includes('/api/book-search?')) {
      return jsonResponse({ error: 'temporary failure' }, { status: 502, url: value });
    }
    if (value.startsWith('https://www.googleapis.com/books/')) {
      return jsonResponse({
        items: [{
          id: 'fallback',
          volumeInfo: {
            title: '查拉图斯特拉如是说',
            authors: ['尼采'],
            imageLinks: { thumbnail: 'https://books.google.com/fallback.jpg' },
          },
        }],
      });
    }
    return jsonResponse({ docs: [] });
  };

  const candidates = await searchBookCovers(
    { title: '查拉图斯特拉如是说', author: '尼采' },
    { fetchImpl, apiBase: 'https://book-api.example.com', skipCache: true }
  );

  assert.equal(candidates[0].id, 'google:fallback');
  assert.match(requestedUrls[0], /^https:\/\/book-api\.example\.com\/api\/book-search\?/);
  assert.equal(requestedUrls.length, 3);
});

test('服务端搜索会过滤无效封面地址', async () => {
  const candidates = await searchServerBookCovers(
    { title: '测试书籍' },
    {
      apiBase: 'https://book-api.example.com',
      fetchImpl: async (url) => jsonResponse({
        candidates: [
          { id: 'valid', coverUrl: '/api/book-cover?url=valid' },
          { id: 'invalid', coverUrl: 'http://[invalid' },
          { id: 'empty', coverUrl: '' },
        ],
      }, { url: String(url) }),
    }
  );

  assert.deepEqual(candidates.map((candidate) => candidate.id), ['valid']);
});

test('服务端正常返回空候选时不会误报为网络连接失败', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requestedUrls.push(value);
    if (value.includes('/api/book-search?')) {
      return jsonResponse({ candidates: [] }, { url: value });
    }
    throw new Error('public source unavailable');
  };

  const candidates = await searchBookCovers(
    { title: '不存在的书' },
    { fetchImpl, apiBase: 'https://book-api.example.com', skipCache: true }
  );

  assert.deepEqual(candidates, []);
  assert.equal(requestedUrls.length, 3);
});

test('封面函数请求始终携带查询版本，避免继续命中旧的空结果缓存', async () => {
  const requestedUrls = [];
  await searchServerBookCovers(
    { title: '缓存测试' },
    {
      apiBase: 'https://book-api.example.com',
      lookupVersion: 'cache-bust-2',
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return jsonResponse({ candidates: [] }, { url: String(url) });
      },
    }
  );

  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /[?&]v=cache-bust-2(?:&|$)/);
});

test('自动封面可以替换绝对代理地址和已知占位图', () => {
  const managed = 'https://daily-demo-roan.vercel.app/api/book-cover?url=valid';
  const unavailable = 'https://daily-demo-roan.vercel.app/api/book-cover?url=https%3A%2F%2Fbooks.google.com%2Fbooks%2Fcontent%3Fid%3DgBoWzgEACAAJ';

  assert.equal(isManagedBookCoverUrl(managed), true);
  assert.equal(isKnownUnavailableBookCoverUrl(unavailable), true);
  assert.equal(canAutomaticallyReplaceBookCover(managed), true);
  assert.equal(canAutomaticallyReplaceBookCover(unavailable), true);
  assert.equal(canAutomaticallyReplaceBookCover('https://example.com/manual-cover.jpg'), false);
});
