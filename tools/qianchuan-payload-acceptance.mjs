// Local contract/engine acceptance only. All sheet operations are in memory.
// Never sends HTTP, reads credentials, modifies the supplied file or production.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decisionSnapshotHash, expectedDecisionGroups, registerQianchuanSource, stableJson } from '../lib/dispatch/qianchuan-policy.js';
import { normalizeBatchDispatchIngest, batchDispatchActionValue } from '../lib/dispatch/ingest.js';
import { validateBatchDispatchValue } from '../lib/lark/card-actions.js';
import { TEST_DISPATCH_CHAT_ID } from '../lib/dispatch/profile.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { executeQianchuanCard } from '../lib/dispatch/qianchuan-executor.js';

const CURRENT = new Date('2026-10-26T08:00:00Z');
function normalizeForTest(payload) {
  // Test-environment substitution only; chat_id is NOT part of the source snapshot.
  return normalizeBatchDispatchIngest({ ...payload, chat_id: TEST_DISPATCH_CHAT_ID }, { splitCards: true });
}

export function completeSnapshotTargets(document) {
  const fixed = structuredClone(document);
  const all = new Map();
  for (const payload of fixed.dispatch_payloads) for (const item of payload.items) {
    if (all.has(item.request_id)) assert.equal(stableJson(all.get(item.request_id)), stableJson(item), 'conflicting duplicate target');
    all.set(item.request_id, item);
  }
  const original = fixed.dispatch_payloads[0].decision_snapshot;
  const complete = original.map((member) => {
    const item = all.get(member.request_id);
    assert.ok(item, `missing target for ${member.request_id}`);
    for (const [key, value] of Object.entries(member)) assert.equal(stableJson(item[key]), stableJson(value), `snapshot/item mismatch: ${key}`);
    return { ...item, ...member };
  });
  const hash = decisionSnapshotHash(complete);
  for (const payload of fixed.dispatch_payloads) {
    assert.equal(stableJson(payload.decision_snapshot), stableJson(original));
    payload.decision_snapshot = structuredClone(complete);
    payload.decision_snapshot_hash = hash;
  }
  fixed.diagnostic_note = 'DIAGNOSTIC CORRECTED COPY: complete target fields merged from both delivery items; original file unchanged; not proof that the original payload passed.';
  return fixed;
}

async function runOrder(document, order) {
  const normalized = document.dispatch_payloads.map(normalizeForTest);
  const store = createMemoryBatchStore({ now: () => CURRENT });
  const dayKey = '2026-10-26'; const scope = 'test_default';
  await store.initializeRoster({ dayKey, scope, roster: ['A','B','C'], expiresAt: '2026-10-26T16:00:00Z' });
  for (const n of normalized) await registerQianchuanSource(store, n, CURRENT);
  const members = normalized[0].qianchuanSnapshot.members;
  const cells = new Map(members.map((m) => [m.rowIndex, { requestId: m.requestId, assignee: '' }]));
  const writes = [];
  store.getDispatchSnapshot = async () => {
    const state = await store.getDailyState(dayKey, scope);
    return { state, assignments: Object.entries(state.assignments || {}).map(([request_id, assignment]) => ({
      ...assignment, request_id, request_context: assignment.context })) };
  };
  const client = {
    readDispatchSheetSnapshot: async () => ({ assigneeColumn: members[0].assigneeFieldId, spreadsheetToken: 'mock_only' }),
    readDispatchTargets: async ({ items }) => items.map((item) => ({ rowIndex: item.rowIndex, ...cells.get(item.rowIndex) })),
    writeSheetValuesBatch: async ({ valueRanges }) => {
      writes.push(valueRanges.length);
      for (const entry of valueRanges) {
        const row = Number(entry.range.match(/![A-Z]+(\d+):/)[1]);
        assert.ok(cells.has(row)); assert.equal(cells.get(row).assignee, '', 'must not overwrite');
        cells.get(row).assignee = entry.values[0][0];
      }
    },
  };
  const execute = async (index) => {
    const n = normalized[index];
    const action = batchDispatchActionValue(n.batchId, n.fieldsList);
    const { items } = validateBatchDispatchValue(action, { chatId: TEST_DISPATCH_CHAT_ID });
    const claimToken = randomUUID();
    const ownership = { chatId: TEST_DISPATCH_CHAT_ID, batchId: n.batchId, claimToken };
    const claim = await store.claimBatch({ ...ownership, fingerprint: stableJson(items), items,
      originalMessageId: `mock_card_${index}`, leaseExpiresAt: new Date(CURRENT.getTime()+300000).toISOString(),
      expiresAt: '2026-10-26T16:00:00Z' });
    assert.ok(['CLAIMED','RESUMED'].includes(claim.outcome));
    const results = await executeQianchuanCard({ ...ownership, items, store, client, dayKey, scope, current: CURRENT,
      inspect: async ({ fields }) => {
        const match = [...cells].find(([, value]) => value.requestId === fields.requestId);
        assert.ok(match);
        return { resolvedRowIndex: match[0], valueAtTargetRow: match[1].assignee, calibrationRequired: false };
      } });
    await store.releaseBatchClaim({ ...ownership, releasedAt: CURRENT });
    return results;
  };
  const results = [];
  for (const index of order) results.push(...await execute(index));
  const before = await store.getDailyState(dayKey, scope);
  const beforeWrites = writes.length;
  await execute(order[0]);
  const after = await store.getDailyState(dayKey, scope);
  assert.equal(after.forward_cursor, before.forward_cursor, 'replay consumed cursor');
  assert.equal(after.assignment_seq, before.assignment_seq, 'replay created assignment');
  assert.equal(writes.length, beforeWrites, 'replay caused PUT');
  const changed = structuredClone(document.dispatch_payloads[0]);
  changed.decision_snapshot[0].request_name += '_changed';
  const changedId = changed.decision_snapshot[0].request_id;
  for (const item of changed.items) if (item.request_id === changedId) item.request_name += '_changed';
  changed.decision_snapshot_hash = decisionSnapshotHash(changed.decision_snapshot);
  await assert.rejects(registerQianchuanSource(store, normalizeForTest(changed), CURRENT), { code: 'QIANCHUAN_SOURCE_CONFLICT' });
  return { order: order.map((i) => document.dispatch_payloads[i].decision_group),
    assignees: Object.fromEntries(members.map((m) => [m.requestId, cells.get(m.rowIndex).assignee])),
    cursor_turns: after.forward_cursor, assignment_count: after.assignment_seq,
    batch_write_sizes: writes, replay_extra_writes: writes.length-beforeWrites,
    rehashed_source_drift_rejected: true, results_count: results.length };
}

