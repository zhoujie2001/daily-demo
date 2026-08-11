import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const actionAssets = [
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
const packedActionAssets = [
  'v8_blink_rgb_alpha.webm',
  'walk_left_rgb_alpha.webm',
  'walk_right_rgb_alpha.webm',
  'walk_forward_rgb_alpha.webm',
];
const h264ActionAssets = [
  'v8_blink_rgb_alpha.mp4',
  ...actionAssets,
  'walk_left_rgb_alpha.mp4',
  'walk_right_rgb_alpha.mp4',
  'walk_forward_rgb_alpha.mp4',
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
  assert.match(appSource, /<CatPet suspended=\{aboutFilmVisible\} \/>/);
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

test('九段实时抠图动作均为可识别 MP4', async () => {
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
  for (const asset of actionAssets) {
    assert.match(runtimeSource, new RegExp(asset.replace('.', '\\.')));
  }
});

test('十三段生产动作均提供浏览器通用的 H.264 主资源', async () => {
  const [runtimeSource, ...assets] = await Promise.all([
    readFile(
      new URL('src/components/pet/videoPetRuntime.js', root),
      'utf8'
    ),
    ...h264ActionAssets.map((asset) =>
      readFile(new URL(`public/videos/alisha/h264/${asset}`, root))
    ),
  ]);

  for (const asset of assets) {
    assert.ok(asset.length > 180_000);
    assert.equal(asset.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.match(asset.toString('latin1'), /avc1/);
    assert.doesNotMatch(asset.toString('latin1'), /hvc1|hev1/);
  }
  assert.match(runtimeSource, /video\/mp4; codecs="avc1\.42E01E"/);
  assert.match(runtimeSource, /video\/webm; codecs="vp9"/);
});

test('眨眼和行走动作使用同帧 RGB 与 Alpha 素材，避免背景穿透主体', async () => {
  const [runtimeSource, playerSource, ...packedAssets] = await Promise.all([
    readFile(
      new URL('src/components/pet/videoPetRuntime.js', root),
      'utf8'
    ),
    readFile(
      new URL(
        'src/components/pet/StableVideoPetPlayer.js',
        root
      ),
      'utf8'
    ),
    ...packedActionAssets.map((asset) =>
      readFile(new URL(`public/videos/alisha/${asset}`, root))
    ),
  ]);

  for (const packedAsset of packedAssets) {
    assert.ok(packedAsset.length > 100_000);
    assert.deepEqual(
      [...packedAsset.subarray(0, 4)],
      [0x1a, 0x45, 0xdf, 0xa3]
    );
  }
  for (const asset of packedActionAssets) {
    assert.match(runtimeSource, new RegExp(asset.replace('.', '\\.')));
  }
  assert.match(runtimeSource, /matteMode: 'packed-horizontal'/);
  assert.match(playerSource, /renderPackedAlpha/);
  assert.match(playerSource, /source\.videoWidth/);
  assert.match(playerSource, /globalCompositeOperation = 'destination-in'/);
});

test('播放器使用 V6 容差、固定背景参考、时间平滑蒙版和交叉过渡抑制闪烁', async () => {
  const source = await readFile(
    new URL(
      'src/components/pet/StableVideoPetPlayer.js',
      root
    ),
    'utf8'
  );

  assert.match(source, /resolvePetMaskSize/);
  assert.match(source, /createPetProtectionMask/);
  assert.match(source, /createPetEnvelopeMask/);
  assert.match(source, /createSpatialBackgroundModel/);
  assert.match(source, /stabilizePetAlpha/);
  assert.match(source, /threshold = 20/);
  assert.match(source, /this\.backgroundReference/);
  assert.match(source, /this\.previousAlpha/);
  assert.match(source, /detailBoost/);
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
  assert.match(componentSource, /setInterval\(behaviorTick, 200\)/);
  assert.match(
    componentSource,
    /controllerRef\.current\.current\?\.action !== finishedAction/
  );
  assert.match(
    componentSource,
    /behaviorRef\.current = scheduleVideoPetAmbient\([\s\S]*timestamp/
  );
  assert.match(runtimeSource, /ambientDelay: \{ min: 2_000, max: 2_000 \}/);
  assert.match(runtimeSource, /sleepDelay: \{ min: 30_000, max: 30_000 \}/);
  assert.match(runtimeSource, /quietWeight: 0/);
  assert.match(runtimeSource, /mobileQuietWeight: 0/);
  assert.match(runtimeSource, /action\.kind === 'movement'/);
  assert.match(runtimeSource, /count >= 5/);
  assert.match(runtimeSource, /value: 'annoyed', weight: 88/);
  assert.match(runtimeSource, /request\.source === 'ambient'/);
  assert.match(runtimeSource, /controller\.current\.source === 'ambient'/);
  assert.match(runtimeSource, /current: controller\.current/);
  assert.match(runtimeSource, /queue: \[request\]/);
  assert.match(runtimeSource, /AMBIENT_RECOVERY_ACTIONS/);
  assert.match(runtimeSource, /!request\.canWake/);
  assert.match(runtimeSource, /action: 'wake'/);
  assert.match(componentSource, /\{ force: true \}/);
  assert.match(componentSource, /resolveVideoPetSpeech/);
  assert.match(componentSource, /speechDecision\.tone/);
  assert.match(componentSource, /selectVideoPetRecovery/);
  assert.match(componentSource, /reducedMotion,/);
  assert.doesNotMatch(
    componentSource,
    /document\.hidden\s*\|\|\s*reducedMotion/
  );
  assert.match(componentSource, /unavailableActions\.add\(actionKey\)/);
  assert.match(componentSource, /playbackResult\.status === 'failed'/);
  assert.match(componentSource, /result\.accepted && !result\.command/);
  assert.doesNotMatch(
    componentSource,
    /这个动作暂时没有加载好/
  );
  assert.match(runtimeSource, /unavailableActions\.has\(actionKey\)/);
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

test('运行时配置、常驻显示、响应式和无障碍交互保持可用', async () => {
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
  assert.equal(config.render.chromaTolerance, 20);
  assert.equal(config.timings.petActionIntervalMs, 2000);
  assert.equal(config.timings.sleepAfterMs, 30000);
  assert.equal(config.timings.speechCooldownMs, 18000);
  assert.equal(config.timings.ambientSpeechChance, 0.05);
  assert.equal(config.timings.contextSpeechChance, 0.18);
  assert.match(componentSource, /fetch\('\/alisha\.config\.json'/);
  assert.doesNotMatch(componentSource, /daily-demo-alisha-hidden-v1/);
  assert.match(
    componentSource,
    /daily-demo-alisha-video-position-v3/
  );
  assert.match(
    componentSource,
    /threshold: config\.render\.chromaTolerance/
  );
  assert.match(
    componentSource,
    /data-chroma-tolerance=\{config\.render\.chromaTolerance\}/
  );
  assert.doesNotMatch(componentSource, /cat-video-pet-hide/);
  assert.doesNotMatch(componentSource, /cat-video-pet-restore/);
  assert.match(componentSource, /tabIndex=\{0\}/);
  assert.match(componentSource, /StaticFallback/);
  assert.match(componentSource, /is-avoiding-controls/);
  assert.match(cssSource, /@media \(max-width: 700px\)/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/);
  assert.match(cssSource, /touch-action: none/);
  assert.match(cssSource, /contain: layout style/);
  assert.match(cssSource, /overflow-wrap: anywhere/);
  assert.match(cssSource, /\.cat-video-pet-speech\.is-whisper/);
  assert.match(cssSource, /@keyframes alisha-video-speech-out/);
  assert.match(cssSource, /translate3d\(27%, 20%, 0\)/);
  assert.doesNotMatch(
    cssSource,
    /\.cat-video-pet\.is-avoiding-controls\s*\{[^}]*(?:width|height):\s*56px/s
  );
  assert.doesNotMatch(
    cssSource,
    /\.cat-video-pet\.is-avoiding-controls\s*\{[^}]*calc\(/s
  );
});
