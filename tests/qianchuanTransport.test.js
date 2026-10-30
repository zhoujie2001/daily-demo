import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';
import { TEST_DISPATCH_CHAT_ID } from '../lib/dispatch/profile.js';
import { decisionSnapshotHash } from '../lib/dispatch/qianchuan-policy.js';
import { normalizeBatchDispatchIngest, dispatchIdempotencyValue } from '../lib/dispatch/ingest.js';

function payload() {
  const source = [false, true, false].map((code, index) => ({ request_id: `probe${index}`,
    request_name: `isolated ${index}`, business_type: '千川', target_category: 'qianchuan',
    sheet_url: 'https://example.feishu.cn/sheets/isolated', sheet_id: 'sheetA', row_index: 10+index,
    assignee_field_id: 'N', date_field_id: 'A', request_field_id: 'X', audit_object_id: `92233720368547758081234${index}`,
    reject_reason_codes: code ? ['1005004'] : [], contains_code_1005004: code,
    decision_group: code ? 'contains_1005004' : 'without_1005004', source_batch_id: 'original_source',
    decision_policy_version: 'code-membership-1005004/v1' }));
  return { chat_id: TEST_DISPATCH_CHAT_ID, batch_id: 'run-contains_1005004-01', card_title: 'isolated', time_segment: 'D',
    decision_group: 'contains_1005004', source_batch_id: 'original_source', decision_policy_version: 'code-membership-1005004/v1',
    decision_snapshot_hash: decisionSnapshotHash(source), decision_snapshot: source, items: [source[1]] };
}
async function invoke(body, { dryRun = false, sourceError, missingSource = false } = {}) {
  const calls = []; let publishedCard;
  const store = {
    ...(missingSource ? {} : { registerQianchuanSource: async (args) => {
      calls.push('source'); assert.equal(args.snapshot.members.length, 3);
      assert.equal(args.scope, 'test_default');
      assert.equal(args.snapshot.members[0].assignmentGroup, args.snapshot.members[1].assignmentGroup);
      if (sourceError) throw Object.assign(new Error(sourceError), { code: sourceError, status: 409 });
      return { outcome: 'ACCEPTED' };
    } }),
    reserveDispatchIngestRoot: async () => { calls.push('root'); return { outcome: 'ACCEPTED' }; },
    registerDispatchHandoff: async (args) => {
      calls.push('handoff'); publishedCard = args.card; return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
    },
    confirmDispatchHandoff: async () => {}, markDispatchHandoffUnknown: async () => {},
  };
  const handler = createAutomationSendHandler({ secret: 'mock-only', client: {},
    now: () => new Date('2026-10-26T08:00:00Z'), storeFactory: () => store,
    publishDispatch: async () => { calls.push('publish'); return { message_id: 'mock_queue' }; },
    statusCache: { get() {}, set() {} }, defer() {}, enrichRejectReasons: async () => [] });
  const result = {};
  const res = { status(code) { result.status = code; return res; }, json(value) { result.body = value; return res; }, setHeader() {} };
  await handler({ method: 'POST', headers: {}, body: { automation_token: 'mock-only', dispatch_payload: body,
    source_record_id: 'isolated_record', dry_run: dryRun } }, res);
  return { ...result, calls, publishedCard };
}

test('actual upstream bucket + complete ordered snapshot: freeze source before handoff, small callback references only', async () => {
  const result = await invoke(payload());
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.deepEqual(result.calls, ['source','root','handoff','publish']);
  const text = JSON.stringify(result.publishedCard);
  assert.ok(text.includes('decision_manifest_hash')); assert.ok(text.includes('922337203685477580812341'));
  assert.ok(!text.includes('decision_snapshot"'), 'the full original source is never copied into callback payload');
});
test('v2 dry-run validates snapshot but persists nothing and publishes nothing', async () => {
  const result = await invoke(payload(), { dryRun: true });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'DRY_RUN_OK'); assert.deepEqual(result.calls, []);
});
test('wrong source hash or changed original order: no registration, handoff or publish', async () => {
  for (const change of [(body) => { body.decision_snapshot_hash = '0'.repeat(64); },
    (body) => { body.decision_snapshot.reverse(); }]) {
    const body = payload(); change(body);
    const result = await invoke(body);
    assert.equal(result.status, 400); assert.equal(result.body.error_code, 'QIANCHUAN_SNAPSHOT_HASH_MISMATCH');
    assert.deepEqual(result.calls, []);
  }
});
test('root/item delivery bucket mismatch: zero persistence and queue side effects', async () => {
  const body = payload(); body.decision_group='without_1005004';
  const result = await invoke(body); assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'QIANCHUAN_BATCH_ITEM_CONFLICT'); assert.deepEqual(result.calls, []);
});

