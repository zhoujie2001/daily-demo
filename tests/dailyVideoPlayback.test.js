import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveMediaUrl } from '../src/utils/media.js';

const root = new URL('../', import.meta.url);

test('Daily local previews keep browser-owned data and blob URLs intact', () => {
  assert.equal(resolveMediaUrl('blob:https://example.com/local-preview'), 'blob:https://example.com/local-preview');
  assert.equal(resolveMediaUrl('data:image/jpeg;base64,AA=='), 'data:image/jpeg;base64,AA==');
});

test('Daily videos loop silently in view and open the shared sound lightbox', async () => {
  const source = await readFile(
    new URL('src/components/daily/DailyMedia.jsx', root),
    'utf8'
  );

  assert.match(source, /<TravelVideo[\s\S]*?muted[\s\S]*?loop[\s\S]*?playWhenVisible/);
  assert.match(source, /controls=\{false\}/);
  assert.match(source, /<VideoLightbox[\s\S]*?src=\{url\}/);
});

test('Daily entries and bottle notes share one media renderer', async () => {
  const [entrySource, noteSource] = await Promise.all([
    readFile(new URL('src/components/daily/DailyEntry.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/drift/BottleNote.jsx', root), 'utf8'),
  ]);

  assert.match(entrySource, /<DailyMedia[\s\S]*?media=\{post\.media\}/);
  assert.match(noteSource, /<DailyMedia[\s\S]*?media=\{post\.media\}[\s\S]*?variant="note"/);
});

test('shared lightbox provides deterministic playback, replay, seek and sound controls', async () => {
  const source = await readFile(
    new URL('src/components/ui/VideoLightbox.jsx', root),
    'utf8'
  );

  assert.match(source, /<video[\s\S]*?preload="auto"[\s\S]*?playsInline/);
  assert.match(source, /video\.muted = false/);
  assert.match(source, /video\.muted = true/);
  assert.match(source, /await video\.play\(\)/);
  assert.match(source, /onEnded=/);
  assert.match(source, /重新播放视频/);
  assert.match(source, /aria-label="视频播放进度"/);
  assert.match(source, /handleMuteToggle/);
  assert.match(source, /视频加载失败/);
  assert.match(source, /createPortal/);
  assert.match(source, /document\.body/);
  assert.doesNotMatch(source, /<TravelVideo/);
});

test('Daily media resolves backend-relative image and video URLs', async () => {
  const source = await readFile(
    new URL('src/components/daily/DailyMedia.jsx', root),
    'utf8'
  );

  assert.match(source, /resolveMediaUrl/);
  assert.match(source, /const resolvedUrl = resolveMediaUrl\(item\.url \|\| item\.value\)/);
  assert.match(source, /<DailyVideo[\s\S]*?url=\{resolvedUrl\}/);
  assert.match(source, /<LazyImage[\s\S]*?src=\{resolvedUrl\}/);
});

test('viewport video player pauses after leaving the viewport', async () => {
  const source = await readFile(
    new URL('src/components/travel/TravelVideo.jsx', root),
    'utf8'
  );

  assert.match(source, /entry\.intersectionRatio >= 0\.35/);
  assert.match(source, /video\.muted = true/);
  assert.match(source, /video\.play\(\)/);
  assert.match(source, /video\.pause\(\)/);
});

test('mobile lightbox fills the viewport and keeps controls visible', async () => {
  const [componentSource, cssSource] = await Promise.all([
    readFile(new URL('src/components/ui/VideoLightbox.jsx', root), 'utf8'),
    readFile(new URL('src/index.css', root), 'utf8'),
  ]);

  assert.match(componentSource, /video-lightbox-controls/);
  assert.match(componentSource, /video-lightbox-primary/);
  assert.match(cssSource, /@media \(max-width: 900px\)[\s\S]*?\.video-lightbox-content/);
  assert.match(cssSource, /width: 100vw/);
  assert.match(cssSource, /max-height: 100dvh/);
  assert.match(cssSource, /\.video-lightbox-controls/);
});
