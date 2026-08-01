import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveMediaUrl } from '../src/utils/media.js';

const root = new URL('../', import.meta.url);

test('Daily local previews keep browser-owned data and blob URLs intact', () => {
  assert.equal(resolveMediaUrl('blob:https://example.com/local-preview'), 'blob:https://example.com/local-preview');
  assert.equal(resolveMediaUrl('data:image/jpeg;base64,AA=='), 'data:image/jpeg;base64,AA==');
});

test('Daily 视频使用可视区静音循环播放并通过共享浮层开启声音', async () => {
  const source = await readFile(
    new URL('src/components/daily/DailyMedia.jsx', root),
    'utf8'
  );

  assert.match(source, /<TravelVideo[\s\S]*?muted[\s\S]*?loop[\s\S]*?playWhenVisible/);
  assert.match(source, /controls=\{false\}/);
  assert.match(source, /<VideoLightbox[\s\S]*?src=\{url\}/);
});

test('Daily 正文和漂流瓶纸条共用同一媒体渲染器', async () => {
  const [entrySource, noteSource] = await Promise.all([
    readFile(new URL('src/components/daily/DailyEntry.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/drift/BottleNote.jsx', root), 'utf8'),
  ]);

  assert.match(entrySource, /<DailyMedia[\s\S]*?media=\{post\.media\}/);
  assert.match(noteSource, /<DailyMedia[\s\S]*?media=\{post\.media\}[\s\S]*?variant="note"/);
});

test('共享视频浮层自动播放、显示控制栏且明确关闭静音', async () => {
  const source = await readFile(
    new URL('src/components/ui/VideoLightbox.jsx', root),
    'utf8'
  );

  assert.match(source, /<video[\s\S]*?preload="auto"[\s\S]*?controls[\s\S]*?playsInline/);
  assert.match(source, /video\.muted = false/);
  assert.match(source, /video\.muted = true/);
  assert.match(source, /await video\.play\(\)/);
  assert.match(source, /播放并开启声音/);
  assert.match(source, /视频加载失败/);
  assert.doesNotMatch(source, /<TravelVideo/);
});

test('Daily media resolves backend-relative image and video URLs', async () => {
  const source = await readFile(
    new URL('src/components/daily/DailyMedia.jsx', root),
    'utf8'
  );

  assert.match(source, /resolveMediaUrl/);
  assert.match(source, /const resolvedUrl = resolveMediaUrl\(item\.url\)/);
  assert.match(source, /<DailyVideo[\s\S]*?url=\{resolvedUrl\}/);
  assert.match(source, /<LazyImage[\s\S]*?src=\{resolvedUrl\}/);
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
