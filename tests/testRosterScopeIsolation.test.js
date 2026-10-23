import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  validateAdjustStatusSubmitValue,
  validateAdjustStatusValue,
  validateBatchDispatchValue,
  validateDispatchValue,
} from '../lib/lark/card-actions.js';
import {
  TEST_DISPATCH_CHAT_ID,
  dispatchActionValue,
  normalizeDispatchIngest,
} from '../lib/dispatch/ingest.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { resolveDispatchProfile } from '../lib/dispatch/profile.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';
import {
  buildAdjustStatusFormCard,
  buildDispatchResultCard,
  buildInitialDispatchCard,
  buildRosterSavedCard,
} from '../lib/lark/card-renderer.js';

const productionChatId = 'oc_aa1602f07bf35a5fdfd289aff67025a4';
const migration = readFileSync(new URL('../db/migrations/20261015_test_roster_scope.sql', import.meta.url), 'utf8');

function migrationAllowlists() {
  const readConstant = (name) => {
    const match = migration.match(new RegExp(`${name} constant text := '((?:''|[^'])*)';`));
    assert.ok(match, `${name} should be declared in the migration`);
    return match[1].replaceAll("''", "'");
  };
  return { oldAllowlist: readConstant('v_old'), newAllowlist: readConstant('v_new') };
}

function applyRpcGuardMigration(definition) {
  const { oldAllowlist, newAllowlist } = migrationAllowlists();
  if (definition.includes(oldAllowlist)) return definition.replace(oldAllowlist, newAllowlist);
  if (!definition.includes(newAllowlist)) throw new Error('scope guard not found in dispatch RPC');
  return definition;
}

function action(overrides = {}) {
  return {
    schema_version: 1,
    action: 'bess_auto_dispatch',
    request_id: 'test_scope_1',
    request_name: '测试群隔离需求',
    business_type: '千川',
    target_category: 'qianchuan',
    sheet_url: 'https://example.feishu.cn/sheets/token',
    sheet_id: 'TQuzLA',
    row_index: 10,
    date_field_id: 'H',
    assignee_field_id: 'J',
    project_field_id: 'C',
    project_value: '千川',
    ...overrides,
  };
}

function ingest(overrides = {}) {
  return normalizeDispatchIngest({
    ...action(),
    chat_id: TEST_DISPATCH_CHAT_ID,
    request_id: 'test_ingress_1',
    request_name: '测试接入',
    ...overrides,
  }).fields;
}

function callbackValues(card) {
  const values = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node?.value) values.push(node.value);
      for (const behavior of node?.behaviors || []) if (behavior?.value) values.push(behavior.value);
      walk(node?.elements);
      for (const column of node?.columns || []) walk(column?.elements);
    }
  };
  walk(card?.body?.elements);
  return values;
}

test('测试群 ingress 将非 AD 千川/本地推强制派生为 test_default，生产 ingress 保持 default', () => {
  for (const [businessType, targetCategory] of [['千川', 'qianchuan'], ['本地推', 'local_promo']]) {
    const fields = ingest({ business_type: businessType, target_category: targetCategory });
    assert.equal(fields.dispatchProfile, 'test_default');
    assert.equal(fields.dispatchScope, 'test_default');
  }
  const production = normalizeDispatchIngest({
    ...action(), chat_id: productionChatId, request_id: 'production_1', request_name: '生产接入',
  }).fields;
  assert.equal(production.dispatchProfile, 'default');
  assert.equal(production.dispatchScope, 'default');
});

test('profile 由可信 chat_id 绑定：测试群旧 default 自动升级，非测试群伪造 test_default 拒绝', () => {
  assert.deepEqual(resolveDispatchProfile({
    chatId: TEST_DISPATCH_CHAT_ID, dispatchProfile: 'default', businessType: '千川', targetCategory: 'qianchuan',
  }), { name: 'test_default', scope: 'test_default', direction: 'forward' });
  assert.deepEqual(resolveDispatchProfile({
    chatId: productionChatId, dispatchProfile: 'default', businessType: '本地推', targetCategory: 'local_promo',
  }), { name: 'default', scope: 'default', direction: 'reverse' });
  assert.throws(
    () => validateDispatchValue(action({ dispatch_profile: 'test_default' }), { chatId: productionChatId }),
    (error) => error.code === 'TEST_DISPATCH_PROFILE_FORBIDDEN',
  );
  assert.throws(
    () => normalizeDispatchIngest({
      ...action({ dispatch_profile: 'test_default' }), chat_id: productionChatId,
      request_id: 'forged_1', request_name: '伪造测试 profile',
    }),
    (error) => error.code === 'BINDING_MISMATCH' && error.status === 403,
  );
});

