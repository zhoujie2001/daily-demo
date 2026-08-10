import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ABOUT_FILMS,
  ABOUT_FILM_PLAY_ATTEMPT_TIMEOUT_MS,
  ABOUT_FILM_RETRY_DELAYS,
  ABOUT_FILM_STALL_RECOVERY_MS,
  shouldCrossfadeAboutFilm,
} from '../src/utils/aboutFilm.js';

const root = new URL('../', import.meta.url);

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

test('首屏视频使用静音自动播放、顺序循环且不再渲染播放按钮', async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL('src/components/about/AboutFilm.jsx', root), 'utf8'),
    readFile(new URL('src/components/about/AboutFilm.css', root), 'utf8'),
  ]);

  assert.match(component, /autoPlay=\{motionEnabled && index === 0\}/);
  assert.match(component, /muted/);
  assert.match(component, /defaultMuted/);
  assert.match(component, /playsInline/);
  assert.match(component, /restartSequence\(\)/);
  assert.doesNotMatch(component, /setEnded\(true\)/);
  assert.doesNotMatch(component, /about-film-control/);
  assert.doesNotMatch(styles, /about-film-control/);
});

test('首屏提供稳定海报且系统减少动态不会关闭背景视频', async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL('src/components/about/AboutFilm.jsx', root), 'utf8'),
    readFile(new URL('src/components/about/AboutFilm.css', root), 'utf8'),
  ]);

  assert.match(component, /data-motion=\{motionEnabled \? 'video' : 'poster'\}/);
  assert.doesNotMatch(component, /about-film-motion-toggle/);
  assert.doesNotMatch(component, /window\.localStorage/);
  assert.match(component, /poster-mobile\.webp/);
  assert.match(component, /poster-desktop\.webp/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /about-film-motion-toggle/);
  assert.doesNotMatch(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.about-film-videos\s*\{\s*display:\s*none/
  );
});

test('背景影片使用有界多级重试并在卡顿后自动恢复', async () => {
  const component = await readFile(
    new URL('src/components/about/AboutFilm.jsx', root),
    'utf8'
  );

  assert.deepEqual(ABOUT_FILM_RETRY_DELAYS, [0, 350, 900, 1800]);
  assert.equal(ABOUT_FILM_STALL_RECOVERY_MS, 1600);
  assert.equal(ABOUT_FILM_PLAY_ATTEMPT_TIMEOUT_MS, 3500);
  assert.match(component, /attemptIndex < ABOUT_FILM_RETRY_DELAYS\.length/);
  assert.match(component, /Promise\.race\(\[/);
  assert.match(component, /onWaiting=\{\(\) => handlePlaybackInterruption\(index\)\}/);
  assert.match(component, /onStalled=\{\(\) => handlePlaybackInterruption\(index\)\}/);
  assert.match(component, /onError=\{\(\) => handlePlaybackError\(index\)\}/);
  assert.match(component, /window\.addEventListener\('online', recoverActiveFilm\)/);
});

test('只有真实播放后才隐藏海报，并可由用户交互唤醒', async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL('src/components/about/AboutFilm.jsx', root), 'utf8'),
    readFile(new URL('src/components/about/AboutFilm.css', root), 'utf8'),
  ]);

  assert.match(component, /onPlaying=\{\(\) => handlePlaying\(index\)\}/);
  assert.doesNotMatch(component, /onCanPlay=/);
  assert.doesNotMatch(component, /onLoadedData=/);
  assert.match(component, /data-playback=\{playbackState\}/);
  assert.match(component, /window\.addEventListener\('pointerdown', recoverOnInteraction/);
  assert.match(component, /window\.addEventListener\('touchstart', recoverOnInteraction/);
  assert.match(styles, /\.about-film\.is-ready\.is-motion-enabled \.about-film-video\.is-active/);
});

test('第二段影片重试成功后会切换可见影片，失败则立即重启第一段', async () => {
  const component = await readFile(
    new URL('src/components/about/AboutFilm.jsx', root),
    'utf8'
  );

  assert.match(component, /if \(started\) \{[\s\S]*?commitActiveFilm\(index\)/);
  assert.match(component, /requestPlayback\(1, \{[\s\S]*?onFailure:[\s\S]*?requestPlayback\(0, \{ reset: true \}\)/);
  assert.match(component, /if \(index === 0\) beginSecondFilm\(\);[\s\S]*?else restartSequence\(\);/);
});
