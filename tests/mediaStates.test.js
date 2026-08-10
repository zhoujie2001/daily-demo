import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('Daily、Travel 与 Reading 共用统一媒体状态组件', async () => {
  const [placeholder, lazyImage, travelVideo, reading, daily, css] =
    await Promise.all([
      readFile(
        new URL('src/components/ui/MediaPlaceholder.jsx', root),
        'utf8'
      ),
      readFile(new URL('src/components/ui/LazyImage.jsx', root), 'utf8'),
      readFile(
        new URL('src/components/travel/TravelVideo.jsx', root),
        'utf8'
      ),
      readFile(
        new URL('src/components/reading/Reading.jsx', root),
        'utf8'
      ),
      readFile(
        new URL('src/components/daily/DailyMedia.jsx', root),
        'utf8'
      ),
      readFile(new URL('src/design-system.css', root), 'utf8'),
    ]);

  assert.match(placeholder, /media-state/);
  assert.match(placeholder, /state === 'error'/);
  assert.match(lazyImage, /<MediaPlaceholder/);
  assert.match(lazyImage, /handleRetry/);
  assert.match(travelVideo, /onLoadedData/);
  assert.match(travelVideo, /state:\s*'error'/);
  assert.match(reading, /kind="book"/);
  assert.match(reading, /state="empty"/);
  assert.match(daily, /照片暂时无法显示/);
  assert.match(css, /Unified media loading, empty and failure states/);
});