test('callback 安全门在任何 store/Lark 副作用前拒绝非测试群伪造 test_default', async () => {
  let sideEffects = 0;
  const result = await handleDispatchEvent({
    header: { event_id: 'evt_forged_test_scope' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'button', value: action({ dispatch_profile: 'test_default' }) },
      context: { open_chat_id: productionChatId, open_message_id: 'om_forged' },
    },
  }, {
    config: { allowedChatIds: productionChatId },
    store: { async getDailyState() { sideEffects += 1; return null; } },
    client: { async replyInteractiveCard() { sideEffects += 1; } },
    logger: { info() {} },
  });
  assert.equal(result.errorCode, 'TEST_DISPATCH_PROFILE_FORBIDDEN');
  assert.equal(sideEffects, 0);
});

test('单批卡片、名单保存、状态调整与开始派单 action roundtrip 全程保留 test_default', () => {
  const fields = ingest();
  const dispatchValue = dispatchActionValue(fields);
  const initial = buildInitialDispatchCard(fields, dispatchValue);
  const saved = buildRosterSavedCard(fields);
  const result = buildDispatchResultCard(fields, {
    assignee: '甲甲', direction: 'forward', roster: ['甲甲', '乙乙'],
    offDuty: [], forwardCursor: 1, reverseCursor: 0, dispatchedAt: '2026-10-15 05:00:00',
  });
  const adjust = buildAdjustStatusFormCard({
    dayKey: '2026-10-15', businessType: fields.businessType,
    targetCategory: fields.targetCategory, dispatchProfile: fields.dispatchProfile,
    roster: ['甲甲', '乙乙'], offDuty: [], version: 1,
  });

  const values = [
    ...callbackValues(initial), ...callbackValues(saved), ...callbackValues(result), ...callbackValues(adjust),
  ];
  const scoped = values.filter((value) => value.action?.startsWith('bess_'));
  assert.ok(scoped.length >= 5);
  for (const value of scoped) assert.equal(value.dispatch_profile, 'test_default');

  assert.equal(validateDispatchValue(dispatchValue, { chatId: TEST_DISPATCH_CHAT_ID }).dispatchScope, 'test_default');
  const statusValue = scoped.find((value) => value.action === 'bess_adjust_status');
  const submitValue = scoped.find((value) => value.action === 'bess_adjust_status_submit');
  assert.equal(validateAdjustStatusValue(statusValue, { chatId: TEST_DISPATCH_CHAT_ID }).dispatchScope, 'test_default');
  assert.equal(validateAdjustStatusSubmitValue(submitValue, { chatId: TEST_DISPATCH_CHAT_ID }).dispatchScope, 'test_default');
});

test('批量 action roundtrip 同样绑定 test_default，并拒绝在生产群复用', () => {
  const first = ingest({ request_id: 'batch_test_1' });
  const second = ingest({ request_id: 'batch_test_2' });
  const value = {
    schema_version: 1, action: 'bess_batch_auto_dispatch', batch_id: 'test_scope_batch',
    items: [dispatchActionValue(first), dispatchActionValue(second)],
  };
  const batch = validateBatchDispatchValue(value, { chatId: TEST_DISPATCH_CHAT_ID });
  assert.deepEqual(batch.items.map((item) => item.dispatchScope), ['test_default', 'test_default']);
  assert.throws(
    () => validateBatchDispatchValue(value, { chatId: productionChatId }),
    (error) => error.code === 'TEST_DISPATCH_PROFILE_FORBIDDEN',
  );
});

test('名单、off-duty、双向游标和 assignments 在 default/test_default 间独立', async () => {
  const store = createMemoryBatchStore();
  const dayKey = '2026-10-15';
  const expiresAt = '2026-10-16T16:00:00.000Z';
  await store.initializeRoster({ dayKey, scope: 'default', roster: ['生产甲', '生产乙'], expiresAt });
  await store.initializeRoster({ dayKey, scope: 'test_default', roster: ['测试甲', '测试乙', '测试丙'], expiresAt });
  await store.updateRosterStatus({ dayKey, scope: 'test_default', offDuty: ['测试乙'], expectedVersion: 1 });

  let testState = await store.getDailyState(dayKey, 'test_default');
  const assigned = await store.assign({
    dayKey, scope: 'test_default', requestId: 'isolated_1', direction: 'forward', context: {},
    expectedVersion: testState.version, expectedCursorVersion: testState.forward_version,
  });
  assert.equal(assigned.assignee, '测试甲');

  testState = await store.getDailyState(dayKey, 'test_default');
  const productionState = await store.getDailyState(dayKey, 'default');
  assert.deepEqual(testState.roster, ['测试甲', '测试乙', '测试丙']);
  assert.deepEqual(testState.off_duty, ['测试乙']);
  assert.equal(testState.forward_cursor, 1);
  assert.ok(testState.assignments.isolated_1);
  assert.deepEqual(productionState.roster, ['生产甲', '生产乙']);
  assert.deepEqual(productionState.off_duty, []);
  assert.equal(productionState.forward_cursor, 0);
  assert.equal(productionState.assignments, undefined);
});

