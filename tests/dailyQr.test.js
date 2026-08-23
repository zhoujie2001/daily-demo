import assert from 'node:assert/strict';
import test from 'node:test';
import { createQrGeometry, createQrMatrix } from '../src/utils/dailyQr.js';

test('二维码矩阵可同时复用于页面 SVG 和分享卡片 Canvas', () => {
  const value = 'https://www.littlearisa88.com/?time=2026-08-23#from=daily';
  const matrix = createQrMatrix(value);
  const geometry = createQrGeometry(value);

  assert.ok(matrix.moduleCount > 20);
  assert.equal(matrix.rows.length, matrix.moduleCount);
  assert.equal(matrix.rows.every((row) => row.length === matrix.moduleCount), true);
  assert.equal(matrix.size, matrix.moduleCount + 8);
  assert.equal(geometry.size, matrix.size);
  assert.match(geometry.path, /^M/);
});

