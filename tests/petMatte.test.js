import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PET_MASK_SIZE,
  closeAlphaMask,
  createPetEnvelopeMask,
  createPetProtectionMask,
  createSpatialBackgroundModel,
  findMovementLowerBounds,
  resolvePetMaskSize,
  sampleSpatialBackground,
  stabilizePetAlpha,
} from '../src/utils/petMatte.js';

test('移动端使用更克制的蒙版尺寸，桌面端保留毛发细节', () => {
  assert.equal(
    resolvePetMaskSize({ viewportWidth: 390, deviceMemory: 8 }),
    PET_MASK_SIZE.mobile
  );
  assert.equal(
    resolvePetMaskSize({ viewportWidth: 1440, deviceMemory: 8 }),
    PET_MASK_SIZE.desktop
  );
  assert.equal(
    resolvePetMaskSize({ viewportWidth: 1440, deviceMemory: 4 }),
    PET_MASK_SIZE.mobile
  );
});

test('主体外轮廓会裁掉远离阿丽莎的背景', () => {
  const width = 100;
  const height = 100;
  const envelope = createPetEnvelopeMask(width, height);
  const at = (x, y) => envelope[y * width + x];

  assert.ok(at(50, 50) > 0.95);
  assert.ok(at(65, 73) > 0.95);
  assert.equal(at(5, 50), 0);
  assert.equal(at(95, 50), 0);
});

test('空间背景模型可以还原水平和垂直渐变', () => {
  const width = 12;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 80 + x * 4 + y * 2;
      data[index + 1] = 90 + x * 3 + y * 2;
      data[index + 2] = 100 + x * 2 + y;
      data[index + 3] = 255;
    }
  }
  const model = createSpatialBackgroundModel(data, width, height);
  const sampled = sampleSpatialBackground(model, 6, 5);

  assert.ok(Math.abs(sampled[0] - (80 + 6 * 4 + 5 * 2)) < 3);
  assert.ok(Math.abs(sampled[1] - (90 + 6 * 3 + 5 * 2)) < 3);
  assert.ok(Math.abs(sampled[2] - (100 + 6 * 2 + 5)) < 3);
});

test('主体保护区覆盖猫脸和胸口，但不会污染画面四角', () => {
  const width = 100;
  const height = 100;
  const protection = createPetProtectionMask(width, height);
  const at = (x, y) => protection[y * width + x];

  assert.ok(at(50, 39) > 0.95);
  assert.ok(at(49, 60) > 0.95);
  assert.equal(at(0, 0), 0);
  assert.equal(at(99, 99), 0);
});

test('闭运算填补主体内部的单像素透明孔洞', () => {
  const width = 5;
  const height = 5;
  const source = new Float32Array(width * height).fill(255);
  source[12] = 0;
  const output = new Float32Array(source.length);
  const scratch = new Float32Array(source.length);

  closeAlphaMask(source, width, height, output, scratch);

  assert.equal(output[12], 255);
});

test('主体修复不会强留保护区背景，且不透明区域恢复较快', () => {
  const width = 3;
  const height = 3;
  const alpha = new Float32Array(width * height);
  const previousAlpha = new Float32Array(width * height).fill(80);
  const envelope = new Float32Array(width * height).fill(1);
  const output = new Float32Array(width * height);
  const scratch = new Float32Array(width * height);

  stabilizePetAlpha({
    alpha,
    previousAlpha,
    envelope,
    width,
    height,
    hasPrevious: true,
    output,
    scratch,
  });

  assert.ok(output[4] < previousAlpha[4]);

  alpha[4] = 255;
  stabilizePetAlpha({
    alpha,
    previousAlpha,
    envelope,
    width,
    height,
    hasPrevious: true,
    output,
    scratch,
  });

  assert.ok(output[4] > 170);
});

test('移动蒙版会按每一列的有效细节估算脚部下沿', () => {
  const width = 9;
  const height = 10;
  const scores = new Float32Array(width * height);
  const luma = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luma[y * width + x] = x * 20;
    }
  }

  for (let x = 2; x <= 6; x += 1) {
    for (let y = 4; y <= 8; y += 1) {
      const index = y * width + x;
      scores[index] = 40;
    }
  }

  const bounds = findMovementLowerBounds({
    scores,
    luma,
    width,
    height,
    threshold: 20,
  });

  assert.ok(bounds[4] >= 8);
  assert.ok(bounds[0] < bounds[4]);
  assert.equal(bounds.length, width);
});
