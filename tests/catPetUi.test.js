import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function readPetSources() {
  return Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/AlishaSprite.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.css', root), 'utf8'),
  ]);
}

test('页面挂载真正分层的 2D 矢量阿丽莎并彻底移除整图裁切方案', async () => {
  const [appSource, componentSource, spriteSource] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('src/components/pet/AlishaSprite.jsx', root), 'utf8'),
  ]);

  assert.match(appSource, /import CatPet/);
  assert.match(appSource, /<CatPet \/>/);
  assert.match(componentSource, /import AlishaSprite/);
  assert.match(spriteSource, /className="alisha-torso"/);
  assert.match(spriteSource, /className="alisha-head"/);
  assert.match(spriteSource, /className="alisha-tail"/);
  assert.match(spriteSource, /alisha-front-paw-left/);
  assert.doesNotMatch(componentSource, /alisha-pet-v2\.png|cat-pet-tail-layer|cat-pet-ear-layer/);
  assert.doesNotMatch(componentSource, /<canvas|getContext\('webgl'/);
});

test('眨眼压合真实眼球并使用闭眼弧线，不再用矩形假眼皮覆盖', async () => {
  const [, spriteSource, cssSource] = await readPetSources();

  assert.match(spriteSource, /alisha-eye-open alisha-eye-left/);
  assert.match(spriteSource, /alisha-eye-open alisha-eye-right/);
  assert.match(spriteSource, /className="alisha-closed-eyes"/);
  assert.match(cssSource, /alisha-natural-blink/);
  assert.match(cssSource, /scaleY\(0\.055\)/);
  assert.doesNotMatch(cssSource, /\.cat-pet-eyelid|linear-gradient\(\s*to bottom/);
});

test('呼吸、随机眨眼、单耳、尾摆和视线跟随均为独立基础层', async () => {
  const [componentSource, , cssSource] = await readPetSources();

  assert.match(componentSource, /blinkMinMs/);
  assert.match(componentSource, /setEarFlick/);
  assert.match(componentSource, /setTailMotion/);
  assert.match(componentSource, /requestAnimationFrame\(renderGaze\)/);
  assert.match(componentSource, /--eye-x/);
  assert.match(componentSource, /--head-tilt/);
  assert.match(cssSource, /alisha-breathe/);
  assert.match(cssSource, /alisha-left-ear-flick/);
  assert.match(cssSource, /alisha-tail-left/);
});

test('头、左右耳、尾巴和身体具有独立命中区并支持键盘', async () => {
  const [, spriteSource] = await readPetSources();

  assert.match(spriteSource, /is-body/);
  assert.match(spriteSource, /is-head/);
  assert.match(spriteSource, /is-left-ear/);
  assert.match(spriteSource, /is-right-ear/);
  assert.match(spriteSource, /is-tail/);
  assert.match(spriteSource, /tabIndex: 0/);
  assert.match(spriteSource, /onKeyDown: activateWithKeyboard/);
});

test('主体动作排队、连续点击不耐烦、长按抚摸和睡眠唤醒完整接入', async () => {
  const [componentSource] = await readPetSources();

  assert.match(componentSource, /enqueueAlishaAction/);
  assert.match(componentSource, /recordRapidClick/);
  assert.match(componentSource, /ALISHA_ACTION\.ANNOYED/);
  assert.match(componentSource, /petHoldTimerRef/);
  assert.match(componentSource, /ALISHA_ACTION\.PETTING/);
  assert.match(componentSource, /idleSleepMs/);
  assert.match(componentSource, /setSleeping\(true\)/);
  assert.match(componentSource, /ALISHA_ACTION\.WAKE/);
});

test('欢迎、板块联动、星星和蝴蝶结保留且使用新版持久化状态', async () => {
  const [componentSource] = await readPetSources();

  assert.match(componentSource, /daily-demo-alisha-welcomed-v2/);
  assert.match(componentSource, /daily-demo-alisha-visits-v2/);
  assert.match(componentSource, /daily-demo-alisha-star-v2/);
  assert.match(componentSource, /daily-demo-alisha-affection-v2/);
  assert.match(componentSource, /SECTION_ACTIONS/);
  assert.match(componentSource, /is-diary/);
  assert.match(componentSource, /is-camera/);
  assert.match(componentSource, /is-backpack/);
});

test('运行时配置符合 PRD 的尺寸、睡眠、随机节奏和移动端要求', async () => {
  const [componentSource, config] = await Promise.all([
    readFile(new URL('src/components/pet/CatPet.jsx', root), 'utf8'),
    readFile(new URL('public/alisha.config.json', root), 'utf8').then(JSON.parse),
  ]);

  assert.equal(config.position.right, 24);
  assert.equal(config.position.bottom, 20);
  assert.equal(config.size.desktop, 248);
  assert.equal(config.size.mobile, 124);
  assert.equal(config.timings.blinkMinMs, 4000);
  assert.equal(config.timings.blinkMaxMs, 9000);
  assert.equal(config.timings.idleSleepMs, 180000);
  assert.equal(config.motion.mobileMode, 'lite');
  assert.match(componentSource, /fetch\('\/alisha\.config\.json'/);
  assert.match(componentSource, /--alisha-size-mobile/);
});

test('声音、暂停、收起、关闭、自动避让和减少动画均可访问', async () => {
  const [componentSource, , cssSource] = await readPetSources();

  assert.match(componentSource, /daily-demo-alisha-preferences-v2/);
  assert.match(componentSource, /开启阿丽莎声音/);
  assert.match(componentSource, /暂停阿丽莎动画/);
  assert.match(componentSource, /展开阿丽莎控制/);
  assert.match(componentSource, /收起页面宠物阿丽莎/);
  assert.match(componentSource, /隐藏页面宠物阿丽莎/);
  assert.match(componentSource, /IntersectionObserver/);
  assert.match(componentSource, /is-avoiding-controls/);
  assert.match(cssSource, /@media \(max-width: 700px\)/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/);
  assert.match(cssSource, /\.alisha-hit-zone[\s\S]*pointer-events: all/);
});
