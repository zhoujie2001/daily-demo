import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePetDock } from '../src/utils/petDocking.js';

test('阿里萨默认停靠在移动端右下角', () => {
  const decision = resolvePetDock({
    viewportWidth: 390,
    viewportHeight: 844,
    obstacles: [],
  });
  assert.deepEqual(decision, {
    dock: 'right',
    compact: false,
    bottomOffset: 8,
    score: 0,
  });
});

test('右下控件与阿里萨冲突时自动切换到左侧', () => {
  const decision = resolvePetDock({
    viewportWidth: 390,
    viewportHeight: 844,
    fullSize: 104,
    obstacles: [
      { left: 250, right: 390, top: 680, bottom: 844 },
    ],
  });
  assert.equal(decision.dock, 'left');
  assert.equal(decision.compact, false);
  assert.equal(decision.score, 0);
});

test('底部两侧都被占用时缩成 56px 安全态', () => {
  const decision = resolvePetDock({
    viewportWidth: 390,
    viewportHeight: 844,
    fullSize: 104,
    compactSize: 56,
    obstacles: [
      { left: 0, right: 120, top: 700, bottom: 790 },
      { left: 270, right: 390, top: 700, bottom: 790 },
    ],
  });
  assert.equal(decision.compact, true);
  assert.ok(decision.bottomOffset > 8);
  assert.equal(decision.score, 0);
});
