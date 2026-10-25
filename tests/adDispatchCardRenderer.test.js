import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchDispatchCard,
  buildBatchDispatchResultCard,
  buildDispatchFailureCard,
  buildDispatchResultCard,
  buildInitialDispatchCard,
  buildRosterCompletedCard,
} from '../lib/lark/card-renderer.js';

const adFields = {
  requestId: 'ad_9001',
  requestName: 'AD 派单展示测试',
  businessType: 'AD',
  targetCategory: 'qianchuan_ad',
  dispatchProfile: 'ad',
  dispatchScope: 'ad_review',
  sheetUrl: 'https://bytedance.larkoffice.com/sheets/YS8FsohUyhUfxhtNnKXc6vApnUb',
  sheetId: 'Vp2A6O',
  rowIndex: 122,
  dateFieldId: 'A',
  assigneeFieldId: 'F',
};

function serialized(card) {
  return JSON.stringify(card);
}

test('AD 初始派单卡按大盘和游戏子业务展示标题', () => {
  const review = buildInitialDispatchCard(adFields, { action: 'bess_auto_dispatch' });
  const game = buildInitialDispatchCard({
    ...adFields, targetCategory: 'game_agent', dispatchScope: 'ad_game', sheetId: 'game',
  }, { action: 'bess_auto_dispatch' });

  assert.equal(review.header.title.content, '【AD大盘】新增回扫需求');
  assert.equal(game.header.title.content, '【AD游戏】新增回扫需求');
});

test('AD 批量派单卡按大盘和游戏子业务展示标题', () => {
  const action = { action: 'bess_batch_auto_dispatch', batch_id: 'ad-title', items: [] };
  const period = { segment: 'F 段' };
  const review = buildBatchDispatchCard([adFields], action, { batchId: 'ad-review', period });
  const game = buildBatchDispatchCard([{
    ...adFields, targetCategory: 'game_agent', dispatchScope: 'ad_game', sheetId: 'game',
  }], action, { batchId: 'ad-game', period });

  assert.equal(review.header.title.content, '【AD大盘】F 段新增 1 条｜批量自动派单');
  assert.equal(game.header.title.content, '【AD游戏】F 段新增 1 条｜批量自动派单');
});

test('AD 批量结果卡只展示 AD大盘名单（从上到下），不串入方向或千川本地文案', () => {
  const card = buildBatchDispatchResultCard([adFields], {
    batchId: 'ad_batch_1',
    status: 'FAILED',
    roster: ['张三', '李四'],
    direction: 'forward',
    results: [{ requestId: 'ad_9001', status: 'FAILED', error: '测试失败' }],
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  const text = serialized(card);
  assert.match(text, /AD大盘名单（从上到下）/);
  assert.doesNotMatch(text, /AD 独立名单/);
  assert.doesNotMatch(text, /千川正序/);
  assert.doesNotMatch(text, /本地倒序/);
});

test('AD 单条结果与名单完成卡使用 AD大盘名单（从上到下）文案', () => {
  const resultCard = buildDispatchResultCard(adFields, {
    assignee: '李四',
    direction: 'forward',
    roster: ['张三', '李四'],
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  const completedCard = buildRosterCompletedCard(adFields, {
    assignee: '李四',
    direction: 'forward',
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  for (const card of [resultCard, completedCard]) {
    const text = serialized(card);
    assert.match(text, /AD大盘名单（从上到下）/);
    assert.doesNotMatch(text, /AD 独立名单/);
    assert.doesNotMatch(text, /千川正序/);
    assert.doesNotMatch(text, /本地倒序/);
  }
});

test('AD游戏 scope 卡片明确展示“AD游戏名单”并保留调整按钮', () => {
  const card = buildDispatchResultCard({
    ...adFields, targetCategory: 'game_agent', dispatchScope: 'ad_game', sheetId: 'game',
  }, {
    assignee: '张三', direction: 'forward', roster: ['张三', '李四'],
    dispatchedAt: '2026-10-05T12:00:00.000Z',
  });
  const text = serialized(card);
  assert.match(text, /AD游戏名单（从上到下）/);
  assert.match(text, /调整人员状态/);
  assert.doesNotMatch(text, /业务类型：AD|仅当前范围|仅另一范围|两个范围/);
});

test('应急结果卡使用独立应急需求名单文案并保留调整按钮', () => {
  const card = buildDispatchResultCard({
    ...adFields, targetCategory: 'ehc_emergency_ad', dispatchScope: 'ad_emergency',
  }, {
    assignee: '李四', direction: 'forward', roster: ['张三', '李四'],
    dispatchedAt: '2026-10-24T12:00:00.000Z',
  });
  const text = serialized(card);
  assert.match(text, /应急需求名单（从上到下）/);
  assert.match(text, /调整人员状态/);
});

test('后台派单失败卡明确反馈失败且保留原需求卡重试入口', () => {
  const card = buildDispatchFailureCard('飞书接口失败（LARK_API_91403）');
  const text = serialized(card);
  assert.match(text, /派单失败/);
  assert.match(text, /LARK_API_91403/);
  assert.match(text, /原需求卡保持不变/);
});
