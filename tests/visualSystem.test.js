import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function luminance(hex) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test('visual convergence layer loads last and exposes the shared token contract', async () => {
  const [entry, css] = await Promise.all([
    readFile(new URL('src/main.jsx', root), 'utf8'),
    readFile(new URL('src/visual-system.css', root), 'utf8'),
  ]);

  const designImport = entry.indexOf("import './design-system.css'");
  const visualImport = entry.indexOf("import './visual-system.css'");

  assert.ok(designImport >= 0);
  assert.ok(visualImport > designImport);

  for (const token of [
    '--paper',
    '--surface-elevated',
    '--ink',
    '--ink-muted',
    '--accent',
    '--space-4',
    '--type-section',
    '--control-md',
    '--focus-ring',
  ]) {
    assert.match(css, new RegExp(`${token}:`));
  }
});

test('shared text colors meet WCAG AA contrast on the paper background', () => {
  assert.ok(contrast('#28241f', '#f6f1e8') >= 4.5);
  assert.ok(contrast('#514b43', '#f6f1e8') >= 4.5);
  assert.ok(contrast('#686158', '#f6f1e8') >= 4.5);
  assert.ok(contrast('#793f2b', '#f6f1e8') >= 4.5);
});

test('foundation defines desktop, tablet, mobile and reduced-motion contracts', async () => {
  const css = await readFile(new URL('src/visual-system.css', root), 'utf8');

  assert.match(css, /@media \(max-width: 1180px\) and \(min-width: 1000px\)/);
  assert.match(css, /@media \(max-width: 999px\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.content > section/);
  assert.match(css, /\.content \{[\s\S]*?width: auto;[\s\S]*?margin: 0 var\(--page-gutter\)/);
  assert.match(css, /\.section-heading h2/);
});

test('shared controls, surfaces and feedback states use the same semantic tokens', async () => {
  const css = await readFile(new URL('src/visual-system.css', root), 'utf8');

  assert.match(css, /:where\(\.ui-btn, \.upload-btn\)/);
  assert.match(css, /:where\(\.tag-chip, \.reading-filter, \.entry-tag\)/);
  assert.match(css, /:where\(\.entry, \.book-card, \.song-card, \.links li/);
  assert.match(css, /\.ui-modal-panel[\s\S]*?var\(--surface-elevated\)/);
  assert.match(css, /\.ui-toast-success[\s\S]*?var\(--success-soft\)/);
  assert.match(css, /\.ui-toast-error[\s\S]*?var\(--danger-soft\)/);
  assert.match(css, /\.ui-empty,[\s\S]*?\.ui-loading-block/);
});

test('public interaction copy remains consistently Chinese', async () => {
  const sources = await Promise.all([
    readFile(new URL('src/components/photography/Photography.jsx', root), 'utf8'),
    readFile(new URL('src/components/travel/Travel.jsx', root), 'utf8'),
    readFile(new URL('src/components/Sidebar.jsx', root), 'utf8'),
    readFile(new URL('src/components/ui/Modal.jsx', root), 'utf8'),
    readFile(new URL('src/components/ui/EmptyState.jsx', root), 'utf8'),
  ]);
  const source = sources.join('\n');

  assert.doesNotMatch(source, /Upload Photo|Upload Video|Loading videos|Uploading\.\.\.|Nothing here yet|>\s*Logout\s*</);
  assert.match(source, /上传照片/);
  assert.match(source, /上传视频/);
  assert.match(source, /退出登录/);
  assert.match(source, /这里暂时没有内容/);
});

test('all content sections share toolbar, card and media framing contracts', async () => {
  const [css, travel] = await Promise.all([
    readFile(new URL('src/visual-system.css', root), 'utf8'),
    readFile(new URL('src/components/travel/Travel.jsx', root), 'utf8'),
  ]);

  assert.match(css, /\.daily-toolbar,[\s\S]*?\.reading-toolbar/);
  assert.match(css, /\.daily-section \.layout-grid/);
  assert.match(css, /\.reading-results \.book-card/);
  assert.match(css, /\.video-track \.video-card,[\s\S]*?\.video-track \.travel-video/);
  assert.match(css, /\.photo-img-wrapper[\s\S]*?aspect-ratio: 4 \/ 3/);
  assert.match(css, /\.song-card-variant-0,[\s\S]*?\.song-card-variant-2/);
  assert.match(css, /\.links li/);
  assert.doesNotMatch(travel, /style=\{\{ width: '200px'/);
});

test('mobile convergence preserves touch, single-column and motion preferences', async () => {
  const css = await readFile(new URL('src/visual-system.css', root), 'utf8');
  const mobile = css.slice(css.lastIndexOf('@media (max-width: 700px)'));

  assert.match(mobile, /:where\(\.tag-chip, \.reading-filter\)[\s\S]*?min-height: 40px/);
  assert.match(mobile, /\.photo-grid[\s\S]*?grid-template-columns: 1fr/);
  assert.match(mobile, /\.links[\s\S]*?grid-template-columns: 1fr/);
  assert.match(mobile, /\.ui-modal-panel[\s\S]*?max-height: min\(88dvh, 760px\)/);
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\)/);
});

test('photo cards and modal remain keyboard operable', async () => {
  const [photography, modal, song] = await Promise.all([
    readFile(new URL('src/components/photography/Photography.jsx', root), 'utf8'),
    readFile(new URL('src/components/ui/Modal.jsx', root), 'utf8'),
    readFile(new URL('src/components/song/Song.jsx', root), 'utf8'),
  ]);

  assert.match(photography, /role="button"/);
  assert.match(photography, /tabIndex=\{0\}/);
  assert.match(photography, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(modal, /focusableSelector/);
  assert.match(modal, /previousFocusRef\.current\?\.focus/);
  assert.match(modal, /aria-labelledby=\{title \? titleId : undefined\}/);
  assert.doesNotMatch(song, /className="song-grid" aria-hidden="true"/);
});
