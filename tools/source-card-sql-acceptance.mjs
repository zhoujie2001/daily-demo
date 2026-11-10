// Isolated PGlite SQL acceptance only. No network, production credentials or real batches.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { occupationAcceptance } from './source-card-occupation-acceptance.mjs';
import { sourceCardFixture } from '../tests/fixtures/source-card-manifest.js';
import { sourceCardManifestHash, sourceCardBinding } from '../lib/dispatch/source-card-manifest.js';

const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite');
const dataDir = await mkdtemp(join(tmpdir(), 'source-card-sql-'));
let db = new PGlite(dataDir);
let checks = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const register = (manifest) => db.query('select public.bess_register_source_card_manifest($1)', [manifest]);
const binding = (manifest, index, requestIds = manifest.chunks[index - 1].request_ids, subset = false) =>
  db.query('select public.bess_assert_source_card_binding($1,$2,$3)', [sourceCardBinding(manifest, index), requestIds, subset]);
const fails = async (work, code) => { await assert.rejects(work, (error) => error.message.includes(code)); checks++; };
try {
  await db.exec(await readFile(new URL('../tests/fixtures/qianchuan-sql-baseline.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../tests/fixtures/source-card-sql-baseline.sql', import.meta.url), 'utf8'));
  for (const path of ['20261023_dispatch_ingest_root.sql', '20261015_handoff_p0.sql', '20260915_dispatch_outbox.sql']) {
    await db.exec(await readFile(new URL(`../db/migrations/${path}`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../supabase/migrations/202611080001_source_card_manifest.sql', import.meta.url), 'utf8'));
  const { manifest } = sourceCardFixture();
  await register(manifest); await register(manifest);
  check((await scalar('select count(*)::int n from public.bess_source_card_manifests')).n, 1, 'source idempotency');
  check((await scalar('select count(*)::int n from public.bess_source_card_chunks')).n, 4, 'first delivery reserves complete 78 list');
  for (const index of [4, 2, 1, 3]) { await binding(manifest, index); checks++; }
  check((await scalar('select count(*)::int n from public.bess_dispatch_daily_state')).n, 0, 'no roster/cursor writes');
  check((await scalar('select count(*)::int n from public.bess_dispatch_assignments')).n, 0, 'no real dispatch');
  await binding(manifest, 3, [manifest.chunks[2].request_ids[5]], true); checks++;
  await fails(() => binding(manifest, 1, [...manifest.chunks[0].request_ids].reverse()), 'SOURCE_CARD_BINDING_CONFLICT');
  await fails(() => binding(manifest, 1, ['unknown'], true), 'SOURCE_CARD_BINDING_CONFLICT');
  await fails(() => binding(manifest, 1, [manifest.chunks[0].request_ids[0], manifest.chunks[0].request_ids[1]], true), 'SOURCE_CARD_BINDING_CONFLICT');
  for (const mutate of [
    (m) => { m.chat_id = 'oc_changed'; },
    (m) => { m.chunks[3].batch_id = 'changed_final_batch'; },
    (m) => { m.chunks[1].request_ids.reverse(); },
    (m) => { m.chunks[0].request_ids[0] = 'new_member'; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed); changed.manifest_hash = sourceCardManifestHash(changed);
    await fails(() => register(changed), 'SOURCE_CARD_BINDING_CONFLICT');
  }
  const changedSource = structuredClone(manifest); changedSource.source_batch_id = 'another_source';
  changedSource.manifest_hash = sourceCardManifestHash(changedSource);
  await fails(() => register(changedSource), 'SOURCE_CARD_BINDING_CONFLICT');
  check((await scalar('select count(*)::int n from public.bess_source_card_manifests')).n, 1, 'conflicting source transaction rolled back');
  for (const mutate of [
    (m) => { m.version = 2; },
    (m) => { m.dispatch_profile = 'test_default'; },
    (m) => { m.target_category = 'qianchuan'; },
    (m) => { m.chunks[1].chunk_index = 1; },
    (m) => { m.chunks[1].request_ids[0] = m.chunks[0].request_ids[0]; },
    (m) => { m.chunks[1].batch_id = m.chunks[0].batch_id; },
    (m) => { m.total_item_count = 77; },
    (m) => { m.chunk_count = 3; },
    (m) => { m.chunks[0].item_count = 19; },
    (m) => { m.future = 1; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed); changed.manifest_hash = sourceCardManifestHash(changed);
    await fails(() => register(changed), 'SOURCE_CARD_INVALID_MANIFEST');
  }
  const badHash = { ...manifest, manifest_hash: '0'.repeat(64) };
  await fails(() => register(badHash), 'SOURCE_CARD_INVALID_MANIFEST');
  for (const total of [21, 20]) {
    const m = sourceCardFixture(total).manifest; await register(m);
    for (const chunk of m.chunks) { await binding(m, chunk.chunk_index); checks++; }
  }
  await db.query('select public.bess_assert_legacy_source_card_batch($1)', ['legacy_batch']); checks++;
  await fails(() => db.query('select public.bess_assert_legacy_source_card_batch($1)', [manifest.chunks[3].batch_id]), 'SOURCE_CARD_BINDING_CONFLICT');
  for (const table of ['bess_source_card_manifests','bess_source_card_chunks','bess_source_card_legacy_messages']) {
    check((await scalar(`select relrowsecurity and relforcerowsecurity ok from pg_class where oid='public.${table}'::regclass`)).ok, true, 'RLS + FORCE RLS');
    for (const role of ['anon','authenticated','service_role']) {
      check((await scalar(`select has_table_privilege('${role}','public.${table}','INSERT,UPDATE,DELETE') ok`)).ok, false, 'immutable direct writes');
    }
  }
  for (const rpc of ['bess_register_source_card_manifest(jsonb,jsonb)','bess_assert_source_card_binding(jsonb,jsonb,boolean)','bess_assert_legacy_source_card_batch(text)','bess_assert_legacy_source_card_members(text,jsonb,text)']) {
    for (const role of ['anon','authenticated']) {
      check((await scalar(`select has_function_privilege('${role}','public.${rpc}','EXECUTE') ok`)).ok, false, 'no untrusted RPC access');
    }
    check((await scalar(`select has_function_privilege('service_role','public.${rpc}','EXECUTE') ok`)).ok, true, 'service RPC access');
  }
  check((await scalar("select has_function_privilege('service_role','public.bess_source_card_canonical(jsonb)','EXECUTE') ok")).ok, false, 'internal canonical helper not exposed');
  await db.exec('set role service_role');
  await binding(manifest, 1); checks++;
  await register(manifest); checks++;
  await db.exec('reset role');
  await db.exec('set role anon');
  await fails(() => binding(manifest, 1), 'permission denied');
  await db.exec('reset role');
  checks += await occupationAcceptance(db);
  // Close/reopen the on-disk database: facts must survive without any JS/source cache.
  await db.close();
  db = new PGlite(dataDir);
  const freshReader = (m, i) => db.query('select public.bess_assert_source_card_binding($1,$2,false)',
    [sourceCardBinding(m, i), m.chunks[i - 1].request_ids]);
  await freshReader(manifest, 4); checks++;
  const legacyMember = JSON.stringify([{ request_id: 'game_1', dispatch_profile: 'ad', target_category: 'game_agent' }]);
  await db.query('select public.bess_assert_legacy_source_card_members($1,$2,$3)',
    [manifest.chat_id, legacyMember, 'om_late_history']); checks++;
  await fails(() => db.query('select public.bess_assert_legacy_source_card_members($1,$2,$3)',
    [manifest.chat_id, legacyMember, 'om_source_stripped']), 'SOURCE_CARD_BINDING_CONFLICT');
  await fails(() => register(changedSource), 'SOURCE_CARD_BINDING_CONFLICT');
  console.log(JSON.stringify({ ok: true, checks, engine: 'isolated on-disk PGlite PostgreSQL', restart_persistence: true, production_calls: 0 }));
} finally { await db.close(); await rm(dataDir, { recursive: true, force: true }); }
