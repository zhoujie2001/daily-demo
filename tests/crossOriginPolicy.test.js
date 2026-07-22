import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('站点不启用会拦截跨域媒体的 require-corp 策略', async () => {
  const [vercelText, viteText] = await Promise.all([
    readFile(new URL('vercel.json', root), 'utf8'),
    readFile(new URL('vite.config.js', root), 'utf8'),
  ]);

  const vercelConfig = JSON.parse(vercelText);
  const configuredHeaders = (vercelConfig.headers || []).flatMap((route) => route.headers || []);

  assert.equal(
    configuredHeaders.some((header) => String(header.key).toLowerCase() === 'cross-origin-embedder-policy'),
    false
  );
  assert.doesNotMatch(viteText, /Cross-Origin-Embedder-Policy/i);
});

test('视频压缩继续使用不依赖 SharedArrayBuffer 的单线程 FFmpeg core', async () => {
  const source = await readFile(new URL('src/utils/compressVideo.js', root), 'utf8');

  assert.match(source, /@ffmpeg\/core@0\.12\.10/);
  assert.doesNotMatch(source, /@ffmpeg\/core-mt/);
});
