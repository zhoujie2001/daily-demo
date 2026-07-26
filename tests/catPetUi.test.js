import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('页面挂载独立的 WebGL 猫宠物且不依赖外部 3D 运行时', async () => {
  const [appSource, componentSource, engineSource] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/catPetEngine.js', root), 'utf8'),
  ]);

  assert.match(appSource, /import CatPet/);
  assert.match(appSource, /<CatPet \/>/);
  assert.match(componentSource, /createCatPetEngine/);
  assert.match(engineSource, /getContext\('webgl'/);
  assert.match(engineSource, /requestAnimationFrame/);
  assert.doesNotMatch(engineSource, /from ['"]three['"]/);
  assert.doesNotMatch(engineSource, /https?:\/\//);
});

test('宠物支持视线跟随、点击反应、自动待机和页面隐藏时暂停', async () => {
  const [componentSource, engineSource] = await Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/catPetEngine.js', root), 'utf8'),
  ]);

  assert.match(componentSource, /window\.addEventListener\('pointermove'/);
  assert.match(componentSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(componentSource, /engineRef\.current\?\.react\(\)/);
  assert.match(componentSource, /prefers-reduced-motion: reduce/);
  assert.match(componentSource, /IntersectionObserver/);
  assert.match(componentSource, /is-avoiding-controls/);
  assert.match(engineSource, /createCatPetSchedule/);
  assert.match(engineSource, /CAT_PET_EVENT\.BLINK/);
  assert.match(engineSource, /CAT_PET_EVENT\.EAR_FLICK/);
  assert.match(engineSource, /CAT_PET_EVENT\.LOOK_AROUND/);
});

test('宠物可以隐藏、恢复，并为键盘和 WebGL 失败提供可访问降级', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /daily-demo-cat-pet-hidden/);
  assert.match(source, /aria-label="隐藏页面宠物"/);
  assert.match(source, /aria-label="显示页面宠物"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /CatPetFallback/);
});

test('页面宠物在桌面、手机和减少动画设置下都有明确样式', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.css', root),
    'utf8'
  );

  assert.match(source, /\.cat-pet\s*\{/);
  assert.match(source, /@media \(max-width: 999px\)/);
  assert.match(source, /\.cat-pet\.is-avoiding-controls/);
  assert.match(source, /@media \(max-width: 700px\)/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
});
