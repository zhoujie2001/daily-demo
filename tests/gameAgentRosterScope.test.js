import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchScope } from '../lib/dispatch/roster.js';
import {
  buildBatchDispatchResultCard,
  buildDispatchResultCard,
  buildRosterCompletedCard,
} from '../lib/lark/card-renderer.js';

const gameFields = {
  requestId: 'game_8400000',
  requestName: '游戏货不对板派单测试',
  businessType: 'AD',
  targetCategory: 'game_agent',
  sheetUrl: 'https://bytedance.larkoffice.com/sheets/LJq0sHyCDhJItDtrM9TcAqEbnse',
  sheetId: 'VTgGZs',
  rowIndex: 5066,
  dateFieldId: 'A',
  assigneeFieldId: 'B',
};

function serialized(card) {
  return JSON.stringify(card);
}

test('游戏货不对板使用独立 game_agent scope，不复用普通 AD scope', () => {
  assert.equal(dispatchScope('AD', 'game_agent'), 'game_agent');
  assert.equal(dispatchScope('AD', 'qianchuan_ad'), 'ad');
  assert.equal(dispatchScope('千川', 'qianchuan'), 'default');
});

test('游戏批量、单条和名单完成卡展示游戏独立名单文案', () => {
  const cards = [
    buildBatchDispatchResultCard([gameFields], {
      batchId: 'game-bess-u-test',
      status: 'FAILED',
      roster: ['张三', '李四'],
      direction: 'reverse',
      results: [{ requestId: gameFields.requestId, status: 'FAILED', error: '测试失败' }],
      dispatchedAt: '2026-10-05T14:00:00.000Z',
    }),
    buildDispatchResultCard(gameFields, {
      assignee: '李四',
      direction: 'reverse',
      roster: ['张三', '李四'],
      dispatchedAt: '2026-10-05T14:00:00.000Z',
    }),
    buildRosterCompletedCard(gameFields, {
      assignee: '李四',
      direction: 'reverse',
      dispatchedAt: '2026-10-05T14:00:00.000Z',
    }),
  ];

  for (const card of cards) {
    const text = serialized(card);
    assert.match(text, /游戏货不对板在班名单/);
    assert.doesNotMatch(text, /AD业态在班名单/);
  }
});

test('游戏结果卡的状态调整按钮保留 target_category', () => {
  const card = buildDispatchResultCard(gameFields, {
    assignee: '李四',
    direction: 'reverse',
    roster: ['张三', '李四'],
    dispatchedAt: '2026-10-05T14:00:00.000Z',
  });
  const button = card.body.elements.find((element) => element?.tag === 'button');
  assert.equal(button?.value?.target_category, 'game_agent');
});
