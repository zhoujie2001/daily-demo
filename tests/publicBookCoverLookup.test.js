import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBookLookupText,
  searchPublicBookCovers,
} from '../src/utils/bookCoverLookup.js';
import bookSearchHandler from '../api/book-search.js';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

test('客户端书名标准化支持中文书名号和标点', () => {
  assert.equal(normalizeBookLookupText('《查拉图斯特拉如是说》'), '查拉图斯特拉如是说');
});

test('静态站点可直接为《查拉图斯特拉如是说》匹配 Google Books 封面', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).startsWith('https://www.googleapis.com/books/')) {
      return jsonResponse({
        items: [{
          id: 'gBoWzgEACAAJ',
          volumeInfo: {
            title: '查拉图斯特拉如是说',
            authors: ['尼采'],
            publishedDate: '2019',
            industryIdentifiers: [{ type: 'ISBN_13', identifier: '9787532781867' }],
            imageLinks: {
              thumbnail: 'http://books.google.com/books/content?id=gBoWzgEACAAJ&printsec=frontcover&img=1&zoom=1',
            },
          },
        }],
      });
    }
    return jsonResponse({ docs: [] });
  };

  const candidates = await searchPublicBookCovers(
    { title: '查拉图斯特拉如是说', author: '尼采' },
    { fetchImpl, skipCache: true }
  );

  assert.equal(candidates[0].id, 'google:gBoWzgEACAAJ');
  assert.equal(candidates[0].title, '查拉图斯特拉如是说');
  assert.match(candidates[0].coverUrl, /^https:\/\/books\.google\.com\/books\/content/);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /intitle%3A%22%E6%9F%A5%E6%8B%89%E5%9B%BE%E6%96%AF%E7%89%B9%E6%8B%89%E5%A6%82%E6%98%AF%E8%AF%B4%22/);
});

test('一个公共数据源失败时仍使用另一个数据源的封面', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://www.googleapis.com/books/')) {
      throw new Error('Google unavailable');
    }
    return jsonResponse({
      docs: [{
        key: '/works/OL123W',
        title: '查拉图斯特拉如是说',
        author_name: ['尼采'],
        first_publish_year: 1883,
        isbn: ['9780000000000'],
        cover_i: 98765,
      }],
    });
  };

  const candidates = await searchPublicBookCovers(
    { title: '查拉图斯特拉如是说', author: '尼采' },
    { fetchImpl, skipCache: true }
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'openlibrary');
  assert.equal(
    candidates[0].coverUrl,
    'https://covers.openlibrary.org/b/id/98765-L.jpg?default=false'
  );
});

test('Serverless 封面搜索兜底允许静态博客跨域调用', async () => {
  const responseHeaders = new Map();
  let responseStatus = 0;
  let ended = false;
  const res = {
    setHeader: (key, value) => responseHeaders.set(String(key).toLowerCase(), value),
    status(value) {
      responseStatus = value;
      return this;
    },
    end() {
      ended = true;
      return this;
    },
  };

  await bookSearchHandler({ method: 'OPTIONS', query: {} }, res);

  assert.equal(responseStatus, 204);
  assert.equal(ended, true);
  assert.equal(responseHeaders.get('access-control-allow-origin'), '*');
  assert.equal(responseHeaders.get('access-control-allow-methods'), 'GET, OPTIONS');
});
