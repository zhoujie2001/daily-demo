import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  validateAdjustStatusValue,
  validateBatchDispatchValue,
  validateDispatchValue,
} from '../lib/lark/card-actions.js';
import {
  batchDispatchActionValue,
  dispatchActionValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  TEST_DISPATCH_CHAT_ID,
} from '../lib/dispatch/ingest.js';
import {
  batchDispatchFingerprint,
  enforceSingleBatchScope,
} from '../lib/dispatch/dispatch-service.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import {
  isAdIsolationScope,
  parseAdIsolationProfile,
  resolveDispatchProfile,
} from '../lib/dispatch/profile.js';

const productionChatId = 'oc_56debf24fa90e17ea92257c20454d742';
const migration = readFileSync(new URL('../db/migrations/20261024_ad_isolation_scopes.sql', import.meta.url), 'utf8');
const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../lib/dispatch/dispatch-service.js', import.meta.url), 'utf8');

function rawItem({ requestId = 'iso_1', category = 'ad', profile = 'ad_isolation:run1' } = {}) {
  return {
    schema_version: 1,
    action: 'bess_auto_dispatch',
    request_id: requestId,
    request_name: `隔离 ${requestId}`,
    business_type: 'AD',
    target_category: category,
    dispatch_profile: profile,
    sheet_url: 'https://example.com/sheet',
    sheet_id: category === 'game_agent' ? 'game' : 'review',
    row_index: 10,
    date_field_id: 'J',
    assignee_field_id: 'B',
  };
}

function ingestBody(options = {}) {
  return { ...rawItem(options), chat_id: TEST_DISPATCH_CHAT_ID };
}

test('固定测试群允许 AD/游戏动态隔离 profile，生产群 fail-closed', () => {
  assert.deepEqual(resolveDispatchProfile({
    chatId: TEST_DISPATCH_CHAT_ID, dispatchProfile: 'ad_isolation:accept_01',
    businessType: 'AD', targetCategory: 'ad', sheetId: 'review', dateFieldId: 'J', assigneeFieldId: 'B',
  }), { name: 'ad_isolation:accept_01', scope: 'ad_isolation:accept_01', direction: 'forward' });
  assert.deepEqual(resolveDispatchProfile({
    chatId: TEST_DISPATCH_CHAT_ID, dispatchProfile: 'ad_game_isolation:accept_01',
    businessType: 'AD', targetCategory: 'game_agent', sheetId: 'game', dateFieldId: 'J', assigneeFieldId: 'B',
  }), { name: 'ad_game_isolation:accept_01', scope: 'ad_game_isolation:accept_01', direction: 'forward' });
  assert.equal(resolveDispatchProfile({
    chatId: productionChatId, dispatchProfile: 'ad_isolation:accept_01',
    businessType: 'AD', targetCategory: 'ad',
  }).errorCode, 'AD_ISOLATION_PROFILE_FORBIDDEN');
  assert.throws(
    () => normalizeDispatchIngest({ ...ingestBody(), chat_id: productionChatId }),
    (error) => error.code === 'BINDING_MISMATCH' && error.status === 403,
  );
});

test('run_id 采用短小写安全标识并拒绝保留名、注入与 lane 冒充', () => {
  for (const profile of [
    'ad_isolation:', 'ad_isolation:ad', 'ad_isolation:ad_game',
    'ad_isolation:UPPER', 'ad_isolation:has.dot', 'ad_isolation:../x',
    `ad_isolation:${'a'.repeat(33)}`,
  ]) {
    const parsed = parseAdIsolationProfile(profile);
    assert.ok(parsed?.errorCode || resolveDispatchProfile({
      chatId: TEST_DISPATCH_CHAT_ID, dispatchProfile: profile,
      businessType: 'AD', targetCategory: 'ad', sheetId: 'review', dateFieldId: 'J', assigneeFieldId: 'B',
    }).errorCode, profile);
  }
  assert.equal(isAdIsolationScope('ad_isolation:r-1_ok'), true);
  assert.equal(resolveDispatchProfile({
    chatId: TEST_DISPATCH_CHAT_ID, dispatchProfile: 'ad_isolation:r1',
    businessType: 'AD', targetCategory: 'game_agent', sheetId: 'game', dateFieldId: 'J', assigneeFieldId: 'B',
  }).errorCode, 'DISPATCH_PROFILE_MISMATCH');
});

