import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoverProxyUrl,
  fetchCoverImage,
  lookupBooks,
  normalizeBookText,
  normalizeCoverSource,
  rankBookCandidates,
} from '../server/bookLookup.js';

function headers(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) || null };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers({ 'content-type': 'application/json' }),
    json: async () => data,
  };
}

test('书名标准化会忽略书名号、空格和常见标点', () => {
  assert.equal(normalizeBookText(' 《1988：我想和这个世界谈谈》 '), '1988我想和这个世界谈谈');
});

test('封面代理只接受受信任的 HTTPS 图片来源', () => {
  assert.equal(
    normalizeCoverSource('http://books.google.com/books/content?id=abc'),
    'https://books.google.com/books/content?id=abc'
  );
  assert.match(createCoverProxyUrl('https://covers.openlibrary.org/b/id/42-M.jpg'), /^\/api\/book-cover\?url=/);
  assert.throws(() => normalizeCoverSource('https://example.com/cover.jpg'), /不支持的封面来源/);
});

test('候选排序优先 ISBN，其次精确书名和作者', () => {
  const query = { title: '活着', author: '余华', isbn: '9787506365437' };
  const ranked = rankBookCandidates([
    {
      id: 'wrong', source: 'google', title: '活着', authors: ['其他作者'], isbn: '', coverUrl: '/wrong',
    },
    {
      id: 'right', source: 'openlibrary', title: '活着', authors: ['余华'], isbn: '9787506365437', coverUrl: '/right',
    },
  ], query);
  assert.equal(ranked[0].id, 'right');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('查询会合并 Google Books 与 Open Library 并自动选择精确匹配', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).startsWith('https://www.googleapis.com/books/')) {
      return jsonResponse({
        items: [
          {
            id: 'google-1',
            volumeInfo: {
              title: '活着',
              authors: ['余华'],
              publishedDate: '2012-08',
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9787506365437' }],
              imageLinks: { thumbnail: 'http://books.google.com/books/content?id=google-1' },
            },
          },
        ],
      });
    }
    return jsonResponse({
      docs: [
        {
          key: '/works/OL1W',
          title: '活着（纪念版）',
          author_name: ['余华'],
          first_publish_year: 1992,
          isbn: ['9780000000000'],
          cover_i: 123,
        },
      ],
    });
  };

  const result = await lookupBooks(
    { title: '活着', author: '余华', isbn: '9787506365437' },
    { fetchImpl, skipCache: true }
  );

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].id, 'google:google-1');
  assert.equal(result.candidates[0].coverUrl.startsWith('/api/book-cover?url='), true);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /intitle%3A%22%E6%B4%BB%E7%9D%80%22/);
});

test('封面代理校验图片类型并返回二进制数据', async () => {
  const payload = new Uint8Array([255, 216, 255, 224]);
  const result = await fetchCoverImage('https://covers.openlibrary.org/b/id/123-M.jpg', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/jpeg', 'content-length': payload.length }),
      arrayBuffer: async () => payload.buffer,
    }),
  });

  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(Array.from(result.bytes), Array.from(payload));
});

test('封面代理拒绝 HTML 响应，避免把错误页当图片缓存', async () => {
  await assert.rejects(
    fetchCoverImage('https://covers.openlibrary.org/b/id/404-M.jpg', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }),
    /不是受支持的图片/
  );
});
