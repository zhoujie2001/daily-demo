import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBookMetadata } from '../src/data/bookMetadata.js';

test('历史记录中的《查拉图斯特拉如是说》使用本地验证封面覆盖失效外链', () => {
  const metadata = resolveBookMetadata('查拉图斯特拉如是说');

  assert.equal(metadata.title, '查拉图斯特拉如是说');
  assert.equal(metadata.year, '2007');
  assert.equal(metadata.coverUrl, '/images/books/thus-spoke-zarathustra.jpg');
});
