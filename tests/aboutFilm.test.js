import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ABOUT_FILMS,
  getAboutFilmProgress,
  shouldAutoplayAboutFilm,
  shouldCrossfadeAboutFilm,
} from '../src/utils/aboutFilm.js';

const root = new URL('../', import.meta.url);

test('首屏背景只在适合的桌面网络环境自动播放', () => {
  assert.equal(shouldAutoplayAboutFilm({ desktop: true }), true);
  assert.equal(shouldAutoplayAboutFilm({ desktop: false }), false);
  assert.equal(
    shouldAutoplayAboutFilm({ desktop: true, reducedMotion: true }),
    false
  );
  assert.equal(
    shouldAutoplayAboutFilm({ desktop: true, saveData: true }),
    false
  );
  assert.equal(
    shouldAutoplayAboutFilm({ desktop: true, effectiveType: '3g' }),
    false
  );
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

test('两支影片共享一条稳定的总进度', () => {
  assert.equal(getAboutFilmProgress(0, 15, [30, 30]), 0.25);
  assert.equal(getAboutFilmProgress(1, 0, [30, 30]), 0.5);
  assert.equal(getAboutFilmProgress(1, 30, [30, 30]), 1);
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
