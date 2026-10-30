import { assertQianchuanCard, policyError } from './qianchuan-policy.js';

// Plan the COMPLETE source once; perform remote writes for this card only.
// An uncertain PUT/receipt leaves a durable pending boundary blocking other cards.
export async function executeQianchuanCard({ items, store, client, dayKey, scope,
  chatId, batchId, claimToken, inspect, current }) {
  assertQianchuanCard(items);
  if (['getQianchuanSource', 'assignQianchuanBatch', 'confirmQianchuanWrites', 'getDispatchSnapshot']
    .some((method) => typeof store[method] !== 'function')
      || ['readDispatchSheetSnapshot', 'readDispatchTargets', 'writeSheetValuesBatch']
        .some((method) => typeof client[method] !== 'function')) throw policyError('QIANCHUAN_STORE_REQUIRED');
  const first = items[0];
  const source = await store.getQianchuanSource({ scope, sourceBatchId: first.sourceBatchId });
  if (!source || source.dayKey !== dayKey || source.snapshot.snapshotHash !== first.decisionManifestHash
      || source.snapshot.upstreamSnapshotHash !== first.decisionSnapshotHash) throw policyError('QIANCHUAN_SOURCE_CONFLICT');
  const rootItems = source.snapshot.members.map((member) => ({ ...member, requestName: member.requestId,
    businessType: first.businessType, targetCategory: 'qianchuan', dispatchScope: scope,
    dispatchProfile: first.dispatchProfile, dispatchDirection: 'forward' }));
  const [database, snapshot] = await Promise.all([
    store.getDispatchSnapshot(dayKey, scope, current), client.readDispatchSheetSnapshot({ items: rootItems }),
  ]);
  if (!database?.state || !Array.isArray(database.assignments)) throw policyError('QIANCHUAN_SNAPSHOT_UNAVAILABLE');
  const reads = [];
  for (const fields of rootItems) reads.push(await inspect({ client, fields, dayKey,
    roster: database.state.roster, store, state: database.state, persisted: database.assignments, sheetSnapshot: snapshot }));
  const observations = reads.map((read, index) => ({ requestId: rootItems[index].requestId,
    rowIndex: read.resolvedRowIndex, assignee: String(read.valueAtTargetRow || '').trim() }));
  const resolved = items.map((item) => ({ ...item,
    rowIndex: observations.find((row) => row.requestId === item.requestId)?.rowIndex }));
  const ownership = { chatId, batchId, claimToken, dayKey, scope };
  const assignments = await store.assignQianchuanBatch({ ...ownership, items: resolved,
    observations, anchorAssignee: !source.groupPlan && reads[0]?.calibrationRequired ? reads[0].anchor || '' : '',
    expectedVersion: database.state.version, expectedCursorVersion: database.state.forward_version });
  if (!Array.isArray(assignments) || assignments.length !== items.length
      || assignments.some((row, i) => row.request_id !== items[i].requestId
        || !database.state.roster.includes(row.assignee)
        || row.assignment_group !== source.snapshot.members[items[i].sourcePosition].assignmentGroup)) {
    throw policyError('QIANCHUAN_ASSIGNMENT_RESPONSE_INVALID');
  }
  const beforeWrite = await client.readDispatchTargets({ snapshot, items: resolved });
  if (beforeWrite.length !== items.length || beforeWrite.some((row, i) => row.requestId !== items[i].requestId
      || (row.assignee && row.assignee !== assignments[i].assignee))) throw policyError('SHEET_TARGET_CHANGED');
  if (beforeWrite.some((row) => !row.assignee && source.confirmedIds.includes(row.requestId))) {
    throw policyError('SHEET_ASSIGNMENT_MISMATCH', '已确认需求的负责人被清空，须人工对账，不得自动覆盖');
  }
  const valueRanges = resolved.flatMap((item, i) => beforeWrite[i].assignee ? [] : [{
    range: `${item.sheetId}!${snapshot.assigneeColumn}${item.rowIndex}:${snapshot.assigneeColumn}${item.rowIndex}`,
    values: [[assignments[i].assignee]],
  }]);
  // A lost write response is NOT a second write permission. One authoritative
  // readback can confirm it; otherwise pending remains for reconciliation.
  let writeError;
  if (valueRanges.length) {
    try { await client.writeSheetValuesBatch({ sheetUrl: first.sheetUrl, valueRanges, spreadsheetToken: snapshot.spreadsheetToken }); }
    catch (error) { writeError = error; }
  }
  const receipts = await client.readDispatchTargets({ snapshot, items: resolved });
  if (receipts.length !== items.length || receipts.some((row, i) => row.requestId !== items[i].requestId
      || row.assignee !== assignments[i].assignee)) throw writeError || policyError('QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
  const confirmation = await store.confirmQianchuanWrites({ ...ownership, sourceBatchId: first.sourceBatchId,
    manifestHash: first.decisionManifestHash, receipts });
  if (confirmation?.confirmed !== true) throw policyError('QIANCHUAN_RECEIPT_RESPONSE_INVALID');
  return assignments.map((assigned, index) => ({ requestId: items[index].requestId,
    requestName: items[index].requestName, businessType: items[index].businessType,
    status: 'SUCCESS', assignee: assigned.assignee, assignmentSeq: assigned.assignment_seq,
    cursorVersion: assigned.forward_version, replayed: assigned.replayed,
    source: assigned.replayed ? 'replay' : 'qianchuan_group', assignmentGroup: assigned.assignment_group }));
}
