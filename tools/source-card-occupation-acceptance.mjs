// Shared real-SQL regression cases: runs against PGlite and isolated PostgreSQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sourceCardFixture } from '../tests/fixtures/source-card-manifest.js';
import { normalizeBatchDispatchIngest } from '../lib/dispatch/ingest.js';
import { buildDispatchCardChunkPlans, dispatchRootReservation } from '../lib/dispatch/card-chunks.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { batchDispatchActionValue, dispatchActionValue } from '../lib/dispatch/ingest.js';
import { validateBatchDispatchValue } from '../lib/lark/card-actions.js';

export function occupationFixture(source, legacy = false) {
  const body = sourceCardFixture(21, source).deliveries[0];
  if (legacy) { delete body.source_card_manifest; delete body.source_card_chunk_index; }
  const normalized = normalizeBatchDispatchIngest(body, { splitCards: true });
  const plans = buildDispatchCardChunkPlans(normalized);
  const root = { ...dispatchRootReservation(normalized, plans),
    now: '2026-11-08T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z' };
  const digest = createHash('sha256').update(`${root.chatId}:${root.batchId}`).digest('hex').slice(0, 48);
  return { normalized, root, plan: plans[0], digest };
}
export const reserve = (db, f) => db.query('select * from public.bess_reserve_dispatch_ingest_root($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [`br_${f.digest}`, `ingest_root_${f.digest}`, f.root.chatId, f.root.batchId, f.root.fingerprint,
    JSON.stringify(f.root.requestIds), JSON.stringify(f.root.chunkPlan), f.root.expiresAt, f.root.now]);
export const register = (db, f) => db.query('select public.bess_register_source_card_manifest($1,$2)',
  [f.normalized.sourceCardManifest, f.root]);
export const handoff = (db, f) => db.query('select * from public.bess_register_dispatch_handoff($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
  [`bi_${f.digest}`, `ingest_${f.digest}`, f.root.chatId, f.root.batchId, f.plan.fingerprint,
    JSON.stringify(f.plan.requestIds), f.plan.operationId, f.plan.card, f.plan.queueMessage, 'isolated-test', f.root.expiresAt, f.root.now]);
export const enqueue = (db, f) => db.query('select * from public.bess_enqueue_dispatch_outbox($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  [`bi_${f.digest}`, `ingest_${f.digest}`, f.root.chatId, f.root.batchId, f.plan.fingerprint,
    JSON.stringify(f.plan.requestIds), f.plan.operationId, f.plan.card, 'isolated-test', f.root.now, f.root.expiresAt]);

