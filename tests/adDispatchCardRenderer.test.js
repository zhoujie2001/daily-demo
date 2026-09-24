import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchDispatchResultCard,
  buildDispatchFailureCard,
  buildDispatchResultCard,
  buildRosterCompletedCard,
} from '../lib/lark/card-renderer.js';

const adFields = {
  requestId: 'ad_9001',
  requestName: 'AD 派单展示测试',
  businessType: 'AD',
  targetCategory: 'qianchuan_ad',
  sheetUrl: 'https://bytedance.larkoffice.com/sheets/CeBAsJgwnh5mwCtAbgocpVCsnib',
  sheetId: '288afd',
  rowIndex: 122,
  dateFieldId: 'A',
  assigneeFieldId: 'F',
};

function serialized(card) {
  return JSON.stringify(card);
}

test('AD 批量结果卡只展示 AD 独立名单，不串入千川本地双名单', () => {
  const card = buildBatchDispatchResultCard([adFields], {
    batchId: 'ad_batch_1',
    status: 'FAILED',
    roster: ['张三', '李四'],
    direction: 'reverse',
    results: [{ requestId: 'ad_9001', status: 'FAILED', error: '测试失败' }],
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  const text = serialized(card);
  assert.match(text, /AD 独立名单（倒序（从下到上））/);
  assert.doesNotMatch(text, /千川正序/);
  assert.doesNotMatch(text, /本地倒序/);
});

test('AD 单条结果与名单完成卡使用 AD 独立名单文案', () => {
  const resultCard = buildDispatchResultCard(adFields, {
    assignee: '李四',
    direction: 'reverse',
    roster: ['张三', '李四'],
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  const completedCard = buildRosterCompletedCard(adFields, {
    assignee: '李四',
    direction: 'reverse',
    dispatchedAt: '2026-09-24T12:00:00.000Z',
  });
  for (const card of [resultCard, completedCard]) {
    const text = serialized(card);
    assert.match(text, /AD 独立名单/);
    assert.doesNotMatch(text, /千川正序/);
    assert.doesNotMatch(text, /本地倒序/);
  }
});

test('后台派单失败卡明确反馈失败且保留原需求卡重试入口', () => {
  const card = buildDispatchFailureCard('飞书接口失败（LARK_API_91403）');
  const text = serialized(card);
  assert.match(text, /派单失败/);
  assert.match(text, /LARK_API_91403/);
  assert.match(text, /原需求卡保持不变/);
});
