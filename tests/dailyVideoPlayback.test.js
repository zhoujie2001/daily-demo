import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('Daily 视频使用可视区静音循环播放并通过共享浮层开启声音', async () => {
  const source = await readFile(
    new URL('src/components/daily/DailyEntry.jsx', root),
    'utf8'
  );

  assert.match(source, /<TravelVideo[\s\S]*?muted[\s\S]*?loop[\s\S]*?playWhenVisible/);
  assert.match(source, /controls=\{false\}/);
  assert.match(source, /<VideoLightbox[\s\S]*?src=\{url\}/);
});

test('共享视频浮层自动播放、显示控制栏且明确关闭静音', async () => {
  const source = await readFile(
    new URL('src/components/ui/VideoLightbox.jsx', root),
    'utf8'
  );

  assert.match(source, /<TravelVideo[\s\S]*?autoPlay[\s\S]*?controls/);
  assert.match(source, /muted=\{false\}/);
  assert.match(source, /disableHover/);
});

test('可视区播放器进入视口播放并在离开视口后暂停', async () => {
  const source = await readFile(
    new URL('src/components/travel/TravelVideo.jsx', root),
    'utf8'
  );

  assert.match(source, /entry\.intersectionRatio >= 0\.35/);
  assert.match(source, /video\.muted = true/);
  assert.match(source, /video\.play\(\)/);
  assert.match(source, /video\.pause\(\)/);
});

test('移动端视频浮层占满可用视口且保留视频原始比例', async () => {
  const [componentSource, cssSource] = await Promise.all([
    readFile(new URL('src/components/travel/TravelVideo.jsx', root), 'utf8'),
    readFile(new URL('src/index.css', root), 'utf8'),
  ]);

  assert.match(componentSource, /height: style\?\.height \?\? '100%'/);
  assert.match(cssSource, /@media \(max-width: 900px\)[\s\S]*?\.video-lightbox-content/);
  assert.match(cssSource, /width: 100vw/);
  assert.match(cssSource, /max-height: 100dvh/);
});
