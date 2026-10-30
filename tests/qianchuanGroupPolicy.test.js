import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedDecisionGroups, registerQianchuanSource, stableJson, decisionSnapshotHash } from '../lib/dispatch/qianchuan-policy.js';
import { normalizeBatchDispatchIngest, batchDispatchActionValue, dispatchIdempotencyValue } from '../lib/dispatch/ingest.js';
import { validateBatchDispatchValue } from '../lib/lark/card-actions.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { TEST_DISPATCH_CHAT_ID } from '../lib/dispatch/profile.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { LarkClient } from '../lib/lark/client.js';

const NOW = new Date('2026-10-26T08:00:00Z');
const DAY = '2026-10-26';
const ROSTER = ['A', 'B', 'C', 'D', 'E'];
function sourceItems(spec = [{ object: 'a' }, { object: 'b' }, { object: 'c', code: true },
  { object: 'b' }, { object: 'd', code: true }, { object: 'e', code: true }, { object: 'f' }]) {
  return spec.map((row, index) => ({
    request_id: `r${index}`, request_name: `isolated ${index}`, business_type: '千川', target_category: 'qianchuan',
    sheet_url: 'https://example.feishu.cn/sheets/local_test', sheet_id: 'sheetA', row_index: 10 + index,
    assignee_field_id: 'N', assignee_field_name: '领取人', request_field_id: 'X', date_field_id: 'A',
    project_field_id: 'C', project_value: '千川', audit_object_id: row.object ?? '',
    reject_reason_codes: row.code ? ['1005004'] : [], contains_code_1005004: Boolean(row.code),
    decision_group: row.code ? 'contains_1005004' : 'without_1005004',
    source_batch_id: 'root-source', decision_policy_version: 'code-membership-1005004/v1',
  }));
}
function payload(source = sourceItems(), selected = source.slice(0, 20), batchId = 'delivery_1') {
  return { chat_id: TEST_DISPATCH_CHAT_ID, batch_id: batchId, card_title: 'isolated qianchuan', time_segment: 'D',
    source_batch_id: 'root-source', decision_policy_version: source[0].decision_policy_version,
    decision_snapshot_hash: decisionSnapshotHash(source), decision_snapshot: structuredClone(source), items: structuredClone(selected) };
}
function currentSource(source = sourceItems()) {
  return source.map((row) => {
    const copy = structuredClone(row);
    copy.reject_reason_codes = copy.reject_reason_codes.map((code) => code === '1005004' ? '1000676' : code);
    copy.contains_code_1000676 = copy.contains_code_1005004;
    delete copy.contains_code_1005004;
    copy.decision_group = copy.contains_code_1000676 ? 'contains_1000676' : 'without_1000676';
    copy.decision_policy_version = 'code-membership-1000676/v2';
    return copy;
  });
}
function normalized(body) { return normalizeBatchDispatchIngest(body, { splitCards: true }); }
function policyFields(spec) { return spec.map((r) => ({ auditObjectId: r[0], containsCode1005004: Boolean(r[1]) })); }

