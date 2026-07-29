import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const actionAssets = [
  'v8_blink.mp4',
  'v8_look.mp4',
  'v8_stretch.mp4',
  'v8_lick.mp4',
  'v8_tail.mp4',
  'state_happy.mp4',
  'state_annoyed.mp4',
  'state_observe.mp4',
  'state_sleep.mp4',
  'state_wake.mp4',
];

test('主站挂载视频版阿丽莎并保留静态降级图', async () => {
  const [appSource, componentSource, baseAsset, fallbackAsset] =
    await Promise.all([
      readFile(new URL('src/App.jsx', root), 'utf8'),
      readFile(
        new URL('src/components/pet/CatPet.jsx', root),
        'utf8'
      ),
      readFile(
        new URL('public/videos/alisha/base-image.jpg', root)
      ),
      readFile(
        new URL('public/images/alisha-pet-v2.png', root)
      ),
    ]);

  assert.match(appSource, /import CatPet/);
  assert.match(appSource, /<CatPet \/>/);
  assert.match(componentSource, /StableVideoPetPlayer/);
  assert.match(componentSource, /<canvas/);
  assert.equal((componentSource.match(/<video/g) ?? []).length, 2);
  assert.match(componentSource, /\/videos\/alisha\/base-image\.jpg/);
  assert.match(componentSource, /\/images\/alisha-pet-v2\.png/);
  assert.doesNotMatch(componentSource, /getContext\(['"]webgl/);
  assert.deepEqual([...baseAsset.subarray(0, 3)], [255, 216, 255]);
  assert.deepEqual(
    [...fallbackAsset.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );
});

test('十段筛选后的视频动作均为可识别 MP4，且不再包含形象不一致的行走片段', async () => {
  const runtimeSource = await readFile(
    new URL('src/components/pet/videoPetRuntime.js', root),
    'utf8'
  );
  const assets = await Promise.all(
    actionAssets.map((asset) =>
      readFile(new URL(`public/videos/alisha/${asset}`, root))
    )
  );

  for (const asset of assets) {
    assert.ok(asset.length > 180_000);
    assert.equal(asset.subarray(4, 8).toString('ascii'), 'ftyp');
  }
  assert.doesNotMatch(runtimeSource, /walk_(left|right|forward)/);
  for (const asset of actionAssets) {
    assert.match(runtimeSource, new RegExp(asset.replace('.', '\\.')));
  }
});

test('播放器使用 V6 容差、固定背景参考、时间平滑蒙版和交叉过渡抑制闪烁', async () => {
  const source = await readFile(
    new URL(
      'src/components/pet/StableVideoPetPlayer.js',
      root
    ),
    'utf8'
  );

  assert.match(source, /const MASK_SIZE = 176/);
  assert.match(source, /threshold = 20/);
  assert.match(source, /this\.backgroundReference/);
  assert.match(source, /this\.previousAlpha/);
  assert.match(source, /previous \* 0\.45 \+ rawAlpha \* 0\.55/);
  assert.match(source, /const TRANSITION_MS = 150/);
  assert.match(source, /requestVideoFrameCallback/);
  assert.match(source, /this\.fpsStartedAt = performance\.now\(\)/);
  assert.doesNotMatch(source, /sampleBackground\([^)]*\)\s*;\s*this\.backgroundReference\s*=/);
});

test('随机行为、动作队列、睡眠唤醒和防连点状态由统一运行时管理', async () => {
  const [componentSource, runtimeSource] = await Promise.all([
    readFile(
      new URL('src/components/pet/CatPet.jsx', root),
      'utf8'
    ),
    readFile(
      new URL('src/components/pet/videoPetRuntime.js', root),
      'utf8'
    ),
  ]);

  assert.match(componentSource, /selectVideoPetAmbient/);
  assert.match(componentSource, /requestVideoPetAction/);
  assert.match(componentSource, /requestVideoPetSleep/);
  assert.match(componentSource, /completeVideoPetAction/);
  assert.match(componentSource, /setInterval\(behaviorTick, 500\)/);
  assert.match(runtimeSource, /quietWeight: 38/);
  assert.match(runtimeSource, /count >= 5/);
  assert.match(runtimeSource, /value: 'annoyed', weight: 88/);
  assert.match(runtimeSource, /request\.source === 'ambient'/);
  assert.match(runtimeSource, /action: 'wake'/);
});

test('点击、长按、拖动、鼠标靠近、滚动停止和页面板块均接入互动', async () => {
  const source = await readFile(
    new URL('src/components/pet/CatPet.jsx', root),
    'utf8'
  );

  assert.match(source, /onPointerDown=\{handlePointerDown\}/);
  assert.match(source, /onPointerMove=\{handlePointerMove\}/);
  assert.match(source, /onPointerUp=\{handlePointerUp\}/);
  assert.match(source, /reactionRef\.current\('longpress'\)/);
  assert.match(source, /event: 'proximity'/);
  assert.match(source, /event: 'scrollStop'/);
  assert.match(source, /SECTION_IDS/);
  for (const id of [
    'about',
    'daily',
    'reading',
    'travel',
    'photography',
    'song',
  ]) {
    assert.match(source, new RegExp(`'${id}'`));
  }
});

test('运行时配置、隐藏恢复、响应式和无障碍交互保持可用', async () => {
  const [componentSource, cssSource, config] = await Promise.all([
    readFile(
      new URL('src/components/pet/CatPet.jsx', root),
      'utf8'
    ),
    readFile(
      new URL('src/components/pet/CatPet.css', root),
      'utf8'
    ),
    readFile(
      new URL('public/alisha.config.json', root),
      'utf8'
    ).then(JSON.parse),
  ]);

  assert.equal(config.position.right, 32);
  assert.equal(config.position.bottom, 32);
  assert.equal(config.size.desktop, 96);
  assert.equal(config.size.mobile, 72);
  assert.match(componentSource, /fetch\('\/alisha\.config\.json'/);
  assert.match(componentSource, /daily-demo-alisha-hidden-v1/);
  assert.match(componentSource, /aria-label="隐藏页面宠物阿丽莎"/);
  assert.match(componentSource, /aria-label="显示页面宠物阿丽莎"/);
  assert.match(componentSource, /tabIndex=\{0\}/);
  assert.match(componentSource, /StaticFallback/);
  assert.match(componentSource, /is-avoiding-controls/);
  assert.match(cssSource, /@media \(max-width: 700px\)/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/);
  assert.match(cssSource, /touch-action: none/);
  assert.match(cssSource, /contain: layout style/);
  assert.match(cssSource, /overflow-wrap: anywhere/);
  assert.match(cssSource, /translate3d\(27%, 20%, 0\)/);
  assert.doesNotMatch(
    cssSource,
    /\.cat-video-pet\.is-avoiding-controls\s*\{[^}]*calc\(/s
  );
});
