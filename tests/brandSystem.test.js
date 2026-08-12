import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { siteBrand } from '../src/data/site.js';

const root = new URL('../', import.meta.url);

test('brand identity has one reusable application source', () => {
  assert.equal(siteBrand.name, '四十四次日落');
  assert.equal(siteBrand.lockup, '四十四次日落 / Dylan');
  assert.equal(siteBrand.ownerAlias, 'Dylan');
  assert.equal(siteBrand.url, 'https://www.littlearisa88.com/');
  assert.match(siteBrand.description, /日常、阅读、旅行、摄影与音乐/);
});

test('hero and navigation consume the shared brand source', async () => {
  const [about, sidebar, profile] = await Promise.all([
    readFile(new URL('src/components/About.jsx', root), 'utf8'),
    readFile(new URL('src/components/Sidebar.jsx', root), 'utf8'),
    readFile(new URL('src/utils/siteProfile.js', root), 'utf8'),
  ]);

  assert.match(about, /about-lockup-name/);
  assert.match(about, /siteBrand\.name/);
  assert.match(about, /about-lockup-owner/);
  assert.match(about, /siteBrand\.ownerAlias/);
  assert.match(about, /profile\.tagline/);
  assert.match(about, /profile\.intro/);
  assert.match(profile, /tagline: siteBrand\.tagline/);
  assert.match(profile, /intro: siteBrand\.intro/);
  assert.match(sidebar, /siteBrand\.ownerAlias/);
  assert.match(sidebar, /document\.title = activeSection === 'about'/);
  assert.match(sidebar, /`\$\{currentSection\.label\} · \$\{siteBrand\.name\}`/);
  assert.match(sidebar, /aria-current=\{activeSection === item\.id \? 'page' : undefined\}/);
  assert.match(sidebar, /aria-label="主导航"/);
});

test('browser and sharing metadata consistently use the brand identity', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>四十四次日落<\/title>/);
  assert.match(html, /property="og:site_name" content="四十四次日落"/);
  assert.match(html, /property="og:title" content="四十四次日落 \/ Dylan"/);
  assert.match(html, /name="twitter:title" content="四十四次日落 \/ Dylan"/);
  assert.match(html, /rel="manifest" href="\/site\.webmanifest"/);
  assert.match(html, /type="application\/ld\+json"/);
  assert.match(html, /"@type": "WebSite"/);
  assert.doesNotMatch(html, /Dylan - Personal Site/);
});

test('manifest and favicon expose branded install surfaces', async () => {
  const [manifestText, favicon] = await Promise.all([
    readFile(new URL('public/site.webmanifest', root), 'utf8'),
    readFile(new URL('public/favicon.svg', root), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, siteBrand.name);
  assert.equal(manifest.lang, 'zh-CN');
  assert.equal(manifest.theme_color, '#f6f1e8');
  assert.equal(manifest.icons[0].src, '/favicon.svg');
  assert.match(favicon, />44<\/text>/);
  assert.match(favicon, /#9d553a/);
});

test('page ends with a reusable, accessible brand footer', async () => {
  const [app, footer, css] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/BrandFooter.jsx', root), 'utf8'),
    readFile(new URL('src/visual-system.css', root), 'utf8'),
  ]);

  assert.match(app, /<Links \/>[\s\S]*?<BrandFooter \/>/);
  assert.match(footer, /siteBrand\.name/);
  assert.match(footer, /把普通日子收进时间里。/);
  assert.match(footer, /aria-label="网站信息"/);
  assert.match(footer, /href="#about"/);
  assert.match(footer, /scrollIntoView\(\{ behavior: 'smooth' \}\)/);
  assert.match(css, /\.brand-footer \{/);
  assert.match(css, /\.brand-footer-return \{/);
  assert.match(css, /padding-bottom: calc\(var\(--space-6\) \+ env\(safe-area-inset-bottom\)\)/);
});

test('brand motion is restrained and has an explicit reduced-motion fallback', async () => {
  const [filmCss, visualCss] = await Promise.all([
    readFile(new URL('src/components/about/AboutFilm.css', root), 'utf8'),
    readFile(new URL('src/visual-system.css', root), 'utf8'),
  ]);

  assert.match(filmCss, /\.about-film-content \{[\s\S]*?animation: about-brand-arrival 720ms/);
  assert.match(filmCss, /@keyframes about-brand-arrival/);
  assert.match(filmCss, /translateY\(14px\)/);
  assert.match(
    filmCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.about-film-content \{[\s\S]*?animation: none/
  );
  assert.match(
    visualCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.brand-footer-return:hover svg \{[\s\S]*?transform: none/
  );
});

test('brand lockup never breaks inside the Chinese name or owner signature', async () => {
  const css = await readFile(new URL('src/visual-system.css', root), 'utf8');

  assert.match(css, /#about h1 \{[\s\S]*?text-wrap: wrap/);
  assert.match(css, /\.about-lockup-name,[\s\S]*?\.about-lockup-owner \{[\s\S]*?display: inline-block/);
  assert.match(css, /@media \(min-width: 1180px\)[\s\S]*?\.about-film-content \{[\s\S]*?max-width: min\(860px, 90%\)/);
});
