import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { sourceCardFixture } from './fixtures/source-card-manifest.js';
import { normalizeBatchDispatchIngest, normalizeDispatchIngest, dispatchIdempotencyValue, batchDispatchActionValue, dispatchActionValue } from '../lib/dispatch/ingest.js';
import { buildDispatchCardChunkPlans, MAX_ITEMS_PER_CARD, MAX_BATCH_CHUNKS } from '../lib/dispatch/card-chunks.js';
import { batchDispatchFingerprint, handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { validateBatchDispatchValue, validateSpecifyAssigneeValue } from '../lib/lark/card-actions.js';
import { buildBatchStatusCard, buildBatchDispatchResultCard } from '../lib/lark/card-renderer.js';
import { sourceCardManifestHash, sourceCardCanonicalJson, registerSourceCardManifest, assertSourceCardBinding } from '../lib/dispatch/source-card-manifest.js';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { createDispatchSendHandler } from '../lib/dispatch/api/send.js';
import { assertSourceCardQueuedCard } from '../lib/dispatch/outbox-worker.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';

const normalize = (body) => normalizeBatchDispatchIngest(body, { splitCards: true });
const action = (n) => batchDispatchActionValue(n.batchId, n.fieldsList);
const noCache = { get: async () => null, set: async () => {} };
const noopLogger = { log() {}, error() {} };
function response() {
  return { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
function mockStore() {
  const calls = [];
  return { calls,
    registerSourceCardManifest: async (args) => { calls.push(['manifest', args]); return { outcome: 'ACCEPTED' }; },
    assertSourceCardBinding: async (args) => { calls.push(['binding', args]); return { outcome: 'ACCEPTED' }; },
    reserveDispatchIngestRoot: async (args) => { calls.push(['root', args]); return { outcome: 'ACCEPTED' }; },
    registerDispatchHandoff: async (args) => { calls.push(['handoff', args]); return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; },
    confirmDispatchHandoff: async () => {},
  };
}
for (const total of [78, 21, 20]) test(`${total}条完整清单：每个独立payload只产生一张、保留source序号`, () => {
  const { deliveries } = sourceCardFixture(total);
  assert.deepEqual(deliveries.map((body) => body.items.length), total === 78 ? [20, 20, 20, 18] : total === 21 ? [20, 1] : [20]);
  const operations = new Set();
  deliveries.forEach((body, index) => {
    const n = normalize(body), plans = buildDispatchCardChunkPlans(n);
    assert.equal(n.fieldsList[0].dispatchScope, 'ad_game');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].batchId, body.batch_id);
    assert.match(plans[0].card.header.title.content, new RegExp(`第 ${index + 1}/${deliveries.length} 张`));
    assert.match(plans[0].card.header.title.content, new RegExp(`新增 ${total} 条`));
    assert.deepEqual(plans[0].queueMessage.source_card_manifest, body.source_card_manifest);
    assert.equal(plans[0].queueMessage.source_card_chunk_index, index + 1);
    operations.add(plans[0].operationId);
  });
  assert.equal(operations.size, deliveries.length);
  assert.equal(MAX_ITEMS_PER_CARD, 20); assert.equal(MAX_BATCH_CHUNKS, 2);
});
test('hash指定canonical JSON，对象键序无关、数组序有关', () => {
  const { manifest } = sourceCardFixture(21);
  const { manifest_hash: hash, ...content } = manifest;
  assert.equal(hash, createHash('sha256').update(sourceCardCanonicalJson(content), 'utf8').digest('hex'));
  assert.equal(sourceCardManifestHash(Object.fromEntries(Object.entries(manifest).reverse())), hash);
  const changed = structuredClone(manifest); changed.chunks[0].request_ids.reverse();
  assert.notEqual(sourceCardManifestHash(changed), hash);
});
const mutations = {
  'unknown version': (b) => { b.source_card_manifest.version = 2; },
  'unknown manifest key': (b) => { b.source_card_manifest.future = 1; },
  'unknown chunk key': (b) => { b.source_card_manifest.chunks[0].future = 1; },
  'unknown metadata key': (b) => { b.source_card_future = 1; },
  'unknown item metadata': (b) => { b.items[0].source_card_future = 1; },
  'null manifest': (b) => { b.source_card_manifest = null; },
  'missing manifest': (b) => { delete b.source_card_manifest; },
  'missing index': (b) => { delete b.source_card_chunk_index; },
  'wrong index': (b) => { b.source_card_chunk_index = 2; },
  'zero index': (b) => { b.source_card_chunk_index = 0; },
  'fraction index': (b) => { b.source_card_chunk_index = 1.5; },
  'wrong total': (b) => { b.source_card_manifest.total_item_count = 77; },
  'wrong chunk count': (b) => { b.source_card_manifest.chunk_count = 3; },
  'wrong item count': (b) => { b.source_card_manifest.chunks[0].item_count = 19; },
  'wrong ordinal in list': (b) => { b.source_card_manifest.chunks[1].chunk_index = 1; },
  'duplicate across chunks': (b) => { b.source_card_manifest.chunks[1].request_ids[0] = b.source_card_manifest.chunks[0].request_ids[0]; },
  'duplicate batch': (b) => { b.source_card_manifest.chunks[1].batch_id = b.batch_id; },
  'incomplete list': (b) => { b.source_card_manifest.chunks.pop(); },
  'items order': (b) => { b.items.reverse(); },
  'items padded ID': (b) => { b.items[0].request_id += ' '; },
  'items replacement': (b) => { b.items[0].request_id = 'other'; },
  'manifest order': (b) => { b.source_card_manifest.chunks[0].request_ids.reverse(); },
  'profile drift': (b) => { b.source_card_manifest.dispatch_profile = 'test_default'; },
  'chat drift': (b) => { b.source_card_manifest.chat_id = 'oc_another'; },
  'category drift': (b) => { b.source_card_manifest.target_category = 'ad'; },
  'item profile drift': (b) => { b.items[0].dispatch_profile = 'test_default'; },
  'item source drift': (b) => { b.items[0].source_batch_id = 'another'; },
  'top source drift': (b) => { b.source_batch_id = 'another'; },
  'hash drift': (b) => { b.source_card_manifest.manifest_hash = '0'.repeat(64); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`fail closed: ${name}`, () => {
  const body = sourceCardFixture().deliveries[0]; mutate(body);
  // Re-sign malformed structure to prove structural validation isn't just hash checking.
  if (body.source_card_manifest && name !== 'hash drift') body.source_card_manifest.manifest_hash = sourceCardManifestHash(body.source_card_manifest);
  assert.throws(() => normalize(body));
});
test('游戏多CODE不分池不去重需求、manifest/fingerprint不受无关CODE影响', () => {
  const body = sourceCardFixture().deliveries[0], before = normalize(body);
  body.items.forEach((item) => { item.reject_reason_codes = ['1005004', '1000676', '1005004']; });
  const after = normalize(body);
  assert.deepEqual(after.fieldsList, before.fieldsList);
  assert.equal(batchDispatchFingerprint(after.fieldsList), batchDispatchFingerprint(before.fieldsList));
  body.items[0].decision_policy_version = 'code-membership-1000676/v2';
  assert.throws(() => normalize(body));
});
test('callback、指定人员及processing/partial/success结果更新保留metadata', () => {
  const n = normalize(sourceCardFixture().deliveries[2]);
  const batch = validateBatchDispatchValue(action(n), { chatId: n.chatId });
  assert.deepEqual(batch.items, n.fieldsList);
  const specified = validateSpecifyAssigneeValue({ ...dispatchActionValue(n.fieldsList[0]), action: 'bess_specify_assignee' }, { chatId: n.chatId });
  assert.deepEqual(specified.sourceCardBinding, n.fieldsList[0].sourceCardBinding);
  for (const status of ['PROCESSING', 'PARTIAL', 'SUCCESS']) {
    const cards = [buildBatchStatusCard(batch.items, { batchId: batch.batchId, status }),
      buildBatchDispatchResultCard(batch.items, { batchId: batch.batchId, status })];
    cards.forEach((card) => {
      assert.match(card.header.title.content, /第 3\/4 张/);
      assert.match(JSON.stringify(card), /game_source_78/);
      assert.match(JSON.stringify(card), /manifest_hash/);
    });
  }
});
test('callback wrong batch、混合metadata、profile/chat drift拒绝', () => {
  const n = normalize(sourceCardFixture().deliveries[0]);
  for (const change of [(a) => { a.batch_id = 'wrong'; }, (a) => { delete a.items[0].source_card_binding; },
    (a) => { a.items[0].source_card_binding.chat_id = 'oc_wrong'; },
    (a) => { a.items[0].source_card_binding.dispatch_profile = 'test_default'; },
    (a) => { a.items[0].request_id += ' '; },
    (a) => { a.items[0].source_card_binding.chunk_index = 2; }]) {
    const a = action(n); // clone because action references normalized binding
    const copy = JSON.parse(JSON.stringify(a)); change(copy);
    assert.throws(() => validateBatchDispatchValue(copy, { chatId: n.chatId }));
  }
});
test('持久store缺失/未知结果fail closed；manifest进入fingerprint', async () => {
  const n = normalize(sourceCardFixture().deliveries[0]);
  await assert.rejects(() => registerSourceCardManifest({}, n), { code: 'SOURCE_CARD_STORE_REQUIRED' });
  await assert.rejects(() => registerSourceCardManifest({ registerSourceCardManifest: async () => ({ outcome: 'UNKNOWN' }) }, n));
  await assert.rejects(() => assertSourceCardBinding({}, { chatId: n.chatId, batchId: n.batchId, items: n.fieldsList }));
  const changed = structuredClone(n); changed.fieldsList[0].sourceCardBinding.manifest_hash = '0'.repeat(64);
  assert.notEqual(batchDispatchFingerprint(changed.fieldsList), batchDispatchFingerprint(n.fieldsList));
  assert.notEqual(buildDispatchCardChunkPlans(changed)[0].fingerprint, buildDispatchCardChunkPlans(n)[0].fingerprint);
});
test('queue消费者核对清单及DB绑定，缺失metadata/ID顺序漂移拒绝', async () => {
  const n = normalize(sourceCardFixture().deliveries[0]), plan = buildDispatchCardChunkPlans(n)[0], store = mockStore();
  const args = { store, card: plan.card, chatId: n.chatId, batchId: n.batchId, requestIds: plan.requestIds, envelope: plan.queueMessage };
  await assertSourceCardQueuedCard(args);
  assert.equal(store.calls[0][0], 'binding');
  await assert.rejects(() => assertSourceCardQueuedCard({ ...args, requestIds: [...plan.requestIds].reverse() }));
  await assert.rejects(() => assertSourceCardQueuedCard({ ...args, envelope: { ...plan.queueMessage, source_card_future: 1 } }));
  const missing = structuredClone(plan.queueMessage); delete missing.source_card_manifest;
  await assert.rejects(() => assertSourceCardQueuedCard({ ...args, envelope: missing }));
  const mismatch = structuredClone(plan.queueMessage); mismatch.source_card_chunk_index = 2;
  await assert.rejects(() => assertSourceCardQueuedCard({ ...args, envelope: mismatch }));
});
test('automation四片先持久注册，单卡路径queue/ledger带完整manifest且没有真实发送', async () => {
  const store = mockStore(), queued = [];
  const handler = createAutomationSendHandler({ secret: 'test', storeFactory: () => store,
    statusCache: noCache, publishDispatch: async (q) => { queued.push(q); return { message_id: 'test' }; } });
  for (const body of sourceCardFixture().deliveries) {
    const res = response(); await handler({ method: 'POST', body: { automation_token: 'test', dispatch_payload: body } }, res);
    assert.equal(res.statusCode, 202);
  }
  assert.equal(queued.length, 4);
  assert.deepEqual(store.calls.map(([name]) => name), Array(4).fill(['manifest', 'handoff']).flat());
  queued.forEach((q, index) => {
    assert.equal(q.source_card_chunk_index, index + 1);
    assert.equal(q.source_card_manifest.total_item_count, 78);
    assert.match(q.card.header.title.content, new RegExp(`第 ${index + 1}/4 张`));
  });
});
test('HMAC send dry_run只校验不登记DB/不发布', async () => {
  const body = sourceCardFixture(21).deliveries[1]; body.dry_run = true;
  const { createHmac } = await import('node:crypto');
  const { canonicalJson } = await import('../lib/dispatch/ingest.js');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'test').update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
  const handler = createDispatchSendHandler({ secret: 'test', storeFactory: () => { throw new Error('must not open store'); },
    publishDispatch: async () => { throw new Error('must not publish'); } });
  const res = response();
  const oldSecret = process.env.BESS_DISPATCH_INGEST_SECRET;
  process.env.BESS_DISPATCH_INGEST_SECRET = 'test';
  try {
    await handler({ method: 'POST', body, headers: { 'x-bess-timestamp': timestamp, 'x-bess-signature': signature } }, res);
  } finally {
    if (oldSecret === undefined) delete process.env.BESS_DISPATCH_INGEST_SECRET;
    else process.env.BESS_DISPATCH_INGEST_SECRET = oldSecret;
  }
  assert.equal(res.statusCode, 200); assert.equal(res.body.status, 'DRY_RUN_OK');
});
test('callback持久源缺失在游标/名单/claim之前拒绝', async () => {
  const n = normalize(sourceCardFixture().deliveries[0]);
  const body = { header: { event_id: 'test' }, event: { action: { value: action(n) }, operator: { open_id: 'ou_test' },
    context: { open_chat_id: n.chatId, open_message_id: 'om_test' } } };
  const store = Object.fromEntries(['claimBatch','saveBatchProgress','markBatchFinalization','saveBatchResultMessage','releaseBatchClaim']
    .map((method) => [method, async () => { throw new Error('must not touch claim'); }]));
  const result = await handleDispatchEvent(body, { store, client: {}, logger: noopLogger,
    config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, 'SOURCE_CARD_STORE_REQUIRED');
});
test('无metadata旧payload/旧callback仍无新增fields，40条仍两卡', () => {
  const b = sourceCardFixture(20).deliveries[0]; delete b.source_card_manifest; delete b.source_card_chunk_index;
  const n = normalize(b);
  assert.equal(n.sourceCardManifest, undefined); assert.equal(n.fieldsList[0].sourceCardBinding, undefined);
  assert.deepEqual(validateBatchDispatchValue(action(n), { chatId: n.chatId }).items, n.fieldsList);
  assert.throws(() => normalizeDispatchIngest({ ...b.items[0], chat_id: b.chat_id, source_card_manifest: {} }));
  const forty = sourceCardFixture(40).deliveries;
  b.items = forty.flatMap((item) => item.items);
  assert.equal(buildDispatchCardChunkPlans(normalize(b)).length, 2);
  b.items.push({ ...b.items[0], request_id: 'extra' });
  assert.throws(() => normalize(b), { code: 'INVALID_BATCH_SIZE' });
});
test('DB RPC adapter返回冲突409、缺migration新metadata不fallback、旧schema仅missing RPC兼容', async () => {
  const logs = { info() {}, warn() {}, error() {} };
  const make = (code, message) => createSupabaseDispatchStore({ url: 'https://db.invalid', serviceRoleKey: 'test', logger: logs,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ code, message }) }) });
  await assert.rejects(() => make('P0001', 'SOURCE_CARD_BINDING_CONFLICT').registerSourceCardManifest({ manifest: {} }), { code: 'SOURCE_CARD_BINDING_CONFLICT', status: 409 });
  const old = make('PGRST202', 'missing');
  await old.assertLegacySourceCardBatch({ batchId: 'old' });
  await old.assertLegacySourceCardMembers({ chatId: 'oc_old', items: [], messageId: 'om_old' });
  await assert.rejects(() => make('503', 'outage').assertLegacySourceCardMembers({ chatId: 'oc_old', items: [] }));
  await assert.rejects(() => old.registerSourceCardManifest({ manifest: {} }));
  await assert.rejects(() => make('503', 'outage').assertLegacySourceCardBatch({ batchId: 'old' }));
});

