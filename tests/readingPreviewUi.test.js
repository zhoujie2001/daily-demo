import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('Reading uses real book previews to navigate and focus a book card', async () => {
  const source = await readFile(new URL('src/components/reading/Reading.jsx', root), 'utf8');

  assert.match(source, /createReadingBookPreviews/);
  assert.match(source, /data-book-preview-id=/);
  assert.match(source, /changePage\(preview\.page, preview\.id\)/);
  assert.match(source, /scrollIntoView/);
  assert.match(source, /is-preview-target/);
  assert.doesNotMatch(source, /createReadingPagePreviews/);
  assert.doesNotMatch(source, /ReadingPagePreview/);
});

test('Reading hides previews on desktop and reveals them on mobile', async () => {
  const css = await readFile(new URL('src/visual-system.css', root), 'utf8');
  const desktopRule = css.match(/\.reading-book-preview-rail\s*\{([^}]*)\}/)?.[1] || '';
  const mobileBlock = css.match(/@media \(width <= 700px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(desktopRule, /display:\s*none/);
  assert.match(mobileBlock, /\.reading-book-preview-rail\s*\{[\s\S]*?display:\s*flex/);
  assert.match(mobileBlock, /\.reading-page-button\s*\{[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/);
});
