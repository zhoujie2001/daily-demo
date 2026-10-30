// Ephemeral PGlite PostgreSQL/PLpgSQL execution. No production URLs/credentials.
// This is NOT a Supabase/PostgREST or multi-session concurrency acceptance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalizeBatchDispatchIngest } from '../lib/dispatch/ingest.js';
import { TEST_DISPATCH_CHAT_ID } from '../lib/dispatch/profile.js';
import { decisionSnapshotHash } from '../lib/dispatch/qianchuan-policy.js';

const modulePath = process.argv[2];
const { PGlite } = await import(modulePath ? pathToFileURL(modulePath).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
let inCase = false;
const check = (condition, detail) => { assert.ok(condition, detail); checks += 1; };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const fails = async (work, code) => {
  if (inCase) await db.exec('savepoint expected_error');
  try { await assert.rejects(work, (e) => e.message.includes(code)); checks += 1; }
  finally { if (inCase) await db.exec('rollback to savepoint expected_error; release savepoint expected_error'); }
};
try {
  await db.exec(await readFile(new URL('../tests/fixtures/qianchuan-sql-baseline.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261026075901_qianchuan_group_decisions.sql', import.meta.url), 'utf8'));
  const day = '2026-10-26';
  await db.query(`insert into public.bess_dispatch_daily_state(day_key,scope,roster,expires_at)
    values($1,'test_default','["A","B","C","D","E"]',clock_timestamp()+interval '1 day')`, [day]);
  const rows = ['a','b','c','b','d','e','f'].map((object, i) => ({ request_id: `r${i}`, request_name: `isolated ${i}`,
    business_type: '千川', target_category: 'qianchuan', sheet_url: 'https://example.feishu.cn/sheets/test',
    sheet_id: 'sheetA', row_index: i+10, assignee_field_id: 'N', date_field_id: 'A', request_field_id: 'X',
    audit_object_id: object, reject_reason_codes: [2,4,5].includes(i) ? ['1000676'] : [],
    contains_code_1000676: [2,4,5].includes(i), decision_group: [2,4,5].includes(i) ? 'contains_1000676' : 'without_1000676',
    source_batch_id: 'sql-source', decision_policy_version: 'code-membership-1000676/v2' }));
  const n = normalizeBatchDispatchIngest({ chat_id: TEST_DISPATCH_CHAT_ID, batch_id: 'sql_delivery', time_segment: 'D',
    decision_snapshot_hash: decisionSnapshotHash(rows), decision_snapshot: rows, items: rows }, { splitCards: true });
  await db.query('select public.bess_register_qianchuan_source($1,$2,$3)', ['test_default',day,n.qianchuanSnapshot]);
  await db.query('select public.bess_register_qianchuan_source($1,$2,$3)', ['test_default',day,n.qianchuanSnapshot]);
  check((await scalar('select count(*)::integer n from public.bess_qianchuan_sources')).n === 1, 'idempotent source registration');
  const changed = structuredClone(n.qianchuanSnapshot); changed.members.reverse();
  await fails(() => db.query('select public.bess_register_qianchuan_source($1,$2,$3)', ['test_default',day,changed]), 'QIANCHUAN_INVALID_MANIFEST');
  changed.members.reverse(); changed.policyVersion = 'changed';
  await fails(() => db.query('select public.bess_register_qianchuan_source($1,$2,$3)', ['test_default',day,changed]), 'QIANCHUAN_SOURCE_CONFLICT');
  const claims = new Map();
  const claim = async (id, items) => {
    const token = `token_${id}`; claims.set(id, { items, token });
    await db.query(`insert into public.bess_dispatch_pending_forms values($1,jsonb_build_object(
      'kind','batch_dispatch','status','PROCESSING','claimToken',$2::text,'leaseExpiresAt',clock_timestamp()+interval '10 minutes','items',$3::jsonb))`, [id,token,items]);
  };
  const second = n.fieldsList.filter((i) => i.containsCode1000676);
  const first = n.fieldsList.filter((i) => !i.containsCode1000676);
  await claim('second',second); await claim('first',first);
  const observations = n.qianchuanSnapshot.members.map((m) => ({ requestId: m.requestId, rowIndex: m.rowIndex, assignee: '' }));
  const assign = async (id, overrides = {}) => {
    const s = await scalar('select version,forward_version from public.bess_dispatch_daily_state');
    const c = claims.get(id); const args = { token: c.token, items: c.items, observations, version: s.version,
      cursor: s.forward_version, ...overrides };
    return (await scalar('select public.bess_assign_qianchuan_groups($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
      [day,'test_default',id,args.token,args.items,args.observations,'',args.version,args.cursor])).result;
  };
  const confirm = async (id, overrides = {}) => {
    const c = claims.get(id);
    const receipts = c.items.map((m) => ({ requestId: m.requestId, rowIndex: m.rowIndex,
      assignee: ['A','B','B','B','C','C','D'][m.sourcePosition] }));
    return db.query('select public.bess_confirm_qianchuan_writes($1,$2,$3,$4,$5,$6,$7)',
      [day,'test_default',id,c.token,'sql-source',n.qianchuanSnapshot.snapshotHash,overrides.receipts || receipts]);
  };
  const secondResults = await assign('second');
  check(JSON.stringify(secondResults.map((r) => r.assignee)) === '["B","C","C"]', 'bucket-first click uses complete original plan');
  check((await scalar('select forward_cursor from public.bess_dispatch_daily_state')).forward_cursor === 4, 'whole source consumes four groups, not seven items');
  await fails(() => assign('first'), 'QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
  const replay = await assign('second');
  check(replay.every((r) => r.replayed), 'lost decision response replays persisted facts');
  check((await scalar('select count(*)::integer n from public.bess_dispatch_assignments')).n === 3, 'replay does not create assignments');
  await fails(() => confirm('second', { receipts: [{ requestId: 'r2', rowIndex: 12, assignee: 'wrong' }] }), 'QIANCHUAN_RECEIPT_CONFLICT');
  await confirm('second');
  const firstResults = await assign('first');
  check(JSON.stringify(firstResults.map((r) => r.assignee)) === '["A","B","B","D"]', 'later regular delivery reuses frozen groups');
  await confirm('first');
  check((await scalar('select jsonb_array_length(pending_request_ids) n from public.bess_qianchuan_sources')).n === 0, 'all sheet confirmations clear pending boundary');
  check((await scalar('select forward_cursor from public.bess_dispatch_daily_state')).forward_cursor === 4, 'second delivery does not consume cursor again');
  await fails(() => assign('first', { token: 'stale' }), 'BATCH_CLAIM_LOST');
  await db.query(`update public.bess_dispatch_pending_forms set request_context=jsonb_set(request_context,'{leaseExpiresAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) where form_message_id='first'`);
  await fails(() => assign('first'), 'BATCH_CLAIM_LOST');
  check((await scalar(`select relrowsecurity and relforcerowsecurity ok from pg_class where oid='public.bess_qianchuan_sources'::regclass`)).ok, 'RLS and FORCE RLS');
  check(!(await scalar(`select has_table_privilege('anon','public.bess_qianchuan_sources','SELECT') ok`)).ok, 'anon cannot select source facts');
  check(!(await scalar(`select has_function_privilege('anon','public.bess_assign_qianchuan_groups(date,text,text,text,jsonb,jsonb,text,bigint,bigint)','EXECUTE') ok`)).ok, 'anon cannot assign groups');
  check(!(await scalar(`select has_function_privilege('service_role','public.bess_assert_qianchuan_claim(text,text)','EXECUTE') ok`)).ok, 'internal fence helper not exposed');
  check((await scalar(`select has_function_privilege('service_role','public.bess_assign_qianchuan_groups(date,text,text,text,jsonb,jsonb,text,bigint,bigint)','EXECUTE') ok`)).ok, 'service role may use assignment RPC');
  const isolatedCase = async (work) => {
    await db.exec(`begin; delete from public.bess_dispatch_assignments; delete from public.bess_qianchuan_sources;
      delete from public.bess_dispatch_pending_forms; update public.bess_dispatch_daily_state set
        forward_cursor=0,forward_version=1,version=1,assignment_seq=0,off_duty='[]';`);
    try {
      inCase = true;
      await db.query('select public.bess_register_qianchuan_source($1,$2,$3)', ['test_default',day,n.qianchuanSnapshot]);
      await claim('case',n.fieldsList); await work();
    } finally { inCase = false; await db.exec('rollback'); }
  };
  await isolatedCase(async () => {
    await fails(() => assign('case', { version: 0 }), 'CAS_QIANCHUAN_VERSION_MISMATCH');
    check((await scalar('select count(*)::integer n from public.bess_dispatch_assignments')).n === 0, 'CAS conflict is zero assignment');
    check((await scalar('select group_plan is null ok from public.bess_qianchuan_sources')).ok, 'CAS conflict does not reserve groups');
  });
  await isolatedCase(async () => {
    const observed = structuredClone(observations); observed[1].assignee='B'; observed[3].assignee='C';
    await fails(() => assign('case', { observations: observed }), 'QIANCHUAN_MANUAL_GROUP_CONFLICT');
    check((await scalar('select forward_cursor from public.bess_dispatch_daily_state')).forward_cursor === 0, 'manual conflict does not advance cursor');
    check((await scalar('select count(*)::integer n from public.bess_dispatch_assignments')).n === 0, 'manual conflict is atomic rollback');
  });
  await isolatedCase(async () => {
    const observed = structuredClone(observations); observed[1].assignee='C'; observed[3].assignee='C';
    const result = await assign('case', { observations: observed });
    check(JSON.stringify(result.map((r) => r.assignee))==='["A","C","C","C","D","D","E"]', 'manual object group binds members and calibrates next turn');
    check((await scalar(`select (group_plan->'g1'->>'consumesTurn')::boolean consumes from public.bess_qianchuan_sources`)).consumes === false, 'manual group is not an automatic turn');
    const bad = n.fieldsList.map((m) => ({ requestId:m.requestId,rowIndex:m.rowIndex,
      assignee:result.find((r) => r.request_id===m.requestId).assignee }));
    bad[0].rowIndex=999;
    await fails(() => confirm('case',{receipts:bad}), 'QIANCHUAN_RECEIPT_CONFLICT');
  });
  await isolatedCase(async () => {
    await db.exec(`update public.bess_dispatch_daily_state set off_duty='["A","B","C","D","E"]'`);
    await fails(() => assign('case'), 'ALL_OFF_DUTY');
    check((await scalar('select group_plan is null ok from public.bess_qianchuan_sources')).ok, 'all off duty does not create plan');
  });
  await isolatedCase(async () => {
    await db.exec(`update public.bess_dispatch_daily_state set off_duty='["B"]'`);
    const result = await assign('case');
    check(JSON.stringify(result.map((r) => r.assignee))==='["A","C","C","C","D","D","E"]', 'paused people are skipped once per group');
  });
  await isolatedCase(async () => {
    await claim('other',n.fieldsList); await assign('case');
    await fails(() => assign('other'), 'QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
    check((await scalar('select count(*)::integer n from public.bess_dispatch_assignments')).n===7, 'same rows in another delivery cannot take write ownership');
  });
  await isolatedCase(async () => {
    await assign('case');
    const before = await scalar('select forward_cursor,assignment_seq from public.bess_dispatch_daily_state');
    const moved = n.fieldsList.map((i) => ({ ...i,rowIndex:i.rowIndex+30 }));
    const movedObs = observations.map((r) => ({...r,rowIndex:r.rowIndex+30}));
    await fails(() => assign('case',{items:moved}), 'QIANCHUAN_OBSERVATION_INVALID');
    const replay = await assign('case',{items:moved,observations:movedObs});
    check(replay.every((r) => r.replayed),'moved target recovery reuses original decisions');
    await fails(() => confirm('case'), 'QIANCHUAN_RECEIPT_CONFLICT');
    await confirm('case',{receipts:moved.map((i,j) => ({requestId:i.requestId,rowIndex:i.rowIndex,assignee:replay[j].assignee}))});
    check(JSON.stringify(await scalar('select forward_cursor,assignment_seq from public.bess_dispatch_daily_state'))===JSON.stringify(before),'relocation does not consume cursor or assignment sequence');
    check((await scalar(`select (request_context->>'rowIndex')::integer n from public.bess_dispatch_assignments where request_id='r0'`)).n===10,'immutable decision preserves original row hint');
    check((await scalar('select jsonb_array_length(pending_request_ids) n from public.bess_qianchuan_sources')).n===0,'relocated recovery confirms and clears pending');
  });
  console.log(JSON.stringify({ environment: 'ephemeral_pglite_isolated_fixture', checks,
    production_access: false, postgrest_verified: false, multi_session_concurrency_verified: false }));
} finally { await db.close(); }