test('legacy unified accepts a homogeneous card without mutating payload or changing identity', async () => {
  for (const special of [false,true]) {
    const body = payload();
    body.items = body.decision_snapshot.filter((item) => item.contains_code_1005004 === special);
    body.decision_group = special ? 'contains_1005004' : 'without_1005004';
    const explicit = normalizeBatchDispatchIngest(body, {splitCards:true});
    body.decision_group = 'unified'; const frozen = structuredClone(body);
    const alias = normalizeBatchDispatchIngest(body, {splitCards:true});
    assert.deepEqual(body,frozen);
    assert.deepEqual(alias.qianchuanSnapshot,explicit.qianchuanSnapshot);
    assert.deepEqual(alias.fieldsList.map(dispatchIdempotencyValue),explicit.fieldsList.map(dispatchIdempotencyValue));
    const result = await invoke(body);
    assert.equal(result.status,202,JSON.stringify(result.body));
    assert.deepEqual(result.calls,['source','root','handoff','publish']);
    assert.deepEqual(body,frozen);
  }
});

test('legacy unified mixed delivery preserves per-item groups, snapshot, identity and dry-run isolation', async () => {
  const body = payload(); body.items=structuredClone(body.decision_snapshot); delete body.decision_group;
  const explicit = normalizeBatchDispatchIngest(body,{splitCards:true});
  body.decision_group='unified'; const original=structuredClone(body);
  const n=normalizeBatchDispatchIngest(body,{splitCards:true});
  assert.deepEqual(n.fieldsList.map((i)=>i.decisionGroup),['without_1005004','contains_1005004','without_1005004']);
  assert.deepEqual(n.qianchuanSnapshot,explicit.qianchuanSnapshot);
  assert.deepEqual(n.fieldsList.map(dispatchIdempotencyValue),explicit.fieldsList.map(dispatchIdempotencyValue));
  assert.equal((await invoke(body)).status,202);
  const dry=await invoke(body,{dryRun:true}); assert.equal(dry.status,200); assert.deepEqual(dry.calls,[]);
  assert.deepEqual(body,original);
});

test('legacy unified does not bypass source, hash, item bucket or policy conflicts', async () => {
  const body = payload(); body.decision_group = 'unified';
  const dry = await invoke(body,{dryRun:true}); assert.equal(dry.status,200); assert.deepEqual(dry.calls,[]);
  const drift = structuredClone(body); drift.source_batch_id = 'wrong-source';
  const mismatch = await invoke(drift);
  assert.equal(mismatch.body.error_code,'QIANCHUAN_BATCH_ITEM_CONFLICT'); assert.deepEqual(mismatch.calls,[]);
  const invalidHash = structuredClone(body); invalidHash.decision_snapshot_hash='0'.repeat(64);
  const hash = await invoke(invalidHash);
  assert.equal(hash.body.error_code,'QIANCHUAN_SNAPSHOT_HASH_MISMATCH'); assert.deepEqual(hash.calls,[]);
  const invalidBucket=structuredClone(body); invalidBucket.items[0].decision_group='unified';
  const bucket=await invoke(invalidBucket); assert.equal(bucket.body.error_code,'QIANCHUAN_INVALID_DELIVERY_GROUP'); assert.deepEqual(bucket.calls,[]);
  const policy=structuredClone(body); policy.decision_policy_version='code-membership-1000676/v2';
  const version=await invoke(policy); assert.equal(version.body.error_code,'QIANCHUAN_BATCH_ITEM_CONFLICT'); assert.deepEqual(version.calls,[]);
});

test('1000676/v2 cannot use legacy unified envelope', async () => {
  const body = payload(); body.decision_group='unified';
  const upgrade = (row) => {
    row.reject_reason_codes=row.reject_reason_codes.map((c)=>c==='1005004'?'1000676':c);
    row.contains_code_1000676=row.contains_code_1005004; delete row.contains_code_1005004;
    row.decision_group=row.contains_code_1000676?'contains_1000676':'without_1000676';
    row.decision_policy_version='code-membership-1000676/v2';
  };
  body.decision_snapshot.forEach(upgrade);
  body.items=structuredClone([body.decision_snapshot[1]]);
  body.decision_policy_version='code-membership-1000676/v2';
  body.decision_snapshot_hash=decisionSnapshotHash(body.decision_snapshot);
  const result=await invoke(body);
  assert.equal(result.body.error_code,'QIANCHUAN_BATCH_ITEM_CONFLICT'); assert.deepEqual(result.calls,[]);
  body.items=structuredClone(body.decision_snapshot);
  for (const group of ['contains_1000676',undefined]) {
    if (group === undefined) delete body.decision_group; else body.decision_group=group;
    const mixed=await invoke(body);
    assert.equal(mixed.status,400);
    assert.equal(mixed.body.error_code,'QIANCHUAN_BATCH_ITEM_CONFLICT'); assert.deepEqual(mixed.calls,[]);
  }
  delete body.decision_policy_version;
  const itemOnly=await invoke(body);
  assert.equal(itemOnly.status,400); assert.equal(itemOnly.body.error_code,'QIANCHUAN_BATCH_ITEM_CONFLICT');
  assert.deepEqual(itemOnly.calls,[]);
  body.items=[structuredClone(body.decision_snapshot[1])];
  const homogeneous=await invoke(body,{dryRun:true});
  assert.equal(homogeneous.status,200); assert.deepEqual(homogeneous.calls,[]);
});

