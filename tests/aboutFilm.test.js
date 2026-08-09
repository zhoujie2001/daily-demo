import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ABOUT_FILMS,
  shouldAutoplayAboutFilm,
  shouldCrossfadeAboutFilm,
} from '../src/utils/aboutFilm.js';

const root = new URL('../', import.meta.url);

test('桌面与移动端都自动播放，减少动态效果时使用静态封面', () => {
  assert.equal(shouldAutoplayAboutFilm(), true);
  assert.equal(shouldAutoplayAboutFilm({ desktop: true }), true);
  assert.equal(shouldAutoplayAboutFilm({ desktop: false }), true);
  assert.equal(shouldAutoplayAboutFilm({ saveData: true }), true);
  assert.equal(shouldAutoplayAboutFilm({ effectiveType: '3g' }), true);
  assert.equal(shouldAutoplayAboutFilm({ reducedMotion: true }), false);
});

test('第一支影片只在末尾进入交叉淡化区', () => {
  assert.equal(
    shouldCrossfadeAboutFilm({ index: 0, currentTime: 28, duration: 30 }),
    false
  );
  assert.equal(
    shouldCrossfadeAboutFilm({ index: 0, currentTime: 29, duration: 30 }),
    true
  );
  assert.equal(
    shouldCrossfadeAboutFilm({ index: 1, currentTime: 29, duration: 30 }),
    false
  );
});

test('网页背景资源存在且为可识别格式', async () => {
  assert.deepEqual(
    ABOUT_FILMS.map(({ id }) => id),
    ['forty-fourth-sunset', 'drift-bottle']
  );

  const [sunset, bottle, posterDesktop, posterMobile] = await Promise.all([
    readFile(new URL('public/media/about/forty-fourth-sunset.mp4', root)),
    readFile(new URL('public/media/about/drift-bottle.mp4', root)),
    readFile(new URL('public/media/about/poster-desktop.webp', root)),
    readFile(new URL('public/media/about/poster-mobile.webp', root)),
  ]);

  for (const video of [sunset, bottle]) {
    assert.ok(video.length > 1_000_000);
    assert.equal(video.subarray(4, 8).toString('ascii'), 'ftyp');
  }
  for (const poster of [posterDesktop, posterMobile]) {
    assert.equal(poster.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(poster.subarray(8, 12).toString('ascii'), 'WEBP');
  }
});

test('首屏视频使用静音自动播放且不再渲染播放按钮', async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL('src/components/about/AboutFilm.jsx', root), 'utf8'),
    readFile(new URL('src/components/about/AboutFilm.css', root), 'utf8'),
  ]);

  assert.match(component, /autoPlay=\{index === 0 && motionEnabled\}/);
  assert.match(component, /muted/);
  assert.match(component, /playsInline/);
  assert.doesNotMatch(component, /about-film-control/);
  assert.doesNotMatch(styles, /about-film-control/);
});