test('ingest、callback action 与 batch retry 全程保留动态 scope', () => {
  const review = normalizeDispatchIngest(ingestBody({ profile: 'ad_isolation:roundtrip' })).fields;
  const game = normalizeDispatchIngest(ingestBody({
    requestId: 'game_1', category: 'game_agent', profile: 'ad_game_isolation:roundtrip',
  })).fields;
  assert.equal(review.dispatchScope, 'ad_isolation:roundtrip');
  assert.equal(game.dispatchScope, 'ad_game_isolation:roundtrip');
  assert.equal(dispatchActionValue(review).dispatch_profile, 'ad_isolation:roundtrip');

  const retry = batchDispatchActionValue('iso_retry', [review]);
  assert.equal(retry.items[0].dispatch_profile, 'ad_isolation:roundtrip');
  const restored = validateBatchDispatchValue(retry, { chatId: TEST_DISPATCH_CHAT_ID });
  assert.equal(restored.items[0].dispatchScope, 'ad_isolation:roundtrip');
  assert.equal(validateAdjustStatusValue({
    action: 'bess_adjust_status', business_type: 'AD', target_category: 'ad',
    dispatch_profile: 'ad_isolation:roundtrip',
  }, { chatId: TEST_DISPATCH_CHAT_ID }).dispatchScope, 'ad_isolation:roundtrip');
});

test('ingest 与 callback 均拒绝混合生产/隔离、双 lane 或不同 run_id 批次', () => {
  assert.throws(() => normalizeBatchDispatchIngest({
    chat_id: TEST_DISPATCH_CHAT_ID, batch_id: 'mixed_ingest', items: [
      rawItem({ requestId: 'i1', profile: 'ad_isolation:r1' }),
      rawItem({ requestId: 'i2', profile: 'ad_isolation:r2' }),
    ],
  }), (error) => error.code === 'MIXED_DISPATCH_SCOPE');

  const isolated = validateDispatchValue(rawItem(), { chatId: TEST_DISPATCH_CHAT_ID });
  const production = validateDispatchValue(rawItem({ requestId: 'prod', profile: 'ad' }), { chatId: TEST_DISPATCH_CHAT_ID });
  assert.throws(() => enforceSingleBatchScope([isolated, production]), (error) => error.code === 'MIXED_DISPATCH_SCOPE');
});

test('两个 run_id 的 roster、离岗、正反游标、版本与 assignment 账本互不污染', async () => {
  const store = createMemoryBatchStore();
  const dayKey = '2026-10-24';
  const expiresAt = '2026-10-25T16:00:00.000Z';
  const scopeA = 'ad_isolation:run_a';
  const scopeB = 'ad_isolation:run_b';
  await store.initializeRoster({ dayKey, scope: scopeA, roster: ['A1', 'A2'], expiresAt });
  await store.initializeRoster({ dayKey, scope: scopeB, roster: ['B1', 'B2'], expiresAt });
  await store.updateRosterStatus({ dayKey, scope: scopeA, offDuty: ['A1'], expectedVersion: 1 });
  const stateA = await store.getDailyState(dayKey, scopeA);
  await store.assign({
    dayKey, scope: scopeA, requestId: 'same_request', direction: 'forward', context: {},
    expectedVersion: stateA.version, expectedCursorVersion: stateA.forward_version,
  });
  await store.assign({ dayKey, scope: scopeB, requestId: 'same_request', direction: 'reverse', context: {} });

  const [afterA, afterB] = await Promise.all([
    store.getDailyState(dayKey, scopeA), store.getDailyState(dayKey, scopeB),
  ]);
  assert.deepEqual(afterA.roster, ['A1', 'A2']);
  assert.deepEqual(afterA.off_duty, ['A1']);
  assert.equal(afterA.forward_cursor, 2);
  assert.equal(afterA.reverse_cursor, 0);
  assert.equal(afterA.assignments.same_request.assignee, 'A2');
  assert.deepEqual(afterB.roster, ['B1', 'B2']);
  assert.deepEqual(afterB.off_duty, []);
  assert.equal(afterB.forward_cursor, 0);
  assert.equal(afterB.reverse_cursor, 1);
  assert.equal(afterB.assignments.same_request.assignee, 'B2');
});

