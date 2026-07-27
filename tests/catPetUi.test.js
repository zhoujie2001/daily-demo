import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('页面挂载高细节 2D 猫宠物并彻底移除 WebGL 渲染器', async () => {
  const [appSource, componentSource, asset] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('public/images/cat-pet-2d.png', root)),
  ]);

  assert.match(appSource, /import CatPet/);
  assert.match(appSource, /<CatPet \/>/);
  assert.match(componentSource, /\/images\/cat-pet-2d\.png/);
  assert.doesNotMatch(componentSource, /createCatPetEngine|<canvas|getContext\('webgl'/);
  assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(asset.length > 100_000);
  assert.ok(asset.length < 500_000);
});

test('2D 宠物支持随机眨眼、耳动、张望、呼吸和尾巴摆动', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /createCatPetSchedule/);
  assert.match(source, /CAT_PET_EVENT\.BLINK/);
  assert.match(source, /CAT_PET_EVENT\.EAR_FLICK/);
  assert.match(source, /CAT_PET_EVENT\.LOOK_AROUND/);
  assert.match(source, /--blink/);
  assert.match(source, /--ear-flick/);
  assert.match(source, /--tail-angle/);
  assert.match(source, /--breath/);
  assert.match(source, /requestAnimationFrame/);
});

test('眼神跟随和点击互动由独立的眼睑、反光、头部、耳朵、尾巴和前爪层完成', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /window\.addEventListener\('pointermove'/);
  assert.match(source, /chooseCatPetReaction/);
  assert.match(source, /cat-pet-head-layer/);
  assert.match(source, /cat-pet-ear-layer/);
  assert.match(source, /cat-pet-tail-layer/);
  assert.match(source, /cat-pet-paw-layer/);
  assert.match(source, /cat-pet-paw-mask/);
  assert.match(source, /cat-pet-eyelid/);
  assert.match(source, /cat-pet-eye-shine/);
});

test('宠物可以隐藏、恢复、自动避让，并提供键盘与图片失败降级', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /daily-demo-cat-pet-hidden/);
  assert.match(source, /aria-label="隐藏页面宠物"/);
  assert.match(source, /aria-label="显示页面宠物"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /CatPetFallback/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /is-avoiding-controls/);
  assert.match(source, /document\.addEventListener\('visibilitychange'/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test('2D 页面宠物在桌面、手机和减少动画设置下都有明确样式', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.css', root),
    'utf8'
  );

  assert.match(source, /\.cat-pet\s*\{/);
  assert.match(source, /\.cat-pet-eye-shine/);
  assert.match(source, /cat-pet-paw-wave/);
  assert.match(source, /@media \(max-width: 999px\)/);
  assert.match(source, /\.cat-pet\.is-avoiding-controls/);
  assert.match(source, /@media \(max-width: 700px\)/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
});
