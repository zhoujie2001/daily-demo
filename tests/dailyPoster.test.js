import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAILY_POSTER_HEIGHT,
  DAILY_POSTER_WIDTH,
  canSharePosterFile,
  createDailyPosterModel,
} from '../src/utils/dailyPoster.js';

const post = {
  id: 'daily-1',
  date: '2026-08-23',
  title: '一封从普通日子寄出的信',
  text: '傍晚的风穿过窗帘，阿丽莎在桌边睡着了。',
  tags: ['生活', '随想', '阿丽莎', '夏天', '晚风', '不会出现在卡片里'],
};

test('Daily 分享卡片使用稳定的 3:4 高清尺寸和内容模型', () => {
  const model = createDailyPosterModel(post, { url: 'https://www.littlearisa88.com/?time=2026-08-23' });

  assert.equal(DAILY_POSTER_WIDTH, 1080);
  assert.equal(DAILY_POSTER_HEIGHT, 1440);
  assert.equal(model.siteTitle, '四十四次日落');
  assert.match(model.date, /Aug/);
  assert.equal(model.title, post.title);
  assert.equal(model.body, post.text);
  assert.deepEqual(model.tags, post.tags.slice(0, 5));
  assert.equal(model.fileName, '四十四次日落-2026-08-23.png');
});

test('正文过长时会在绘制前截断，避免海报溢出', () => {
  const model = createDailyPosterModel({ ...post, title: '', text: '风'.repeat(400) }, { url: 'https://example.com' });
  assert.equal(model.title, '');
  assert.equal(model.body.length, 220);
  assert.equal(model.body.endsWith('…'), true);
});

test('仅在浏览器明确支持文件分享时开放分享图片', () => {
  const file = { name: 'daily.png' };
  assert.equal(canSharePosterFile(file, { share() {}, canShare: ({ files }) => files[0] === file }), true);
  assert.equal(canSharePosterFile(file, { share() {} }), false);
  assert.equal(canSharePosterFile(null, { share() {}, canShare: () => true }), false);
});