test('隔离批次 fingerprint 包含 run namespace，重试保持同 scope 且不会跨 run 复用', () => {
  const first = validateBatchDispatchValue({
    action: 'bess_batch_auto_dispatch', batch_id: 'fingerprint', items: [rawItem({ profile: 'ad_isolation:r1' })],
  }, { chatId: TEST_DISPATCH_CHAT_ID }).items;
  const retry = validateBatchDispatchValue(batchDispatchActionValue('fingerprint', first), {
    chatId: TEST_DISPATCH_CHAT_ID,
  }).items;
  const second = validateBatchDispatchValue({
    action: 'bess_batch_auto_dispatch', batch_id: 'fingerprint', items: [rawItem({ profile: 'ad_isolation:r2' })],
  }, { chatId: TEST_DISPATCH_CHAT_ID }).items;
  assert.equal(batchDispatchFingerprint(first), batchDispatchFingerprint(retry));
  assert.notEqual(batchDispatchFingerprint(first), batchDispatchFingerprint(second));
});

test('隔离人工锚点明确禁用生产 sheet 历史，只读取 scoped ledger 与目标单元格', () => {
  assert.match(serviceSource, /if \(isAdIsolationScope\(scope\)\)[\s\S]*client\.readSheetAssignee/);
  const branch = serviceSource.match(/if \(isAdIsolationScope\(scope\)\) \{[\s\S]*?\n {2}\}/)?.[0] || '';
  assert.doesNotMatch(branch, /readSheetDispatchRows|inspectLatestDailyAnchor|calibrate/);
  assert.match(branch, /store\.getAssignment\(dayKey, fields\.requestId, scope\)/);
});

test('migration 仅允许严格动态 scope，并让相关 RPC 复用同一 guard 且不触碰共享 person_status', () => {
  assert.match(migration, /\^\(ad_isolation\|ad_game_isolation\):\[a-z0-9\]\[a-z0-9_-\]\{0,31\}\$/);
  assert.match(migration, /split_part\(p_scope, ':', 2\) not in \('ad', 'ad_game'\)/);
  assert.equal((migration.match(/check \(public\.bess_is_valid_dispatch_scope\(scope\)\)/g) || []).length, 2);
  for (const rpc of [
    'bess_assign_next', 'bess_assign_specific', 'bess_calibrate_cursor',
    'bess_update_roster_status', 'bess_assign_batch', 'bess_calibrate_and_assign_next',
  ]) assert.match(migration, new RegExp(rpc));
  assert.match(migration, /not public\.bess_is_valid_dispatch_scope\(p_scope\)/);
  assert.doesNotMatch(migration, /(?:from|insert into|update|delete from)\s+public\.bess_dispatch_person_status/i);
  assert.match(migration, /unsafe shared person_status reference in dispatch RPC/);
  assert.doesNotMatch(migration, /values \(p_day_key, 'ad'/);
  assert.match(verification, /缺少严格 scope validator bess_is_valid_dispatch_scope/);
  assert.match(verification, /bess_assign_batch 缺少严格动态 scope 或独立 off_duty 状态/);
  assert.match(verification, /bess_calibrate_and_assign_next 缺少严格动态 scope guard/);
});
