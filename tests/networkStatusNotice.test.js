import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('网络失败使用非阻断状态提示而不是模态弹窗', async () => {
  const [app, notice, css] = await Promise.all([
    readFile(new URL('src/App.jsx', root), 'utf8'),
    readFile(
      new URL('src/components/ui/NetworkStatusNotice.jsx', root),
      'utf8'
    ),
    readFile(new URL('src/design-system.css', root), 'utf8'),
  ]);

  assert.match(app, /NetworkStatusNotice/);
  assert.doesNotMatch(app, /NetworkAlertDialog/);
  assert.match(notice, /role="status"/);
  assert.match(notice, /aria-live="polite"/);
  assert.doesNotMatch(notice, /role="dialog"/);
  assert.match(css, /\.network-status-notice\s*\{[\s\S]*?position:\s*fixed/);
  assert.doesNotMatch(css, /\.network-status-notice\s*\{[^}]*inset:\s*0/s);
});
