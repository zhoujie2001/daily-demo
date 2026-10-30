import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decisionSnapshotHash } from '../lib/dispatch/qianchuan-policy.js';
import { normalizeBatchDispatchIngest } from '../lib/dispatch/ingest.js';
import { TEST_DISPATCH_CHAT_ID } from '../lib/dispatch/profile.js';
import { reviewQianchuanPayload } from '../tools/qianchuan-payload-acceptance.mjs';

const complete = JSON.parse(await readFile(new URL('./fixtures/qianchuan-isolated-4.complete-targets.json', import.meta.url), 'utf8'));
const keys = ['request_id','audit_object_id','reject_reason_codes','contains_code_1005004',
  'decision_group','decision_policy_version','source_batch_id'];
function originalShape() {
  const original = structuredClone(complete);
  delete original.diagnostic_note;
  for (const payload of original.dispatch_payloads) {
    payload.decision_snapshot = payload.decision_snapshot.map((m) => Object.fromEntries(keys.map((key) => [key,m[key]])));
    payload.decision_snapshot_hash = decisionSnapshotHash(payload.decision_snapshot);
  }
  return original;
}

test('provided 4-item minimal snapshot: exact supplied hash passes but both payloads lack full target contract', async () => {
  const report = await reviewQianchuanPayload(originalShape());
  assert.equal(report.original.snapshot_hash, '6b2bdfb445c543d290f3fb3266d6d94ad1f71a7e4803965df171c980f3f154a4');
  assert.equal(report.original.hashes_match, true); assert.equal(report.original.same_snapshot, true);
  assert.equal(report.original.contract_passed, false);
  assert.deepEqual(report.original.original_order, ['QC-T001','QC-T002','QC-T003','QC-T004']);
  assert.ok(report.original.normalizations.every((r) => r.ok===false && r.error_code==='INVALID_REQUEST_NAME'));
});

test('diagnostically completed copy: both bucket orders produce A/A/A/B; replay and rehashed drift stay safe', async () => {
  const report = await reviewQianchuanPayload(originalShape(), { diagnosticCompleteTargets:true });
  assert.equal(report.original_file_modified, false);
  assert.equal(report.corrected.explicitly_modified_fixture, true);
  assert.equal(report.corrected.snapshot_hash, 'de0037d086b419d5dbe984f1c1f68d7e76a2dd18553e4dbfc84dee5a13253d9d');
  for (const result of report.corrected.engine_checks) {
    assert.deepEqual(result.assignees, { 'QC-T001':'A','QC-T002':'A','QC-T003':'A','QC-T004':'B' });
    assert.equal(result.cursor_turns, 2); assert.equal(result.assignment_count, 4);
    assert.deepEqual(result.batch_write_sizes, [2,2]); assert.equal(result.replay_extra_writes, 0);
    assert.equal(result.rehashed_source_drift_rejected, true);
  }
});

test('provided substring trap and long IDs survive completed payload normalization and source snapshot persistence', () => {
  for (const payload of complete.dispatch_payloads) {
    const n = normalizeBatchDispatchIngest({ ...payload, chat_id:TEST_DISPATCH_CHAT_ID }, { splitCards:true });
    assert.equal(n.qianchuanSnapshot.sourceSnapshot[1].reject_reason_codes.includes('1005004'), false);
    assert.ok(n.qianchuanSnapshot.sourceSnapshot[1].reject_reason_codes.includes('10050040'));
    assert.equal(n.qianchuanSnapshot.members[0].auditObjectId, '922337203685477580812345');
    assert.equal(n.qianchuanSnapshot.members[0].assignmentGroup, n.qianchuanSnapshot.members[2].assignmentGroup);
    const item = n.fieldsList.find((m) => m.requestId==='QC-T002');
    if (item) assert.equal(item.containsCode1005004, false);
  }
});