test('snapshot canonical JSON sorts object keys, not requirement or code arrays', () => {
  const source = sourceItems();
  const reorderedKeys = source.map((row) => Object.fromEntries(Object.entries(row).reverse()));
  assert.equal(decisionSnapshotHash(source), decisionSnapshotHash(reorderedKeys));
  assert.notEqual(decisionSnapshotHash(source), decisionSnapshotHash([...source].reverse()));
  assert.notEqual(decisionSnapshotHash([{ codes: ['1','2'] }]), decisionSnapshotHash([{ codes: ['2','1'] }]));
});
test('UTF-8 canonical SHA256 matches an independently checked Python vector including Unicode and long ID', () => {
  const vector = [{ request_id: '001', audit_object_id: '922337203685477580812345', request_name: '千川😀',
    reject_reason_codes: ['1000541','1005004'], row_index: 5433, contains_code_1005004: true },
  { request_id: '002', audit_object_id: '', reject_reason_codes: [], row_index: 5434, contains_code_1005004: false }];
  assert.equal(decisionSnapshotHash(vector), 'aeaff0088012dea77e38a73a2c8309867737c0e2e1f882e7637c371a13282021');
});
test('changed snapshot content/order with old hash is rejected before persistence', () => {
  for (const change of [(body) => body.decision_snapshot.reverse(),
    (body) => { body.decision_snapshot[0].request_name = 'changed display value'; }]) {
    const body = payload(); change(body);
    assert.throws(() => normalized(body), { code: 'QIANCHUAN_SNAPSHOT_HASH_MISMATCH' });
  }
});
test('a recomputed hash does not authorize replacing an already registered source', async () => {
  const store = createMemoryBatchStore(); const body = payload();
  await registerQianchuanSource(store, normalized(body), NOW);
  body.decision_snapshot.reverse(); body.decision_snapshot_hash = decisionSnapshotHash(body.decision_snapshot);
  await assert.rejects(registerQianchuanSource(store, normalized(body), NOW), { code: 'QIANCHUAN_SOURCE_CONFLICT' });
});
test('snapshot excludes self-hash, per-delivery identity and runtime receipts', () => {
  for (const key of ['decision_snapshot_hash','decision_manifest_hash','batch_id','operation_id','message_id','record_id','signature']) {
    assert.throws(() => decisionSnapshotHash([{ [key]: 'forbidden' }]), { code: 'QIANCHUAN_SNAPSHOT_RUNTIME_FIELD' });
  }
});
test('snapshot hash rejects JSON forms that have ambiguous cross-language serialization', () => {
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER+1, -0, undefined]) {
    assert.throws(() => decisionSnapshotHash([{ invalid: value }]), { code: 'QIANCHUAN_INVALID_SNAPSHOT_JSON' });
  }
  assert.throws(() => decisionSnapshotHash([{ invalid: '\ud800' }]), { code: 'QIANCHUAN_INVALID_SNAPSHOT_JSON' });
});

