import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReadingBooks,
  getReadingPageCount,
  getReadingPageSize,
  getReadingSwipeDirection,
  paginateReadingBooks,
} from '../src/utils/readingPagination.js';

const sampleBooks = [
  { id: 1, title: '在读的一本书', author: '甲', note: '慢慢读', status: 'reading' },
  { id: 2, title: '已经读完', author: '乙', note: '很好', status: 'read' },
  { id: 3, title: '以后想读', author: '丙', note: '旅行', status: 'want' },
  { id: 4, title: '另一部作品', author: '甲', note: '生活', status: 'read' },
  { id: 5, title: '第五本', author: '丁', note: '', status: 'read' },
  { id: 6, title: '第六本', author: '戊', note: '', status: 'read' },
  { id: 7, title: '第七本', author: '己', note: '', status: 'read' },
];

test('uses 3, 4 and 6 books for mobile, tablet and desktop widths', () => {
  assert.equal(getReadingPageSize(320), 3);
  assert.equal(getReadingPageSize(700), 3);
  assert.equal(getReadingPageSize(701), 4);
  assert.equal(getReadingPageSize(999), 4);
  assert.equal(getReadingPageSize(1000), 6);
  assert.equal(getReadingPageSize(1440), 6);
});

test('filters the complete collection by status and searchable fields', () => {
  assert.deepEqual(
    filterReadingBooks(sampleBooks, { status: 'reading' }).map((book) => book.id),
    [1]
  );
  assert.deepEqual(
    filterReadingBooks(sampleBooks, { query: '甲' }).map((book) => book.id),
    [1, 4]
  );
  assert.deepEqual(
    filterReadingBooks(sampleBooks, { query: '旅行', status: 'want' }).map((book) => book.id),
    [3]
  );
  assert.deepEqual(filterReadingBooks(sampleBooks, { query: '不存在' }), []);
});

test('paginates without changing the source order', () => {
  const first = paginateReadingBooks(sampleBooks, 1, 3);
  const third = paginateReadingBooks(sampleBooks, 3, 3);

  assert.deepEqual(first.items.map((book) => book.id), [1, 2, 3]);
  assert.deepEqual(third.items.map((book) => book.id), [7]);
  assert.equal(first.pageCount, 3);
  assert.equal(third.page, 3);
});

test('clamps the current page after filtering or deleting the last page', () => {
  const afterDelete = paginateReadingBooks(sampleBooks.slice(0, 3), 4, 3);
  const empty = paginateReadingBooks([], 9, 3);

  assert.equal(afterDelete.page, 1);
  assert.deepEqual(afterDelete.items.map((book) => book.id), [1, 2, 3]);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(empty.items, []);
  assert.equal(getReadingPageCount(0, 3), 1);
});

test('only treats a deliberate horizontal gesture as a page swipe', () => {
  assert.equal(
    getReadingSwipeDirection({ x: 300, y: 200 }, { x: 120, y: 206 }),
    'next'
  );
  assert.equal(
    getReadingSwipeDirection({ x: 120, y: 200 }, { x: 300, y: 194 }),
    'previous'
  );
  assert.equal(
    getReadingSwipeDirection({ x: 200, y: 100 }, { x: 180, y: 250 }),
    null
  );
  assert.equal(
    getReadingSwipeDirection({ x: 200, y: 100 }, { x: 165, y: 102 }),
    null
  );
});