export async function reviewQianchuanPayload(document, { diagnosticCompleteTargets = false } = {}) {
  const payloads = document.dispatch_payloads;
  assert.ok(Array.isArray(payloads) && payloads.length===2, 'this acceptance requires two isolated deliveries');
  const source = payloads[0].decision_snapshot;
  const report = { environment: 'local_memory_only_no_network', original_file_modified: false,
    chat_id_substituted_for_test_only: true,
    original: { same_snapshot: stableJson(source)===stableJson(payloads[1].decision_snapshot),
      snapshot_hash: decisionSnapshotHash(source), hashes_match: payloads.every((p) => decisionSnapshotHash(p.decision_snapshot)===p.decision_snapshot_hash),
      original_order: source.map((m) => m.request_id), object_ids_are_strings: payloads.every((p) => p.items.every((i) => typeof i.audit_object_id==='string')),
      expected_groups: expectedDecisionGroups(source.map((m) => ({ auditObjectId:m.audit_object_id, containsCode1005004:m.reject_reason_codes.includes('1005004') }))),
      normalizations: payloads.map((p) => {
        try { normalizeForTest(p); return { batch_id:p.batch_id, ok:true }; }
        catch (error) { return { batch_id:p.batch_id, ok:false, error_code:error.code, message:error.message }; }
      }) } };
  report.original.contract_passed = report.original.same_snapshot && report.original.hashes_match
    && report.original.object_ids_are_strings && report.original.normalizations.every((result) => result.ok);
  if (diagnosticCompleteTargets) {
    const fixed = completeSnapshotTargets(document);
    const forward = await runOrder(fixed,[0,1]);
    const reverse = await runOrder(fixed,[1,0]);
    assert.deepEqual(forward.assignees,reverse.assignees);
    report.corrected = { explicitly_modified_fixture: true, snapshot_hash:fixed.dispatch_payloads[0].decision_snapshot_hash,
      engine_checks:[forward,reverse] };
    report.corrected_fixture = fixed;
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  const filename = process.argv[2];
  if (!filename) throw new Error('usage: node tools/qianchuan-payload-acceptance.mjs <isolated-json> [--diagnostic-complete-targets]');
  const document = JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
  const report = await reviewQianchuanPayload(document, { diagnosticCompleteTargets:process.argv.includes('--diagnostic-complete-targets') });
  console.log(JSON.stringify(report));
  // A successful diagnostic repair is never an acceptance of the original file.
  process.exitCode = report.original.contract_passed ? 0 : 2;
}