test('same object wins; isolated code follows predecessor; adjacent code run consumes one turn', () => {
  assert.deepEqual(expectedDecisionGroups(policyFields([['a'], ['b'], ['c', 1], ['b'], ['d', 1], ['e', 1], ['f']])), [0, 1, 1, 1, 2, 2, 3]);
});
test('empty IDs do not form a shared object group; code is not a substring/text match', () => {
  const raw = sourceItems([{ object: '' }, { object: '' }]);
  raw[0].reject_reason_codes = ['10050040']; raw[0].reject_reason = '活动规则前后不一致';
  const n = normalized(payload(raw));
  assert.deepEqual(n.qianchuanSnapshot.members.map((m) => m.assignmentGroup), ['g0', 'g1']);
});
test('object priority can override one member of an adjacent-code run without merging unrelated earlier groups', () => {
  assert.deepEqual(expectedDecisionGroups(policyFields([['a'], ['b'], ['a', 1], ['c', 1], ['b']])), [0, 1, 0, 2, 1]);
});
test('first-row isolated special code has no predecessor and takes one normal turn', () => {
  assert.deepEqual(expectedDecisionGroups(policyFields([['a', 1], ['b']])), [0, 1]);
});
test('real upstream bucket labels are preserved but are not assignee groups', () => {
  const n = normalized(payload());
  assert.equal(n.fieldsList[2].decisionGroup, n.fieldsList[4].decisionGroup);
  assert.notEqual(n.qianchuanSnapshot.members[2].assignmentGroup, n.qianchuanSnapshot.members[4].assignmentGroup);
  assert.equal(n.fieldsList[2].sourcePosition, 2);
});
test('current upstream payload without complete original order is rejected, never silently downgraded', () => {
  const body = payload(); delete body.decision_snapshot;
  assert.throws(() => normalized(body), { code: 'QIANCHUAN_SOURCE_SNAPSHOT_REQUIRED' });
});
test('long object ID remains a string through normalization and callback roundtrip', () => {
  const raw = sourceItems([{ object: '922337203685477580812345' }]);
  const n = normalized(payload(raw));
  const action = batchDispatchActionValue(n.batchId, n.fieldsList);
  const parsed = validateBatchDispatchValue(action, { chatId: TEST_DISPATCH_CHAT_ID });
  assert.equal(parsed.items[0].auditObjectId, raw[0].audit_object_id);
  assert.deepEqual(parsed.items, n.fieldsList);
});
for (const [name, mutate, code] of [
  ['numeric long object', (b) => { b.items[0].audit_object_id = 9223372036854775808; }, 'QIANCHUAN_INVALID_CONTRACT'],
  ['numeric code', (b) => { b.items[0].reject_reason_codes = [1005004]; }, 'QIANCHUAN_INVALID_REASON_CODES'],
  ['flag drift', (b) => { b.items[0].contains_code_1005004 = true; }, 'QIANCHUAN_REASON_FLAG_CONFLICT'],
  ['missing required metadata', (b) => { delete b.items[0].audit_object_id; }, 'QIANCHUAN_INVALID_CONTRACT'],
  ['source drift', (b) => { b.items[0].source_batch_id = 'changed'; }, 'QIANCHUAN_BATCH_ITEM_CONFLICT'],
  ['delivery group drift', (b) => { b.items[0].decision_group = 'changed'; }, 'QIANCHUAN_INVALID_DELIVERY_GROUP'],
]) test(`v2 fail closed: ${name}`, () => {
  const b = payload(); mutate(b); assert.throws(() => normalized(b), { code });
});
test('reason codes are trimmed/deduplicated/sorted and flags use exact membership', () => {
  const raw = sourceItems([{ object: 'a', code: true }]);
  raw[0].reject_reason_codes = ['1005004', '', ' 1000541 ', '1005004'];
  assert.deepEqual(normalized(payload(raw)).fieldsList[0].rejectReasonCodes, ['1000541', '1005004']);
});
test('delivery limit is 20, but one business group can span 25 source members', () => {
  const source = sourceItems(Array.from({ length: 25 }, () => ({ object: 'same-object' })));
  const first = normalized(payload(source, source.slice(0, 20)));
  const second = normalized(payload(source, source.slice(20), 'delivery_2'));
  assert.equal(first.qianchuanSnapshot.members.length, 25);
  assert.equal(new Set(first.qianchuanSnapshot.members.map((m) => m.assignmentGroup)).size, 1);
  assert.equal(first.qianchuanSnapshot.snapshotHash, second.qianchuanSnapshot.snapshotHash);
  assert.throws(() => normalized(payload(source, source)), { code: 'INVALID_BATCH_SIZE', maxItems: 20 });
});
test('source ordering, codes, upstream hash and policy all bind the server fingerprint', () => {
  const base = payload();
  const first = normalized(base);
  for (const mutate of [
    (b) => { b.decision_snapshot.reverse(); },
    (b) => { b.decision_snapshot[0].reject_reason_codes = ['123']; b.items[0].reject_reason_codes = ['123']; },
  ]) {
    const changed = structuredClone(base); mutate(changed);
    changed.decision_snapshot_hash = decisionSnapshotHash(changed.decision_snapshot);
    assert.notEqual(stableJson(normalized(changed).fieldsList.map(dispatchIdempotencyValue)),
      stableJson(first.fieldsList.map(dispatchIdempotencyValue)));
  }
  const wrongHash = structuredClone(base); wrongHash.decision_snapshot_hash = 'b'.repeat(64);
  assert.throws(() => normalized(wrongHash), { code: 'QIANCHUAN_SNAPSHOT_HASH_MISMATCH' });
  const future = structuredClone(base); future.decision_policy_version = 'v3';
  for (const row of [...future.items, ...future.decision_snapshot]) row.decision_policy_version = 'v3';
  assert.throws(() => normalized(future), { code: 'UNSUPPORTED_QIANCHUAN_POLICY' });
});

