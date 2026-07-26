import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('首屏标题在桌面、平板和手机端保持克制的字号上限', async () => {
  const source = await readFile(new URL('src/design-system.css', root), 'utf8');
  const heroSizes = Array.from(
    source.matchAll(/#about h1\s*\{[^}]*font-size:\s*clamp\(([^)]+)\)/gs),
    (match) => match[1].replace(/\s+/g, '')
  );

  assert.deepEqual(heroSizes, [
    '3.5rem,5.6vw,5.3rem',
    '3.2rem,8.5vw,4.5rem',
    '2.85rem,12vw,3.9rem',
  ]);
});
