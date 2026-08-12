import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_SITE_PROFILE,
  SITE_PROFILE_LIMITS,
  extractRemoteSiteProfile,
  normalizeSiteProfile,
  profilesEqual,
  validateSiteProfile,
} from '../src/utils/siteProfile.js';
import { loadSiteProfile, saveSiteProfile } from '../src/api/siteProfile.js';

const root = new URL('../', import.meta.url);

test('site profile normalization trims whitespace and keeps brand fallbacks', () => {
  assert.deepEqual(normalizeSiteProfile({ tagline: '  Hello   world ', intro: '  简介  ' }), {
    tagline: 'Hello world',
    intro: '简介',
  });
  assert.deepEqual(normalizeSiteProfile(null), DEFAULT_SITE_PROFILE);
});

test('site profile validation rejects blanks and overlong copy', () => {
  const blank = validateSiteProfile({ tagline: ' ', intro: '' });
  assert.equal(blank.valid, false);
  assert.ok(blank.errors.tagline);
  assert.ok(blank.errors.intro);

  const overlong = validateSiteProfile({
    tagline: 'x'.repeat(SITE_PROFILE_LIMITS.tagline + 1),
    intro: '简介',
  });
  assert.equal(overlong.valid, false);
  assert.ok(overlong.errors.tagline);
});

test('remote profile extraction requires a complete pair and accepts profile envelopes', () => {
  assert.deepEqual(extractRemoteSiteProfile({
    profile: { tagline: ' Tagline ', intro: ' 说明 ' },
  }), { tagline: 'Tagline', intro: '说明' });
  assert.equal(extractRemoteSiteProfile({ tagline: 'Tagline' }), null);
  assert.equal(profilesEqual(
    { tagline: 'Hello  world', intro: '说明' },
    { tagline: 'Hello world', intro: ' 说明 ' }
  ), true);
});

test('an unsynchronized local edit is not overwritten by stale remote copy', async () => {
  const storage = new Map([
    ['site-profile-v1', JSON.stringify({ tagline: 'Local edit', intro: '本地修改' })],
    ['site-profile-v1-pending', 'true'],
  ]);
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ tagline: 'Remote old copy', intro: '远端旧内容' }),
  });

  try {
    assert.deepEqual(await loadSiteProfile(), {
      profile: { tagline: 'Local edit', intro: '本地修改' },
      source: 'local',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('saving a profile sends bearer authentication and clears pending state after sync', async () => {
  const storage = new Map();
  let requestOptions;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => body };
  };

  try {
    const result = await saveSiteProfile({
      token: 'admin-token',
      value: { tagline: 'New tagline', intro: '新说明' },
    });
    assert.equal(result.synchronized, true);
    assert.equal(requestOptions.headers.Authorization, 'Bearer admin-token');
    assert.equal(storage.get('site-profile-v1-pending'), 'false');
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('hero profile editor is admin-only, accessible, and wired to persistence', async () => {
  const [app, about, css] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(new URL('src/components/About.jsx', root), 'utf8'),
    readFile(new URL('src/visual-system.css', root), 'utf8'),
  ]);

  assert.match(app, /adminToken=\{token\}/);
  assert.match(about, /loadSiteProfile\(\)/);
  assert.match(about, /saveSiteProfile\(\{ token: adminToken/);
  assert.match(about, /isAdmin \? \(/);
  assert.match(about, /aria-label="编辑首页简介"/);
  assert.match(about, /maxLength=\{SITE_PROFILE_LIMITS\.tagline\}/);
  assert.match(about, /maxLength=\{SITE_PROFILE_LIMITS\.intro\}/);
  assert.match(about, /event\.currentTarget\.requestSubmit\(\)/);
  assert.match(css, /\.about-profile-edit-button \{/);
  assert.match(css, /\.about-profile-editor \{/);
  assert.match(css, /\.about-profile-editor-actions button \{[\s\S]*?min-height: 44px/);
});
