import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBottleCollision,
  samplePointerMotion,
} from '../src/utils/driftBottlePhysics.js';

const bottleRect = {
  left: 100,
  top: 100,
  width: 80,
  height: 120,
};

test('鼠标从左右两侧撞击时，漂流瓶向相反方向偏倒', () => {
  const fromLeft = calculateBottleCollision({
    pointerX: 102,
    pointerY: 145,
    velocityX: 700,
    velocityY: 0,
    rect: bottleRect,
  });
  const fromRight = calculateBottleCollision({
    pointerX: 178,
    pointerY: 145,
    velocityX: -700,
    velocityY: 0,
    rect: bottleRect,
  });

  assert.ok(fromLeft.tilt > 0);
  assert.ok(fromRight.tilt < 0);
  assert.ok(fromLeft.shiftX > 0);
  assert.ok(fromRight.shiftX < 0);
});

test('正上方碰撞主要产生下沉，而不会凭空产生大幅旋转', () => {
  const collision = calculateBottleCollision({
    pointerX: 140,
    pointerY: 102,
    velocityX: 0,
    velocityY: 650,
    rect: bottleRect,
  });

  assert.ok(Math.abs(collision.tilt) < 1);
  assert.ok(collision.shiftY > 0);
});

test('更快的指针速度产生更强的位移和更大的涟漪', () => {
  const slow = calculateBottleCollision({
    pointerX: 104,
    pointerY: 150,
    velocityX: 180,
    velocityY: 0,
    rect: bottleRect,
  });
  const fast = calculateBottleCollision({
    pointerX: 104,
    pointerY: 150,
    velocityX: 1100,
    velocityY: 0,
    rect: bottleRect,
  });

  assert.ok(fast.energy > slow.energy);
  assert.ok(fast.rippleScale > slow.rippleScale);
  assert.ok(Math.abs(fast.shiftX) > Math.abs(slow.shiftX));
});

test('极端速度会被限制在适合界面的安全物理范围内', () => {
  const collision = calculateBottleCollision({
    pointerX: -1000,
    pointerY: -1000,
    velocityX: 99999,
    velocityY: -99999,
    rect: bottleRect,
  });

  assert.ok(Math.abs(collision.tilt) <= 22);
  assert.ok(Math.abs(collision.shiftX) <= 9);
  assert.ok(collision.energy <= 1);
  assert.ok(collision.rippleOffset >= -1 && collision.rippleOffset <= 1);
});

test('指针采样会根据时间间隔平滑计算速度', () => {
  const initial = samplePointerMotion(null, { x: 10, y: 20, time: 100 });
  const moved = samplePointerMotion(initial, { x: 30, y: 24, time: 120 });

  assert.equal(initial.velocityX, 0);
  assert.ok(moved.velocityX > 0);
  assert.ok(moved.velocityY > 0);
  assert.equal(moved.x, 30);
  assert.equal(moved.time, 120);
});
