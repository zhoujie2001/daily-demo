import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBatchDispatchValue, validateDispatchValue } from '../lib/lark/card-actions.js';
import { dispatchActionValue, normalizeDispatchIngest, AD_DISPATCH_CHAT_ID } from '../lib/dispatch/ingest.js';
import { resolveDispatchProfile } from '../lib/dispatch/profile.js';
import { enforceAssigneeFieldContract } from '../lib/dispatch/dispatch-service.js';

const action = (overrides = {}) => ({
  action: 'bess_auto_dispatch', request_id: 'profile_1', request_name: 'profile test',
  business_type: 'AD', target_category: 'game_agent',
  sheet_url: 'https://example.com/sheet', sheet_id: 'game', row_index: 2,
  date_field_id: 'J', assignee_field_id: 'B', ...overrides,
});

test('服务端按 targetCategory 将 AD 拆分为两个独立 scope', () => {
  for (const targetCategory of ['ad', 'qianchuan_ad', 'ehc_emergency_ad']) {
    const shared = ['qianchuan_ad', 'ehc_emergency_ad'].includes(targetCategory);
    assert.deepEqual(resolveDispatchProfile({
      dispatchProfile: 'ad', businessType: 'AD', targetCategory,
      sheetId: shared ? '288afd' : 'review', dateFieldId: shared ? 'A' : 'J',
      assigneeFieldId: shared ? 'F' : 'B',
    }), { name: 'ad', scope: 'ad_review', direction: 'reverse' });
  }
  assert.deepEqual(resolveDispatchProfile({
    dispatchProfile: 'ad', businessType: 'AD', targetCategory: 'game_agent',
    sheetId: 'game', dateFieldId: 'J', assigneeFieldId: 'B',
  }), { name: 'ad', scope: 'ad_game', direction: 'reverse' });
  assert.deepEqual(resolveDispatchProfile({ dispatchProfile: 'default', businessType: '千川', targetCategory: 'qianchuan' }), {
    name: 'default', scope: 'default', direction: 'forward',
  });
});

test('客户端不能指定 scope，分类与 sheet/字段冲突 fail-closed', () => {
  assert.equal(dispatchActionValue(validateDispatchValue(action())).dispatch_scope, undefined);
  for (const overrides of [
    { target_category: 'game_agent', sheet_id: '288afd', date_field_id: 'A', assignee_field_id: 'F' },
    { target_category: 'qianchuan_ad', sheet_id: 'game', date_field_id: 'J', assignee_field_id: 'B' },
    { target_category: 'ad', sheet_id: 'review', date_field_id: 'J', assignee_field_id: 'B', dispatch_profile: 'default' },
    { target_category: 'ad', sheet_id: 'review', dispatch_profile: 'custom' },
  ]) assert.throws(() => validateDispatchValue(action(overrides)), /./);
});

test('历史 AD 卡仅在 288afd+A/F 能唯一推断 ad_review，含糊卡拒绝且不回退旧 ad', () => {
  const fields = validateDispatchValue(action({
    target_category: undefined, dispatch_profile: 'ad', sheet_id: '288afd',
    date_field_id: 'A', assignee_field_id: 'F',
  }));
  assert.equal(fields.targetCategory, 'qianchuan_ad');
  assert.equal(fields.dispatchScope, 'ad_review');
  assert.throws(
    () => validateDispatchValue(action({ target_category: undefined, dispatch_profile: 'ad' })),
    (error) => error.code === 'AMBIGUOUS_AD_SCOPE',
  );
});

test('跨 ad_review/ad_game 混合批次在校验后具有不同 scope', () => {
  const batch = validateBatchDispatchValue({
    action: 'bess_batch_auto_dispatch', batch_id: 'mixed_ad', items: [
      action({ request_id: 'review_1', target_category: 'ad', sheet_id: 'review' }),
      action({ request_id: 'game_1', target_category: 'game_agent', sheet_id: 'game' }),
    ],
  });
  assert.deepEqual(batch.items.map((item) => item.dispatchScope), ['ad_review', 'ad_game']);
});

test('AD ingest 显式携带 profile 但 scope 仅保留在服务端字段', () => {
  const { fields } = normalizeDispatchIngest({
    chat_id: AD_DISPATCH_CHAT_ID, request_id: 'ad_game_1', request_name: 'AD 游戏',
    business_type: 'AD', target_category: 'game_agent', sheet_url: 'https://example.com/sheet',
    sheet_id: 'game', row_index: 2, date_field_id: 'J', assignee_field_id: 'B',
  });
  assert.equal(fields.dispatchScope, 'ad_game');
  const value = dispatchActionValue(fields);
  assert.equal(value.dispatch_profile, 'ad');
  assert.equal(value.dispatch_scope, undefined);
});

test('历史 AD/游戏卡片执行时强制写入 B/姓名', () => {
  for (const targetCategory of ['ad', 'game_agent']) {
    const normalized = enforceAssigneeFieldContract({ targetCategory, assigneeFieldId: 'G', assigneeFieldName: '领取人' });
    assert.equal(normalized.assigneeFieldId, 'B');
    assert.equal(normalized.assigneeFieldName, '姓名');
  }
});