async function scenario({ spec, manual = {}, afterAssign, writeFailure = false, failReadback = false, currentPolicy = false } = {}) {
  const raw = currentPolicy ? currentSource(sourceItems(spec)) : sourceItems(spec);
  const store = createMemoryBatchStore({ now: () => NOW });
  await store.initializeRoster({ dayKey: DAY, scope: 'test_default', roster: ROSTER, expiresAt: '2026-10-26T16:00:00Z' });
  const cells = new Map();
  const set = (column, row, value) => cells.set(`${column}${row}`, value);
  const cell = (column, row) => cells.get(`${column}${row}`) || '';
  raw.forEach((item) => { set('X', item.row_index, item.request_id); set('A', item.row_index, DAY);
    set('C', item.row_index, '千川'); set('N', item.row_index, manual[item.request_id] || ''); });
  set('A', 9, DAY); set('C', 9, '千川'); set('N', 9, 'E');
  const calls = [];
  const faults = { failReadback, writeFailure };
  let wrote = false;
  const client = new LarkClient({ appId: 'mock', appSecret: 'not-a-real-secret', fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    const call = { path: endpoint.pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (call.path.endsWith('/tenant_access_token/internal')) return { ok: true, status: 200,
      text: async () => JSON.stringify({ code: 0, tenant_access_token: 'mock', expire: 7200 }) };
    let data;
    if (call.path.endsWith('/sheets/query')) data = { sheets: [{ sheet_id: 'sheetA', grid_properties: { row_count: 100, column_count: 24 } }] };
    else if (call.path.endsWith('/values_batch_get')) {
      if (wrote && faults.failReadback) throw new Error('readback unreachable');
      data = { valueRanges: endpoint.searchParams.get('ranges').split(',').map((range) => {
        const [, column, start, end] = range.match(/!([A-Z]+)(\d+):\1(\d+)$/);
        return { range, revision: 1, values: Array.from({ length: Number(end) - Number(start) + 1 }, (_, i) => [cell(column, Number(start) + i)]) };
      }) };
    } else if (call.path.endsWith('/values_batch_update')) {
      call.body.valueRanges.forEach((entry) => {
        const [, column, row] = entry.range.match(/!([A-Z]+)(\d+):/); set(column, Number(row), entry.values[0][0]);
      }); wrote = true;
      if (faults.writeFailure) throw new Error('response lost after commit');
      data = { responses: [] };
    } else throw new Error(`unexpected network endpoint ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  } });
  client.getMessage = async () => null;
  client.updateMessageCard = async () => {};
  client.replyInteractiveCard = async () => ({ message_id: 'result_mock' });
  const facts = async () => Object.entries((await store.getDailyState(DAY, 'test_default')).assignments || {})
    .map(([id, assignment]) => ({ ...assignment, request_id: id, request_context: assignment.context,
      day_key: DAY, scope: 'test_default' })).sort((a, b) => b.assignment_seq - a.assignment_seq);
  store.getDispatchSnapshot = async () => ({ state: await store.getDailyState(DAY, 'test_default'), assignments: await facts() });
  store.getDailyAssignments = facts;
  const original = store.assignQianchuanBatch.bind(store);
  store.assignQianchuanBatch = async (args) => { const result = await original(args); await afterAssign?.({ store, cells, set }); return result; };
  const execute = async (selected = raw.slice(0, 20), batchId = 'delivery_1') => {
    const n = normalized(payload(raw, selected, batchId));
    await registerQianchuanSource(store, n, NOW);
    const response = await handleDispatchEvent({ header: { event_id: batchId }, event: {
      operator: { open_id: 'test_operator' }, context: { open_chat_id: TEST_DISPATCH_CHAT_ID, open_message_id: `card_${batchId}` },
      action: { tag: 'button', value: batchDispatchActionValue(n.batchId, n.fieldsList) },
    } }, { store, client, now: () => NOW, config: { allowedChatIds: TEST_DISPATCH_CHAT_ID }, logger: { info() {} } });
    await response.afterResponse?.();
    return { response, batch: await store.getBatch(TEST_DISPATCH_CHAT_ID, batchId) };
  };
  return { raw, store, client, execute, cells, cell, set, calls, facts, faults,
    writes: () => calls.filter((c) => c.path.endsWith('/values_batch_update')) };
}

test('real callback + Lark adapter stub: grouped allocation, one batch PUT, one confirmation', async () => {
  const s = await scenario(); const { batch } = await s.execute();
  assert.equal(batch.status, 'SUCCESS', JSON.stringify(batch.results));
  assert.deepEqual(batch.results.map((r) => r.assignee), ['A', 'B', 'B', 'B', 'C', 'C', 'D']);
  assert.equal(s.writes().length, 1); assert.equal(s.writes()[0].body.valueRanges.length, 7);
  assert.equal((await s.store.getDailyState(DAY, 'test_default')).forward_cursor, 4);
  assert.equal((await s.facts()).length, 7);
  await s.execute(); assert.equal(s.writes().length, 1);
});
test('second delivery clicked first reserves the same complete plan; only its own five rows are written', async () => {
  const s = await scenario({ spec: Array.from({ length: 25 }, (_, i) => ({ object: i === 24 ? 'o1' : `o${i}` })) });
  const second = await s.execute(s.raw.slice(20), 'delivery_2');
  assert.equal(second.batch.status, 'SUCCESS', JSON.stringify(second.batch.results));
  assert.equal(s.writes()[0].body.valueRanges.length, 5);
  assert.equal((await s.facts()).length, 5);
  const cursor = (await s.store.getDailyState(DAY, 'test_default')).forward_cursor;
  const first = await s.execute(s.raw.slice(0, 20), 'delivery_1');
  assert.equal(first.batch.status, 'SUCCESS', JSON.stringify(first.batch.results));
  assert.equal(first.batch.results[1].assignee, second.batch.results[4].assignee);
  assert.equal((await s.store.getDailyState(DAY, 'test_default')).forward_cursor, cursor);
  assert.deepEqual(s.writes().map((w) => w.body.valueRanges.length), [5, 20]);
});
test('all 25 members of one object span cards without a second turn', async () => {
  const s = await scenario({ spec: Array.from({ length: 25 }, () => ({ object: 'same' })) });
  await s.execute(s.raw.slice(20), 'delivery_2'); await s.execute(s.raw.slice(0, 20));
  assert.ok((await s.facts()).every((r) => r.assignee === 'A'));
  assert.equal((await s.store.getDailyState(DAY, 'test_default')).forward_cursor, 1);
});
test('code buckets do not change source adjacency or predecessor decisions', async () => {
  const s = await scenario();
  const special = await s.execute(s.raw.filter((r) => r.contains_code_1005004), 'delivery_special');
  const regular = await s.execute(s.raw.filter((r) => !r.contains_code_1005004), 'delivery_regular');
  assert.equal(special.batch.status, 'SUCCESS', JSON.stringify(special.batch.results));
  assert.equal(regular.batch.status, 'SUCCESS', JSON.stringify(regular.batch.results));
  assert.deepEqual((await s.facts()).sort((a, b) => a.request_id.localeCompare(b.request_id)).map((r) => r.assignee), ['A', 'B', 'B', 'B', 'C', 'C', 'D']);
});
test('manual prefill is preserved and binds its entire object group without an automatic turn', async () => {
  const s = await scenario({ spec: [{ object: 'same' }, { object: 'same' }, { object: 'new' }], manual: { r0: 'C' } });
  const { batch } = await s.execute();
  assert.equal(batch.status, 'SUCCESS', JSON.stringify(batch.results));
  assert.equal(s.cell('N', 10), 'C'); assert.equal(s.cell('N', 11), 'C'); assert.equal(s.cell('N', 12), 'D');
  assert.equal(s.writes()[0].body.valueRanges.length, 2);
});
test('conflicting manual values in one object group: zero decisions, zero PUT', async () => {
  const s = await scenario({ spec: [{ object: 'same' }, { object: 'same' }], manual: { r0: 'B', r1: 'C' } });
  const { batch } = await s.execute();
  assert.equal(batch.status, 'FAILED'); assert.equal(batch.results[0].errorCode, 'QIANCHUAN_MANUAL_GROUP_CONFLICT');
  assert.equal((await s.facts()).length, 0); assert.equal(s.writes().length, 0);
});
test('manual race after decision commit: zero PUT and no legacy allocation fallback', async () => {
  const s = await scenario({ afterAssign: ({ set }) => set('N', 10, 'E') });
  const { batch } = await s.execute();
  assert.equal(batch.status, 'FAILED'); assert.equal(s.writes().length, 0); assert.equal(s.cell('N', 10), 'E');
  assert.equal(batch.results[0].errorCode, 'SHEET_TARGET_CHANGED');
});
test('lost PUT response is confirmed by readback, not a second PUT', async () => {
  const s = await scenario({ writeFailure: true }); const { batch } = await s.execute();
  assert.equal(batch.status, 'SUCCESS', JSON.stringify(batch.results)); assert.equal(s.writes().length, 1);
});
test('unknown readback keeps source pending and blocks other delivery', async () => {
  const s = await scenario({ spec: Array.from({ length: 25 }, (_, i) => ({ object: `o${i}` })), failReadback: true });
  await s.execute();
  const root = await s.store.getQianchuanSource({ scope: 'test_default', sourceBatchId: 'root-source' });
  assert.equal(root.pendingIds.length, 20);
  s.faults.failReadback = false;
  const other = await s.execute(s.raw.slice(20), 'delivery_2');
  assert.equal(other.batch.status, 'FAILED');
  assert.equal(other.batch.results[0].errorCode, 'QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
  assert.equal(s.writes().length, 1);
  const recovered = await s.execute();
  assert.equal(recovered.batch.status, 'SUCCESS', JSON.stringify(recovered.batch.results));
  assert.equal(s.writes().length, 1, 'recover only the missing receipt');
  const state = await s.store.getDailyState(DAY, 'test_default');
  await assert.rejects(s.store.assignQianchuanBatch({ dayKey: DAY, scope: 'test_default',
    chatId: TEST_DISPATCH_CHAT_ID, batchId: 'delivery_1', claimToken: 'stale', items: [],
    expectedVersion: state.version, expectedCursorVersion: state.forward_version }), { code: 'BATCH_CLAIM_LOST' });
  assert.equal(s.writes().length, 1);
});
test('decision committed but RPC response lost: original card resumes original decisions', async () => {
  let once = true;
  const s = await scenario({ afterAssign: () => { if (once) { once = false; throw new Error('RPC response lost'); } } });
  const first = await s.execute();
  assert.equal(first.batch.status, 'FAILED'); assert.equal(s.writes().length, 0);
  const cursor = (await s.store.getDailyState(DAY, 'test_default')).forward_cursor;
  const second = await s.execute();
  assert.equal(second.batch.status, 'SUCCESS', JSON.stringify(second.batch.results));
  assert.equal((await s.store.getDailyState(DAY, 'test_default')).forward_cursor, cursor);
  assert.equal((await s.facts()).length, 7); assert.equal(s.writes().length, 1);
});
test('receipt persistence outage: recover by reread and receipt only, zero extra PUT', async () => {
  const s = await scenario(); let once = true;
  const original = s.store.confirmQianchuanWrites.bind(s.store);
  s.store.confirmQianchuanWrites = async (args) => {
    if (once) { once = false; throw new Error('database response missing'); }
    return original(args);
  };
  assert.equal((await s.execute()).batch.status, 'FAILED');
  assert.equal((await s.execute()).batch.status, 'SUCCESS');
  assert.equal(s.writes().length, 1); assert.equal((await s.facts()).length, 7);
});
test('another delivery cannot take over the same pending rows and issue a concurrent PUT', async () => {
  const s = await scenario({ afterAssign: () => { throw new Error('stop before first PUT'); } });
  await s.execute();
  const other = await s.execute(s.raw, 'same_rows_different_delivery');
  assert.equal(other.batch.results[0].errorCode, 'QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
  assert.equal(s.writes().length, 0);
});
test('malformed successful receipt response cannot report business SUCCESS', async () => {
  const s = await scenario(); s.store.confirmQianchuanWrites = async () => ({});
  const { batch } = await s.execute();
  assert.equal(batch.status, 'FAILED'); assert.equal(batch.results[0].errorCode, 'QIANCHUAN_RECEIPT_RESPONSE_INVALID');
  assert.equal(s.writes().length, 1);
  assert.equal((await s.store.getQianchuanSource({ scope: 'test_default', sourceBatchId: 'root-source' })).pendingIds.length, 7);
});
test('malformed source registration receipt stops before handing off a card', async () => {
  const n = normalized(payload());
  await assert.rejects(registerQianchuanSource({ registerQianchuanSource: async () => ({}) }, n, NOW),
    { code: 'QIANCHUAN_SOURCE_RECEIPT_INVALID' });
});
test('new legacy entrypoint cannot bypass grouped decision for a single request', async () => {
  const s = await scenario(); const n = normalized(payload());
  const action = batchDispatchActionValue(n.batchId, n.fieldsList).items[0];
  const response = await handleDispatchEvent({ event: { operator: { open_id: 'operator' },
    context: { open_chat_id: TEST_DISPATCH_CHAT_ID, open_message_id: 'card' },
    action: { tag: 'button', value: action } } }, { store: s.store, client: s.client,
    config: { allowedChatIds: TEST_DISPATCH_CHAT_ID }, now: () => NOW, logger: { info() {} } });
  assert.equal(response.errorCode, 'QIANCHUAN_BATCH_ACTION_REQUIRED'); assert.equal(s.writes().length, 0);
});
test('scope isolation: no legacy/default, AD or emergency state is created', async () => {
  const s = await scenario(); await s.execute();
  for (const scope of ['default', 'ad_review', 'ad_game', 'ad_emergency']) assert.equal(await s.store.getDailyState(DAY, scope), null);
});
test('expired or unregistered source rejects before creating a new-day roster form', async () => {
  const n = normalized(payload());
  for (const registered of [false, true]) {
    const store = createMemoryBatchStore({ now: () => NOW });
    if (registered) await store.registerQianchuanSource({ dayKey: '2026-10-25', scope: 'test_default', snapshot: n.qianchuanSnapshot });
    let replied = 0;
    store.getDailyState = async () => { throw new Error('must reject before reading or initializing today roster'); };
    const response = await handleDispatchEvent({ event: { operator: { open_id: 'operator' },
      context: { open_chat_id: TEST_DISPATCH_CHAT_ID, open_message_id: 'card' },
      action: { tag: 'button', value: batchDispatchActionValue(n.batchId, n.fieldsList) } } }, {
      store, client: { getMessage: async () => null, replyInteractiveCard: async () => { replied += 1; } },
      config: { allowedChatIds: TEST_DISPATCH_CHAT_ID }, now: () => NOW, logger: { info() {} },
    });
    assert.equal(response.errorCode, 'QIANCHUAN_SOURCE_CONFLICT'); assert.equal(replied, 0);
  }
});
test('source manifest is immutable, including policy, upstream hash, grouping and day', async () => {
  const store = createMemoryBatchStore(); const n = normalized(payload());
  await registerQianchuanSource(store, n, NOW); await registerQianchuanSource(store, n, NOW);
  for (const change of [(s) => { s.policyVersion = 'changed'; }, (s) => { s.upstreamSnapshotHash = 'b'.repeat(64); },
    (s) => { s.members[0].assignmentGroup = 'changed'; }]) {
    const snapshot = structuredClone(n.qianchuanSnapshot); change(snapshot);
    await assert.rejects(store.registerQianchuanSource({ dayKey: DAY, scope: 'test_default', snapshot }), { code: 'QIANCHUAN_SOURCE_CONFLICT' });
  }
  await assert.rejects(store.registerQianchuanSource({ dayKey: '2026-10-27', scope: 'test_default', snapshot: n.qianchuanSnapshot }), { code: 'QIANCHUAN_SOURCE_CONFLICT' });
});

test('1000676/v2 callback roundtrip preserves the new flag and exact code policy', () => {
  const source = currentSource(); const n = normalized(payload(source,source.filter((r)=>r.contains_code_1000676)));
  const action = batchDispatchActionValue(n.batchId, n.fieldsList);
  assert.equal(action.items[0].contains_code_1000676, true);
  assert.equal(Object.hasOwn(action.items[0], 'contains_code_1005004'), false);
  assert.deepEqual(validateBatchDispatchValue(action, { chatId: TEST_DISPATCH_CHAT_ID }).items, n.fieldsList);
  assert.deepEqual(n.qianchuanSnapshot.members.map((m) => m.assignmentGroup), ['g0','g1','g1','g1','g2','g2','g3']);
});

test('1000676/v2 excludes old, mistyped, substring and text-only codes', () => {
  for (const code of ['1005004','1000567','10006760']) {
    const raw = currentSource(sourceItems([{ object:'a' }, { object:'b' }]));
    raw[1].reject_reason_codes = [code]; raw[1].reject_reason = '活动规则前后不一致1000676';
    const n = normalized(payload(raw));
    assert.equal(n.fieldsList[1].containsCode1000676, false);
    assert.deepEqual(n.qianchuanSnapshot.members.map((m) => m.assignmentGroup), ['g0','g1']);
  }
});

test('1000676/v2 cannot mix legacy field, old buckets or unsupported policy', () => {
  for (const [mutate,code] of [
    [(b) => { b.items[0].contains_code_1005004 = false; },'QIANCHUAN_REASON_FLAG_CONFLICT'],
    [(b) => { b.items[0].decision_group = 'without_1005004'; },'QIANCHUAN_INVALID_DELIVERY_GROUP'],
    [(b) => { b.items[0].decision_policy_version = 'toString'; },'UNSUPPORTED_QIANCHUAN_POLICY'],
  ]) {
    const b = payload(currentSource()); mutate(b); assert.throws(() => normalized(b), { code });
  }
});

test('old policy remains explicitly versioned; same source cannot be upgraded in place', async () => {
  const store = createMemoryBatchStore();
  const legacy = normalized(payload()); await registerQianchuanSource(store, legacy, NOW);
  assert.equal(legacy.fieldsList[2].containsCode1005004, true);
  const source=currentSource();
  await assert.rejects(registerQianchuanSource(store, normalized(payload(source,[source[0]])), NOW), { code:'QIANCHUAN_SOURCE_CONFLICT' });
});

test('1000676/v2 real callback stub keeps whole-source groups and one batch write per bucket', async () => {
  const s = await scenario({ currentPolicy:true });
  const result = await s.execute(s.raw.filter((r)=>!r.contains_code_1000676),'normal');
  assert.equal(result.batch.status, 'SUCCESS');
  assert.deepEqual(result.batch.results.map((r) => r.assignee), ['A','B','B','D']);
  const special=await s.execute(s.raw.filter((r)=>r.contains_code_1000676),'special');
  assert.equal(special.batch.status,'SUCCESS'); assert.deepEqual(special.batch.results.map((r)=>r.assignee),['B','C','C']);
  assert.equal(s.writes().length, 2); assert.equal((await s.store.getDailyState(DAY,'test_default')).forward_cursor,4);
});

test('1000676/v2 reverse bucket click and 25-member adjacent run keep original source decisions', async () => {
  const s = await scenario({ currentPolicy:true });
  await s.execute(s.raw.filter((r) => r.contains_code_1000676), 'special');
  await s.execute(s.raw.filter((r) => !r.contains_code_1000676), 'normal');
  assert.deepEqual((await s.facts()).sort((a,b) => a.request_id.localeCompare(b.request_id)).map((r) => r.assignee), ['A','B','B','B','C','C','D']);
  const large = await scenario({ currentPolicy:true, spec:Array.from({length:25},(_,i) => ({object:`new${i}`,code:true})) });
  await large.execute(large.raw.slice(20),'second'); await large.execute(large.raw.slice(0,20),'first');
  assert.deepEqual(large.writes().map((w) => w.body.valueRanges.length),[5,20]);
  assert.ok((await large.facts()).every((r) => r.assignee==='A'));
  assert.equal((await large.store.getDailyState(DAY,'test_default')).forward_cursor,1);
});

test('row moves after committed decision: original card recovers latest target without mutating decision or cursor', async () => {
  let first = true;
  const s = await scenario({ currentPolicy:true, spec:[{object:'a'},{object:'b'},{object:'b'}],
    afterAssign:() => { if (first) { first=false; throw new Error('lost decision response'); } } });
  const failed = await s.execute(); assert.equal(failed.batch.status,'FAILED'); assert.equal(s.writes().length,0);
  const before = await s.store.getDailyState(DAY,'test_default');
  for (const row of [...s.raw].reverse()) for (const col of ['X','A','C','N']) {
    s.set(col,row.row_index+30,s.cell(col,row.row_index)); s.set(col,row.row_index,'');
  }
  const restored = await s.execute();
  assert.equal(restored.batch.status,'SUCCESS',JSON.stringify(restored.batch.results));
  assert.equal(s.writes().length,1);
  assert.ok(s.writes()[0].body.valueRanges.every((r) => Number(r.range.match(/N(\d+):/)[1])>=40));
  const after = await s.store.getDailyState(DAY,'test_default');
  assert.equal(after.forward_cursor,before.forward_cursor); assert.deepEqual(after.assignments,before.assignments);
  assert.equal((await s.store.getQianchuanSource({scope:'test_default',sourceBatchId:'root-source'})).pendingIds.length,0);
});
