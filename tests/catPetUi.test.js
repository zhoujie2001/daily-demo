import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('页面挂载轻量 2D 阿丽莎并彻底移除 WebGL 渲染器', async () => {
  const [appSource, componentSource, asset] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('public/images/alisha-pet-v2.png', root)),
  ]);

  assert.match(appSource, /import CatPet/);
  assert.match(appSource, /<CatPet \/>/);
  assert.match(componentSource, /\/images\/alisha-pet-v2\.png/);
  assert.doesNotMatch(componentSource, /createCatPetEngine|<canvas|getContext\('webgl'/);
  assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(asset.length > 80_000);
  assert.ok(asset.length < 250_000);
});

test('基础陪伴动作由 CSS 驱动，鼠标事件才使用单帧调度', async () => {
  const [componentSource, cssSource] = await Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.css', root), 'utf8'),
  ]);

  assert.match(componentSource, /setBlinking/);
  assert.match(componentSource, /setEarFlicking/);
  assert.match(componentSource, /window\.addEventListener\('pointermove'/);
  assert.match(componentSource, /requestAnimationFrame\(renderGaze\)/);
  assert.doesNotMatch(componentSource, /requestAnimationFrame\(render\)/);
  assert.match(cssSource, /alisha-breathe/);
  assert.match(cssSource, /alisha-tail-rest/);
  assert.match(cssSource, /alisha-ear-flick/);
  assert.match(cssSource, /--gaze-x/);
});

test('欢迎、待机、点击升级和板块联动全部接入统一动作系统', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /ALISHA_ACTION\.WELCOME/);
  assert.match(source, /pickIdleAction/);
  assert.match(source, /recordRapidClick/);
  assert.match(source, /ALISHA_ACTION\.ANNOYED/);
  assert.match(source, /SECTION_ACTIONS/);
  assert.match(source, /sectionDwellMs/);
  assert.match(source, /is-diary/);
  assert.match(source, /is-camera/);
  assert.match(source, /is-backpack/);
});

test('五分钟星星、七日蝴蝶结和首次欢迎语均有持久化状态', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /daily-demo-alisha-welcomed-v1/);
  assert.match(source, /daily-demo-alisha-visits-v1/);
  assert.match(source, /daily-demo-alisha-star-v1/);
  assert.match(source, /shouldCountActiveTime/);
  assert.match(source, /updateVisitStreak/);
  assert.match(source, /has-bow/);
  assert.match(source, /has-star/);
});

test('运行时配置可以控制位置、尺寸、行为与时间参数', async () => {
  const [componentSource, config] = await Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('public/alisha.config.json', root), 'utf8').then(JSON.parse),
  ]);

  assert.equal(config.position.right, 32);
  assert.equal(config.position.bottom, 32);
  assert.equal(config.size.desktop, 96);
  assert.equal(config.size.mobile, 72);
  assert.equal(config.timings.starActiveMs, 300000);
  assert.equal(config.motion.mobileMode, 'lite');
  assert.match(componentSource, /fetch\('\/alisha\.config\.json'/);
  assert.match(componentSource, /mergeAlishaConfig/);
  assert.match(componentSource, /--alisha-size-mobile/);
});

test('宠物支持隐藏恢复、自动避让、键盘、图片降级和减少动画', async () => {
  const [componentSource, cssSource] = await Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.css', root), 'utf8'),
  ]);

  assert.match(componentSource, /daily-demo-alisha-hidden-v1/);
  assert.match(componentSource, /aria-label="隐藏页面宠物阿丽莎"/);
  assert.match(componentSource, /aria-label="显示页面宠物阿丽莎"/);
  assert.match(componentSource, /tabIndex=\{0\}/);
  assert.match(componentSource, /CatPetFallback/);
  assert.match(componentSource, /IntersectionObserver/);
  assert.match(componentSource, /is-avoiding-controls/);
  assert.match(cssSource, /@media \(max-width: 700px\)/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/);
});
