import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDispatchValue } from '../lib/lark/card-actions.js';
import { dispatchActionValue, normalizeDispatchIngest, AD_DISPATCH_CHAT_ID } from '../lib/dispatch/ingest.js';
import { resolveDispatchProfile } from '../lib/dispatch/profile.js';

const action = (overrides = {}) => ({
  action: 'bess_auto_dispatch',
  request_id: 'profile_1',
  request_name: 'profile test',
  business_type: 'AD',
  target_category: 'game_agent',
  sheet_url: 'https://example.com/sheet',
  sheet_id: 'game',
  row_index: 2,
  date_field_id: 'J',
  assignee_field_id: 'B',
  ...overrides,
});

test('统一 profile 固定服务端 scope/direction，千川与本地规则不回归', () => {
  assert.deepEqual(resolveDispatchProfile({ dispatchProfile: 'ad', businessType: 'AD', targetCategory: 'ad' }), {
    name: 'ad', scope: 'ad', direction: 'reverse',
  });
  assert.deepEqual(resolveDispatchProfile({ dispatchProfile: 'default', businessType: '千川', targetCategory: 'qianchuan' }), {
    name: 'default', scope: 'default', direction: 'forward',
  });
  assert.deepEqual(resolveDispatchProfile({ dispatchProfile: 'default', businessType: '本地推', targetCategory: 'local_promo' }), {
    name: 'default', scope: 'default', direction: 'reverse',
  });
});

test('显式 ad profile 对业务类型和合法 AD 分类 fail-closed', () => {
  for (const overrides of [
    { business_type: '千川', target_category: 'ad', dispatch_profile: 'ad' },
    { business_type: 'AD', target_category: 'local_promo', dispatch_profile: 'ad' },
    { business_type: 'AD', target_category: 'ad', dispatch_profile: 'default' },
    { business_type: 'AD', target_category: 'ad', dispatch_profile: 'custom' },
  ]) {
    assert.throws(
      () => validateDispatchValue(action(overrides)),
      (error) => ['DISPATCH_PROFILE_MISMATCH', 'INVALID_DISPATCH_PROFILE'].includes(error.code),
    );
  }
  for (const target_category of ['ad', 'game_agent', 'qianchuan_ad', 'ehc_emergency_ad']) {
    const fields = validateDispatchValue(action({ target_category, dispatch_profile: 'ad' }));
    assert.deepEqual([fields.dispatchProfile, fields.dispatchScope, fields.dispatchDirection], ['ad', 'ad', 'reverse']);
  }
});

test('legacy AD payload 兼容推断，规范化 action 显式透传 ad profile', () => {
  const fields = validateDispatchValue(action({ dispatch_profile: undefined }));
  assert.deepEqual([fields.dispatchProfile, fields.dispatchScope, fields.dispatchDirection], ['ad', 'ad', 'reverse']);
  assert.equal(dispatchActionValue(fields).dispatch_profile, 'ad');
});

test('AD ingest 规范化后单卡和批次 action 均显式携带 ad profile', () => {
  const { fields } = normalizeDispatchIngest({
    chat_id: AD_DISPATCH_CHAT_ID,
    request_id: 'ad_game_1',
    request_name: 'AD 游戏',
    business_type: 'AD',
    target_category: 'game_agent',
    sheet_url: 'https://example.com/sheet',
    sheet_id: 'game',
    row_index: 2,
    date_field_id: 'J',
    assignee_field_id: 'B',
  });
  assert.equal(fields.dispatchProfile, 'ad');
  assert.equal(dispatchActionValue(fields).dispatch_profile, 'ad');
});