export async function occupationAcceptance(db) {
  let checks = 0;
  const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const fails = async (fn) => { await assert.rejects(fn, /SOURCE_CARD_BINDING_CONFLICT/); checks++; };
  const old = occupationFixture('occupied_old', true), next = occupationFixture('occupied_old');
  eq((await reserve(db, old)).rows[0].outcome, 'ACCEPTED', 'real legacy reserve first');
  eq((await handoff(db, old)).rows[0].outcome, 'ACCEPTED', 'real legacy accepted handoff');
  await fails(() => register(db, next));
  eq((await db.query('select count(*)::int n from public.bess_source_card_chunks where source_batch_id=$1', ['occupied_old'])).rows[0].n, 0, 'no permanent chunks on rejection');
  eq((await db.query('select count(*)::int n from public.bess_source_card_manifests where source_batch_id=$1', ['occupied_old'])).rows[0].n, 0, 'no permanent source on rejection');
  eq((await reserve(db, old)).rows[0].outcome, 'REUSED', 'old root recovery');
  eq((await handoff(db, old)).rows[0].outcome, 'REUSED', 'old accepted handoff recovery');
  eq((await enqueue(db, old)).rows[0].outcome, 'ACCEPTED', 'old outbox recovery');
  await db.query('select public.bess_assert_legacy_source_card_batch($1)', [old.root.batchId]); checks++;

  const fresh = occupationFixture('occupied_new');
  await register(db, fresh); checks++;
  eq((await reserve(db, fresh)).rows[0].outcome, 'REUSED', 'source registration reserves real root atomically');
  await handoff(db, fresh); checks++;
  eq((await enqueue(db, fresh)).rows[0].outcome, 'ACCEPTED', 'source outbox ON CONFLICT insert guard recovery');
  await fails(() => reserve(db, occupationFixture('occupied_new', true)));
  await fails(() => handoff(db, occupationFixture('occupied_new', true)));
  await register(db, fresh); checks++;
  const drift = structuredClone(fresh); drift.root.fingerprint = '0'.repeat(64);
  drift.root.chunkPlan[0].fingerprint = drift.root.fingerprint;
  await fails(() => register(db, drift));
  eq((await reserve(db, fresh)).rows[0].outcome, 'REUSED', 'fingerprint drift rolls back all mutation');

  // A genuine older AD game message for the SAME request, but a different batch.
  const history = occupationFixture('historical_card', true);
  await handoff(db, history); checks++;
  await db.query("update public.bess_dispatch_pending_forms set original_message_id='om_proven_history', request_context=request_context||'{\"messageId\":\"om_proven_history\"}'::jsonb where form_message_id=$1", [`bi_${history.digest}`]);
  const memberSource = occupationFixture('members_new');
  await register(db, memberSource); checks++;
  const member = [{ request_id: memberSource.root.requestIds[0], dispatch_profile: 'ad', target_category: 'game_agent' }];
  const guard = (chat, items, msg) => db.query('select public.bess_assert_legacy_source_card_members($1,$2,$3)', [chat, JSON.stringify(items), msg]);
  await fails(() => guard(memberSource.root.chatId, member, null));
  await fails(() => guard(memberSource.root.chatId, member, 'om_source_stripped'));
  await guard(memberSource.root.chatId, member, 'om_proven_history'); checks++;
  await guard('oc_other_chat', member, null); checks++;
  await guard(memberSource.root.chatId, [{ ...member[0], dispatch_profile: 'test_default' }], null); checks++;
  await guard(memberSource.root.chatId, [{ ...member[0], target_category: 'ad' }], null); checks++;
  await guard(memberSource.root.chatId, [{ ...member[0], request_id: 'genuine_legacy_only' }], null); checks++;
  await db.query('delete from public.bess_dispatch_pending_forms where form_message_id=$1', [`bi_${history.digest}`]);
  await guard(memberSource.root.chatId, member, 'om_proven_history'); checks++;
  // Run real JS callbacks against the actual SQL member guard + durable pending.
  // Only Lark/sheet/roster/assignment side effects are synthetic, never production.
  const callback = (value, messageId, formValue) => ({ event: {
    operator: { open_id: 'ou_isolated' }, action: { value, ...(formValue ? { form_value: formValue } : {}) },
    context: { open_chat_id: history.root.chatId, open_message_id: messageId },
  } });
  const origins = []; let writes = 0, currentAssignee = '', completedUpdates = 0, failCalibration = true;
  let claimOutcome = 'IN_FLIGHT';
  const store = {
    assertLegacySourceCardBatch: ({ batchId }) => db.query('select public.bess_assert_legacy_source_card_batch($1)', [batchId]),
    assertLegacySourceCardMembers: async ({ chatId, messageId, items }) => {
      origins.push(messageId);
      try { await guard(chatId, items.map((f) => ({ request_id: f.requestId, dispatch_profile: f.dispatchProfile, target_category: f.targetCategory })), messageId); }
      catch (error) { error.code = 'SOURCE_CARD_BINDING_CONFLICT'; throw error; }
    },
    getDailyState: async () => ({ roster: ['synthetic'], off_duty: [] }),
    getAssignment: async () => null,
    cleanupExpired: async () => {},
    savePending: (p) => db.query('insert into public.bess_dispatch_pending_forms(form_message_id,request_id,original_message_id,chat_id,request_context,expires_at) values($1,$2,$3,$4,$5,$6)',
      [p.form_message_id,p.request_id,p.original_message_id,p.chat_id,p.request_context,p.expires_at]),
    getPending: async (id) => (await db.query('select * from public.bess_dispatch_pending_forms where form_message_id=$1', [id])).rows[0],
    markPendingCompleted: async (id, at, ctx) => {
      completedUpdates++;
      await db.query('update public.bess_dispatch_pending_forms set completed_at=$2,request_context=$3 where form_message_id=$1', [id,at.toISOString(),ctx]);
    },
    assignSpecific: async ({ assignee }) => ({ assignee }),
    calibrateCursor: async () => { if (failCalibration) { failCalibration = false; throw new Error('isolated retry'); } },
    claimBatch: async () => ({ outcome: claimOutcome, status: 'PARTIAL', results: [{ requestId: history.root.requestIds[0], status: 'SUCCESS' }] }),
    saveBatchProgress() {}, markBatchFinalization() {}, saveBatchResultMessage() {}, releaseBatchClaim() {},
  };
  const client = { getSheetValues: async () => [[currentAssignee]],
    replyInteractiveCard: async () => ({ message_id: 'om_history_new_specify' }),
    writeSheetAssignee: async ({ assignee }) => { writes++; currentAssignee = assignee; },
    getMessage: async () => null };
  const opts = { store, client, now: () => new Date(history.root.now), logger: { log() {}, error() {} },
    config: { phase: 'p1', allowedChatIds: [history.root.chatId] } };
  const batchValue = batchDispatchActionValue(history.root.batchId, history.normalized.fieldsList);
  eq((await handleDispatchEvent(callback(batchValue, 'om_proven_history'), opts)).errorCode, 'BATCH_IN_FLIGHT', 'full historic batch callback SQL guard');
  claimOutcome = 'COMPLETE';
  const rosterPending = { form_message_id: 'om_history_roster_saved', request_id: `batch_${history.root.batchId}`,
    original_message_id: 'om_proven_history', chat_id: history.root.chatId, expires_at: history.root.expiresAt,
    request_context: { ...validateBatchDispatchValue(batchValue, { chatId: history.root.chatId }), kind: 'batch' } };
  await store.savePending(rosterPending);
  await fails(() => guard(history.root.chatId, member, rosterPending.form_message_id));
  eq((await handleDispatchEvent(callback(batchValue, rosterPending.form_message_id), opts)).errorCode, 'BATCH_ALREADY_PROCESSED', 'roster-saved callback recovers exact durable context');
  eq(origins.slice(-2), [rosterPending.form_message_id,'om_proven_history'], 'new roster card uses proven pending origin only');
  const driftedValue = structuredClone(batchValue); driftedValue.items[0].row_index++;
  eq((await handleDispatchEvent(callback(driftedValue, rosterPending.form_message_id), opts)).errorCode, 'SOURCE_CARD_BINDING_CONFLICT', 'pending context drift cannot borrow provenance');
  await db.query('delete from public.bess_dispatch_pending_forms where form_message_id=$1', [rosterPending.form_message_id]);
  eq((await handleDispatchEvent(callback(batchValue, 'om_proven_history'), opts)).errorCode, 'BATCH_ALREADY_PROCESSED', 'partial progress/replay retains origin');
  eq((await handleDispatchEvent(callback(batchValue, 'om_source_stripped'), opts)).errorCode, 'SOURCE_CARD_BINDING_CONFLICT', 'unknown historic message rejected at callback');
  const specifyValue = { ...dispatchActionValue(history.normalized.fieldsList[0]), action: 'bess_specify_assignee' };
  eq((await handleDispatchEvent(callback(specifyValue, 'om_proven_history'), opts)).errorCode, undefined, 'old card opens new specify form after source registration');
  const saved = await store.getPending('om_history_new_specify');
  eq(saved.original_message_id, 'om_proven_history', 'durable pending origin');
  await fails(() => guard(history.root.chatId, member, saved.form_message_id));
  const submit = callback({ original_message_id: 'om_attacker' }, saved.form_message_id,
    { assignee_name: 'synthetic', original_message_id: 'om_attacker' });
  eq((await handleDispatchEvent(submit, opts)).body.toast.type, 'error', 'calibration failure remains retryable');
  eq((await store.getPending(saved.form_message_id)).completed_at, null, 'failure does not complete pending');
  eq((await handleDispatchEvent(submit, opts)).errorCode, undefined, 'new form submit uses original SQL provenance');
  eq((await handleDispatchEvent(submit, opts)).errorCode, 'ALREADY_SPECIFIED', 'completed replay uses original SQL provenance');
  eq(writes, 1, 'retry/replay does not duplicate sheet write');
  eq(completedUpdates, 1, 'complete exactly once');
  eq(origins.slice(-3), ['om_proven_history','om_proven_history','om_proven_history'], 'submit never trusts form/action override');
  await db.query('update public.bess_dispatch_pending_forms set original_message_id=$2 where form_message_id=$1', [saved.form_message_id,'om_source_stripped']);
  eq((await handleDispatchEvent(submit, opts)).errorCode, 'SOURCE_CARD_BINDING_CONFLICT', 'even completed replay rejects unproven pending origin');
  // Remove deliberately corrupted trusted test row before later source freezes.
  await db.query('delete from public.bess_dispatch_pending_forms where form_message_id=$1', [saved.form_message_id]);
  const rootCollision = occupationFixture('atomic_root_collision');
  const corruptOld = structuredClone(rootCollision); corruptOld.root.batchId = 'legacy_wrong_context';
  await reserve(db, corruptOld); checks++;
  await fails(() => register(db, rootCollision));
  eq((await db.query('select count(*)::int n from public.bess_source_card_manifests where source_batch_id=$1', ['atomic_root_collision'])).rows[0].n, 0, 'root CAS conflict rolls back source even when context batch differs');
  eq((await db.query('select count(*)::int n from public.bess_source_card_chunks where source_batch_id=$1', ['atomic_root_collision'])).rows[0].n, 0, 'root CAS conflict rolls back all chunks');

  const lateLegacy = occupationFixture('late_old_outbox', true);
  await handoff(db, lateLegacy); checks++;
  await register(db, occupationFixture('late_new_source')); checks++;
  await fails(() => guard(memberSource.root.chatId, member, 'om_late_history'));
  await db.query("update public.bess_dispatch_pending_forms set original_message_id='om_late_history', request_context=request_context||'{\"messageId\":\"om_late_history\",\"status\":\"SENT\"}'::jsonb where form_message_id=$1", [`bi_${lateLegacy.digest}`]);
  await guard(memberSource.root.chatId, member, 'om_late_history'); checks++;
  await db.query('delete from public.bess_dispatch_pending_forms where form_message_id=$1', [`bi_${lateLegacy.digest}`]);
  await guard(memberSource.root.chatId, member, 'om_late_history'); checks++;
  for (const kind of ['batch_dispatch', 'batch']) {
    const oldClaim = occupationFixture(`claim_old_${kind}`, true);
    const insert = (formId, f, items) => db.query('insert into public.bess_dispatch_pending_forms(form_message_id,request_id,original_message_id,chat_id,request_context,expires_at) values($1,$1,$1,$2,$3,$4)',
      [formId, f.root.chatId, { kind, batchId: f.root.batchId, items }, f.root.expiresAt]);
    await insert(`om_claim_old_${kind}`, oldClaim, oldClaim.normalized.fieldsList); checks++;
    await fails(() => register(db, occupationFixture(`claim_old_${kind}`)));
    eq((await db.query('select count(*)::int n from public.bess_source_card_chunks where source_batch_id=$1', [`claim_old_${kind}`])).rows[0].n, 0, 'legacy persistent card claim blocks registration');
    const newClaim = occupationFixture(`claim_new_${kind}`);
    await register(db, newClaim);
    await insert(`om_claim_new_${kind}`, newClaim, newClaim.normalized.fieldsList); checks++;
    const stripped = newClaim.normalized.fieldsList.map(({ sourceCardBinding: _binding, ...item }) => item);
    await fails(() => db.query('update public.bess_dispatch_pending_forms set request_context=$1 where form_message_id=$2',
      [{ kind, batchId: newClaim.root.batchId, items: stripped }, `om_claim_new_${kind}`]));
  }
  return checks;
}
