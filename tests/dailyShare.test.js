import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  copyText,
  createDailyLink,
  createDailySharePayload,
  getDailyLinkArrivalSource,
  isCanceledShare,
} from '../src/utils/dailyShare.js';

const root = new URL('../', import.meta.url);
const post = {
  id: 'post-88',
  date: '2026-08-23',
  title: '一段普通日子',
  text: '今天的风很轻，适合把脚步放慢一点。',
};

test('Daily 分享链接只保留稳定日期定位和分享来源', () => {
  const url = createDailyLink(post, {
    baseHref: 'https://www.littlearisa88.com/?time=old&from=time-machine&debug=1#reading',
  });

  assert.equal(url.origin, 'https://www.littlearisa88.com');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('time'), '2026-08-23');
  assert.equal(url.searchParams.get('from'), 'share');
  assert.equal(url.searchParams.has('debug'), false);
  assert.equal(url.hash, '#daily');
});

test('时光机和卡片分享复用同一种链接结构但保留来源', () => {
  const timeMachineUrl = createDailyLink(post, {
    baseHref: 'https://www.littlearisa88.com/',
    source: 'time-machine',
  });

  assert.equal(timeMachineUrl.searchParams.get('time'), '2026-08-23');
  assert.equal(timeMachineUrl.searchParams.get('from'), 'time-machine');
  assert.equal(getDailyLinkArrivalSource(timeMachineUrl), 'link');
  assert.equal(getDailyLinkArrivalSource(createDailyLink(post)), 'share');
});

test('系统分享载荷包含站点、日期、摘要和稳定链接', () => {
  const payload = createDailySharePayload(post, 'https://www.littlearisa88.com/');

  assert.match(payload.title, /四十四次日落/);
  assert.match(payload.title, /2026/);
  assert.match(payload.text, /一段普通日子/);
  assert.match(payload.url, /time=2026-08-23/);
  assert.match(payload.url, /from=share/);
});

test('复制链接优先使用安全上下文 Clipboard API', async () => {
  let copied = '';
  await copyText('https://example.com/shared', {
    navigatorObject: { clipboard: { writeText: async (value) => { copied = value; } } },
    documentObject: null,
  });

  assert.equal(copied, 'https://example.com/shared');
});

test('只有用户取消系统分享时才静默结束', () => {
  assert.equal(isCanceledShare({ name: 'AbortError' }), true);
  assert.equal(isCanceledShare({ name: 'NotAllowedError' }), false);
});

test('Daily 卡片提供系统分享、复制链接、本地二维码和分享卡片界面', async () => {
  const [entrySource, shareSource, posterSource, qrSource, qrUtilitySource, cssSource] = await Promise.all([
    readFile(new URL('src/components/daily/DailyEntry.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/DailyShare.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/DailySharePoster.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/DailyQrCode.jsx', root), 'utf8'),
    readFile(new URL('src/utils/dailyQr.js', root), 'utf8'),
    readFile(new URL('src/visual-system.css', root), 'utf8'),
  ]);

  assert.match(entrySource, /<footer className="daily-entry-footer">[\s\S]*?<DailyShare post=\{post\}/);
  assert.match(shareSource, /navigator\.share\(payload\)/);
  assert.match(shareSource, /复制链接/);
  assert.match(shareSource, /扫码打开这一天/);
  assert.match(shareSource, /生成分享卡片/);
  assert.match(shareSource, /aria-haspopup="dialog"/);
  assert.match(shareSource, /triggerRef\.current\?\.focus/);
  assert.match(posterSource, /createPortal\(/);
  assert.match(posterSource, /aria-modal="true"/);
  assert.match(posterSource, /event\.key !== 'Tab'/);
  assert.match(posterSource, /button:not\(:disabled\)/);
  assert.match(posterSource, /保存图片/);
  assert.match(posterSource, /navigator\.share\(\{/);
  assert.match(qrSource, /createQrGeometry\(value\)/);
  assert.match(qrUtilitySource, /qrcode\(0, errorCorrectionLevel\)/);
  assert.match(qrSource, /shapeRendering="crispEdges"/);
  assert.match(cssSource, /\.daily-share-trigger\s*\{[\s\S]*?min-height:\s*40px/);
  assert.match(cssSource, /@media \(width <= 600px\)[\s\S]*?\.daily-share-trigger\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(cssSource, /\.daily-poster-dialog\s*\{[\s\S]*?width:\s*min\(620px, 100%\)/);
  assert.match(cssSource, /@media \(width <= 600px\)[\s\S]*?\.daily-poster-dialog\s*\{[\s\S]*?width:\s*100%/);
});