test('test_default 三批顺序游标连续推进，跳过离岗且不触碰 default 游标', async () => {
  const store = createMemoryBatchStore();
  const dayKey = '2026-10-15';
  const expiresAt = '2026-10-16T16:00:00.000Z';
  await store.initializeRoster({ dayKey, scope: 'default', roster: ['P1', 'P2'], expiresAt });
  await store.initializeRoster({ dayKey, scope: 'test_default', roster: ['A', 'B', 'C'], expiresAt });
  await store.updateRosterStatus({ dayKey, scope: 'test_default', offDuty: ['B'], expectedVersion: 1 });

  const results = [];
  for (const requestIds of [['b1-1', 'b1-2'], ['b2-1'], ['b3-1', 'b3-2']]) {
    const state = await store.getDailyState(dayKey, 'test_default');
    results.push(...await store.assignBatch({
      dayKey, scope: 'test_default', requestIds, direction: 'forward', contexts: requestIds.map(() => ({})),
      expectedVersion: state.version, expectedCursorVersion: state.forward_version,
    }));
  }
  assert.deepEqual(results.map((item) => item.assignee), ['A', 'C', 'A', 'C', 'A']);
  assert.equal((await store.getDailyState(dayKey, 'test_default')).forward_cursor, 7);
  assert.equal((await store.getDailyState(dayKey, 'default')).forward_cursor, 0);
});

test('Supabase store 对 roster、off-duty、cursor 与 assignments 请求都显式携带 test_default', async () => {
  const calls = [];
  const payloads = [[{ roster: ['A'] }], [], [{ roster: ['A'], version: 2 }], [{ assignee: 'A' }], [{ assignee: 'A' }]];
  const store = createSupabaseDispatchStore({
    url: 'https://example.supabase.co', serviceRoleKey: 'service-key', logger: {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, headers: { get() { return ''; } }, async text() { return JSON.stringify(payloads.shift()); } };
    },
  });
  await store.getDailyState('2026-10-15', 'test_default');
  await store.getDailyAssignments('2026-10-15', 'test_default');
  await store.updateRosterStatus({ dayKey: '2026-10-15', scope: 'test_default', offDuty: ['A'], expectedVersion: 1 });
  await store.assign({ dayKey: '2026-10-15', scope: 'test_default', requestId: 'r1', direction: 'forward', context: {} });
  await store.getAssignment('2026-10-15', 'r1', 'test_default');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ url, options }) => url.includes('scope=eq.test_default')
    || JSON.parse(options.body || '{}').p_scope === 'test_default'));
});

test('migration 保留现有 scope，扩展两表 CHECK 与全部五个当前 RPC guard', () => {
  assert.match(migration, /check \(scope in \('default', 'test_default', 'ad', 'ad_review', 'ad_game'\)\)/i);
  assert.equal((migration.match(/add constraint bess_dispatch_(?:daily_state|assignments)_scope_check/g) || []).length, 2);
  for (const name of [
    'bess_assign_next', 'bess_assign_specific', 'bess_calibrate_cursor',
    'bess_update_roster_status', 'bess_assign_batch',
  ]) assert.match(migration, new RegExp(`public\\.${name}\\(`));
  assert.equal((migration.match(/public\.bess_(?:assign_next|assign_specific|calibrate_cursor|update_roster_status|assign_batch)\(/g) || []).length, 5);
  assert.match(migration, /AD-only person_status behavior is[\s\S]*test_default uses its own daily_state\.off_duty/i);
  assert.doesNotMatch(migration, /update\s+public\.bess_dispatch_daily_state\s+set/i);
});

test('migration RPC guard 分支仅在新旧 allowlist 都不存在时失败', () => {
  assert.match(migration, /if pg_catalog\.strpos\(v_definition, v_old\) > 0 then\s+execute pg_catalog\.replace\(v_definition, v_old, v_new\);/i);
  assert.match(migration, /elsif pg_catalog\.strpos\(v_definition, v_new\) = 0 then\s+raise exception/i);
});

test('migration RPC guard 支持部分提前扩容并可重复执行', () => {
  const { oldAllowlist, newAllowlist } = migrationAllowlists();
  const oldDefinition = `create function rpc_old() returns void as $$ begin if p_scope not in (${oldAllowlist}) then raise exception; end if; end $$ language plpgsql;`;
  const newDefinition = `create function rpc_new() returns void as $$ begin if p_scope not in (${newAllowlist}) then raise exception; end if; end $$ language plpgsql;`;
  const partialState = [oldDefinition, newDefinition, oldDefinition, newDefinition, oldDefinition];

  const firstRun = partialState.map(applyRpcGuardMigration);
  assert.ok(firstRun.every((definition) => definition.includes(newAllowlist)));
  assert.ok(firstRun.every((definition) => !definition.includes(oldAllowlist)));
  assert.deepEqual(firstRun.map(applyRpcGuardMigration), firstRun);
  assert.throws(
    () => applyRpcGuardMigration('create function rpc_unknown() returns void language sql as $$ select null $$;'),
    /scope guard not found/,
  );
});
