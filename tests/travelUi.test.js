import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('Travel keeps the controlled carousel but renders no thumbnail preview rail', async () => {
  const source = await readFile(new URL('src/components/travel/Travel.jsx', root), 'utf8');

  assert.match(source, /className="video-track travel-carousel-track"/);
  assert.match(source, /className="travel-carousel-controls"/);
  assert.match(source, /className="travel-carousel-arrow"/);
  assert.doesNotMatch(source, /TravelPreviewFrame/);
  assert.doesNotMatch(source, /travel-preview-rail/);
  assert.doesNotMatch(source, /<PreviewRail/);
});