test('mixed v1/v2 items without envelope policy/group preserve mixed-policy error precedence', async () => {
  const body=payload();
  delete body.decision_policy_version; delete body.decision_group;
  const current=structuredClone(body.decision_snapshot[1]);
  current.decision_policy_version='code-membership-1000676/v2';
  current.reject_reason_codes=['1000676']; current.contains_code_1000676=true;
  delete current.contains_code_1005004; current.decision_group='contains_1000676';
  for (const items of [[body.decision_snapshot[0],current],[current,body.decision_snapshot[0]]]) {
    body.items=structuredClone(items);
    const original=structuredClone(body);
    const result=await invoke(body);
    assert.equal(result.status,400);
    assert.equal(result.body.error_code,'QIANCHUAN_MIXED_SOURCE_POLICY');
    assert.deepEqual(result.calls,[]); assert.deepEqual(body,original);
  }
});
test('unknown bucket, even if root and item agree, is rejected before handoff', async () => {
  const body = payload(); body.decision_group='other'; body.items[0].decision_group='other';
  const result = await invoke(body); assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'QIANCHUAN_INVALID_DELIVERY_GROUP'); assert.deepEqual(result.calls, []);
});
test('missing migration interface and conflicting source never fall back to ordinary dispatch', async () => {
  const missing = await invoke(payload(), { missingSource: true });
  assert.equal(missing.body.error_code, 'QIANCHUAN_STORE_REQUIRED'); assert.deepEqual(missing.calls, []);
  const conflict = await invoke(payload(), { sourceError: 'QIANCHUAN_SOURCE_CONFLICT' });
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.calls, ['source']);
});
test('source RPC missing returns a configuration error without REST/CAS/legacy fallback', async () => {
  const calls = [];
  const store = createSupabaseDispatchStore({ url: 'https://isolated.example.supabase.co', serviceRoleKey: 'mock-key', logger: {},
    fetchImpl: async (url) => { calls.push(url); return { ok: false, status: 404,
      text: async () => JSON.stringify({ code: 'PGRST202', message: 'missing function' }) }; } });
  await assert.rejects(store.registerQianchuanSource({ scope: 'test_default', dayKey: '2026-10-26', snapshot: {} }),
    { code: 'QIANCHUAN_MIGRATION_REQUIRED', status: 503 });
  assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/rpc/bess_register_qianchuan_source'));
});
test('PostgREST source read, group assignment and receipt RPC keep scope, identity and fencing', async () => {
  const calls = []; const results = [[{ day_key: '2026-10-26', manifest: { snapshotHash: 'hash' },
    group_plan: {}, pending_request_ids: ['r'], confirmed_request_ids: [] }], [{ request_id: 'r', assignee: 'A' }], { confirmed: true }];
  const store = createSupabaseDispatchStore({ url: 'https://isolated.example.supabase.co', serviceRoleKey: 'mock-key', logger: {},
    fetchImpl: async (url, options) => { calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, text: async () => JSON.stringify(results.shift()) }; } });
  const source = await store.getQianchuanSource({ scope: 'test_default', sourceBatchId: 'original_source' });
  assert.equal(source.dayKey, '2026-10-26'); assert.deepEqual(source.pendingIds, ['r']);
  const ownership = { dayKey: '2026-10-26', scope: 'test_default', chatId: 'mock_chat', batchId: 'mock_delivery', claimToken: 'mock_fence' };
  await store.assignQianchuanBatch({ ...ownership, items: [{ requestId: 'r' }], observations: [], expectedVersion: 2, expectedCursorVersion: 3 });
  await store.confirmQianchuanWrites({ ...ownership, sourceBatchId: 'original_source', manifestHash: 'hash', receipts: [{ requestId: 'r', assignee: 'A' }] });
  assert.equal(calls[1].body.p_claim_token, 'mock_fence'); assert.equal(calls[2].body.p_claim_token, 'mock_fence');
  assert.equal(calls[1].body.p_form_message_id, calls[2].body.p_form_message_id);
  assert.equal(calls[1].body.p_expected_cursor_version, 3); assert.equal(calls[2].body.p_manifest_hash, 'hash');
  assert.ok(calls[0].url.includes('scope=eq.test_default'));
});