const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
const callbackBody = (value, chatId, messageId = 'om_source') => ({ header: { event_id: 'synthetic' },
  event: { action: { value }, operator: { open_id: 'ou_test' },
    context: { open_chat_id: chatId, open_message_id: messageId } } });
test('P2 manifest/chunk/binding递归重排：ingest和callback及直接持久恢复fingerprint稳定', () => {
  const body = sourceCardFixture(21).deliveries[0], n = normalize(body);
  const reordered = normalize(reverseKeys(body));
  assert.equal(reordered.sourceCardManifest.manifest_hash, n.sourceCardManifest.manifest_hash);
  assert.deepEqual(reordered.fieldsList, n.fieldsList);
  const before = buildDispatchCardChunkPlans(n)[0], after = buildDispatchCardChunkPlans(reordered)[0];
  assert.equal(after.fingerprint, before.fingerprint);
  const callback = validateBatchDispatchValue(reverseKeys(action(n)), { chatId: n.chatId });
  assert.equal(batchDispatchFingerprint(callback.items), batchDispatchFingerprint(n.fieldsList));
  const restored = n.fieldsList.map((item) => ({ ...item, sourceCardBinding: reverseKeys(item.sourceCardBinding) }));
  assert.equal(batchDispatchFingerprint(restored), batchDispatchFingerprint(n.fieldsList));
  assert.equal(JSON.stringify(restored.map(dispatchIdempotencyValue)), JSON.stringify(n.fieldsList.map(dispatchIdempotencyValue)));
});
test('P2 automation等价键序重试：原子register root fingerprint不变，不误报409', async () => {
  const body = sourceCardFixture(21).deliveries[0], store = mockStore(); let fingerprint;
  store.registerSourceCardManifest = async ({ root }) => {
    assert.ok(root); assert.equal(root.chunkPlan.length, 1);
    if (fingerprint) assert.equal(root.fingerprint, fingerprint);
    fingerprint = root.fingerprint; return { outcome: 'ACCEPTED' };
  };
  store.reserveDispatchIngestRoot = async () => { throw new Error('source root must be in register transaction'); };
  const handler = createAutomationSendHandler({ secret: 'test', storeFactory: () => store,
    statusCache: noCache, publishDispatch: async () => ({ message_id: 'synthetic' }) });
  for (const payload of [body, reverseKeys(body)]) {
    const res = response(); await handler({ method: 'POST', body: { automation_token: 'test', dispatch_payload: payload } }, res);
    assert.equal(res.statusCode, 202);
  }
});
test('P2 callback等价binding键序重试：持久claim不误报BATCH_ID_CONFLICT', async () => {
  const n = normalize(sourceCardFixture(21).deliveries[0]); let fingerprint;
  const store = { ...mockStore(), getDailyState: async () => ({ roster: ['synthetic'] }),
    claimBatch: async (args) => {
      const mismatch = fingerprint && fingerprint !== args.fingerprint;
      fingerprint = args.fingerprint;
      return { outcome: mismatch ? 'CONFLICT' : 'IN_FLIGHT', status: 'PROCESSING' };
    }, saveBatchProgress() {}, markBatchFinalization() {}, saveBatchResultMessage() {}, releaseBatchClaim() {} };
  for (const value of [action(n), reverseKeys(action(n))]) {
    const result = await handleDispatchEvent(callbackBody(value, n.chatId), {
      store, client: {}, logger: noopLogger, config: { phase: 'p1', allowedChatIds: [n.chatId] } });
    assert.equal(result.errorCode, 'BATCH_IN_FLIGHT');
  }
});
test('P2 register占用冲突：入口返回409，不启动root/handoff/publish副作用', async () => {
  const body = sourceCardFixture(21).deliveries[0]; let calls = 0;
  const store = mockStore(); store.registerSourceCardManifest = async () => {
    throw Object.assign(new Error('SOURCE_CARD_BINDING_CONFLICT'), { code: 'SOURCE_CARD_BINDING_CONFLICT', status: 409 });
  };
  const handler = createAutomationSendHandler({ secret: 'test', storeFactory: () => store,
    statusCache: noCache, publishDispatch: async () => { calls++; } });
  const res = response(); await handler({ method: 'POST', body: { automation_token: 'test', dispatch_payload: body } }, res);
  assert.equal(res.statusCode, 409); assert.deepEqual(store.calls, []); assert.equal(calls, 0);
});
for (const actionName of ['bess_auto_dispatch', 'bess_specify_assignee']) test(`P2删除binding单条${actionName}在cleanup/roster/reply/pending/cursor前拒绝`, async () => {
  const n = normalize(sourceCardFixture(21).deliveries[0]);
  const value = { ...dispatchActionValue(n.fieldsList[0]), action: actionName }; delete value.source_card_binding;
  const calls = [];
  const store = { assertLegacySourceCardMembers: async (args) => {
    calls.push('memberGuard'); assert.equal(args.items[0].requestId, n.fieldsList[0].requestId);
    assert.equal(args.messageId, 'om_source');
    throw Object.assign(new Error('SOURCE_CARD_BINDING_CONFLICT'), { code: 'SOURCE_CARD_BINDING_CONFLICT' });
  } };
  for (const name of ['cleanupExpired', 'getDailyState', 'savePending', 'claimBatch', 'initializeRoster', 'assignNext']) {
    store[name] = async () => { calls.push(name); throw new Error('side effect forbidden'); };
  }
  const result = await handleDispatchEvent(callbackBody(value, n.chatId), { store,
    client: { replyInteractiveCard: async () => { calls.push('larkReply'); } }, logger: noopLogger,
    config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, 'SOURCE_CARD_BINDING_CONFLICT'); assert.deepEqual(calls, ['memberGuard']);
});
test('P2已证明历史旧卡恢复可进入原名单表单流程，不按裸request_id封禁', async () => {
  const n = normalize(sourceCardFixture(21).deliveries[0]);
  const value = dispatchActionValue(n.fieldsList[0]); delete value.source_card_binding;
  const calls = [];
  const store = { assertLegacySourceCardMembers: async ({ messageId }) => { assert.equal(messageId, 'om_proven_history'); calls.push('guard'); },
    cleanupExpired: async () => { calls.push('cleanup'); }, getDailyState: async () => { calls.push('roster'); return null; },
    savePending: async () => { calls.push('pending'); } };
  const result = await handleDispatchEvent(callbackBody(value, n.chatId, 'om_proven_history'), { store,
    client: { replyInteractiveCard: async () => { calls.push('reply'); return { message_id: 'om_history_form' }; } },
    logger: noopLogger, config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, undefined); assert.deepEqual(calls, ['guard', 'cleanup', 'roster', 'reply', 'pending']);
});
test('P2删除binding后的恢复名单表单也先校验身份，再cleanup/初始化', async () => {
  const n = normalize(sourceCardFixture(21).deliveries[0]), restored = { ...n.fieldsList[0] }; delete restored.sourceCardBinding;
  const body = callbackBody(null, n.chatId); body.event.action.form_value = { roster_names: 'synthetic' };
  const calls = [];
  const store = { getPending: async () => ({ request_context: restored, original_message_id: 'om_source', chat_id: n.chatId }),
    assertLegacySourceCardMembers: async () => { calls.push('guard'); throw Object.assign(new Error('conflict'), { code: 'SOURCE_CARD_BINDING_CONFLICT' }); },
    cleanupExpired: async () => { calls.push('cleanup'); }, initializeRoster: async () => { calls.push('roster'); } };
  const result = await handleDispatchEvent(body, { store, client: {}, logger: noopLogger,
    config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, 'SOURCE_CARD_BINDING_CONFLICT'); assert.deepEqual(calls, ['guard']);
});

for (const [name, mutate, allowed] of [
  ['trusted batch roster saved', () => {}, true],
  ['wrong chat', (p) => { p.chat_id = 'oc_other'; }, false],
  ['wrong form', (p) => { p.form_message_id = 'om_other'; }, false],
  ['wrong batch', (p) => { p.request_context.batchId = 'other_batch'; }, false],
  ['wrong pending request', (p) => { p.request_id = 'batch_other'; }, false],
  ['wrong kind', (p) => { p.request_context.kind = 'specify_assignee'; }, false],
  ['wrong member', (p) => { p.request_context.items[0].requestId = 'other_member'; }, false],
  ['reordered members', (p) => { p.request_context.items.reverse(); }, false],
  ['unproven origin', (p) => { p.original_message_id = 'om_source_stripped'; }, false],
]) test(`名单保存新卡callback持久来源恢复：${name}`, async () => {
  const body = sourceCardFixture(21).deliveries[0]; delete body.source_card_manifest; delete body.source_card_chunk_index;
  const n = normalize(body), batch = validateBatchDispatchValue(action(n), { chatId: n.chatId });
  const pending = { form_message_id: 'om_roster_saved', chat_id: n.chatId, original_message_id: 'om_proven_history',
    request_context: structuredClone({ ...batch, kind: 'batch' }) }; mutate(pending);
  const origins = []; let claims = 0;
  const store = { getPending: async (id, current, opts) => {
    assert.equal(id, 'om_roster_saved'); assert.ok(current instanceof Date); assert.equal(opts.includeCompleted, true); return pending;
  }, assertLegacySourceCardMembers: async ({ messageId }) => {
    origins.push(messageId);
    if (messageId !== 'om_proven_history') throw Object.assign(new Error('conflict'), { code: 'SOURCE_CARD_BINDING_CONFLICT' });
  }, getDailyState: async () => ({ roster: ['synthetic'] }),
  claimBatch: async () => { claims++; return { outcome: 'IN_FLIGHT', status: 'PARTIAL' }; },
  saveBatchProgress() {}, markBatchFinalization() {}, saveBatchResultMessage() {}, releaseBatchClaim() {} };
  const value = { ...action(n), original_message_id: 'om_proven_history' };
  const result = await handleDispatchEvent(callbackBody(value, n.chatId, 'om_roster_saved'), { store, client: {}, logger: noopLogger,
    config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, allowed ? 'BATCH_IN_FLIGHT' : 'SOURCE_CARD_BINDING_CONFLICT');
  assert.equal(claims, allowed ? 1 : 0);
  if (allowed) assert.deepEqual(origins, ['om_roster_saved', 'om_proven_history']);
});

test('单条名单保存新卡仅从匹配的服务端pending恢复历史来源', async () => {
  const body = sourceCardFixture(21).deliveries[0]; delete body.source_card_manifest; delete body.source_card_chunk_index;
  const n = normalize(body), fields = n.fieldsList[0]; const origins = [];
  const store = { getPending: async () => ({ form_message_id: 'om_saved_single', chat_id: n.chatId,
    original_message_id: 'om_proven_history', request_context: fields }),
  assertLegacySourceCardMembers: async ({ messageId }) => {
    origins.push(messageId);
    if (messageId !== 'om_proven_history') throw Object.assign(new Error('conflict'), { code: 'SOURCE_CARD_BINDING_CONFLICT' });
  }, cleanupExpired: async () => {}, getDailyState: async () => null, savePending: async () => {} };
  const result = await handleDispatchEvent(callbackBody(dispatchActionValue(fields), n.chatId, 'om_saved_single'), { store,
    client: { replyInteractiveCard: async () => ({ message_id: 'om_next_form' }) }, logger: noopLogger,
    config: { phase: 'p1', allowedChatIds: [n.chatId] } });
  assert.equal(result.errorCode, undefined); assert.deepEqual(origins, ['om_saved_single', 'om_proven_history']);
});
