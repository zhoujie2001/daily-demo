// TRUE two-session PostgreSQL concurrency acceptance, localhost sandbox ONLY.
// Usage: node tools/source-card-postgres-acceptance.mjs /tmp/.../pg/lib/index.js 55439
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { occupationAcceptance, occupationFixture, reserve, register, handoff } from './source-card-occupation-acceptance.mjs';
const { default: pg } = await import(pathToFileURL(process.argv[2]).href);
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1024) throw new Error('Explicit isolated localhost port required');
const config = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres' };
const admin = new pg.Client(config);
await admin.connect();
const database = `source_card_acceptance_${process.pid}`;
let a, b, observer;
let checks = 0;
try {
  await admin.query(`create database ${database}`);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
      await admin.query(`create role ${role}${role === 'service_role' ? ' bypassrls' : ''}`);
    }
  }
  a = new pg.Client({ ...config, database }); b = new pg.Client({ ...config, database });
  observer = new pg.Client({ ...config, database });
  await Promise.all([a.connect(), b.connect(), observer.connect()]);
  const baseline = await readFile(new URL('../tests/fixtures/qianchuan-sql-baseline.sql', import.meta.url), 'utf8');
  await a.query(baseline.replace(/^create role .*;$/gm, ''));
  for (const path of ['tests/fixtures/source-card-sql-baseline.sql',
    'db/migrations/20261023_dispatch_ingest_root.sql', 'db/migrations/20261015_handoff_p0.sql',
    'db/migrations/20260915_dispatch_outbox.sql', 'supabase/migrations/202611080001_source_card_manifest.sql']) {
    await a.query(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  }
  checks += await occupationAcceptance(a);
  await a.query("set statement_timeout='10s'"); await b.query("set statement_timeout='10s'");
  const bPid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
  for (const legacyMethod of [reserve, handoff]) for (const legacyFirst of [true, false]) {
    const source = `race_${legacyMethod.name}_${legacyFirst}`;
    const old = occupationFixture(source, true), next = occupationFixture(source);
    await a.query('begin');
    await (legacyFirst ? legacyMethod(a, old) : register(a, next));
    // Attach rejection handler before observing the wait. This is a real separate
    // backend, not Promise.all over a single PGlite connection.
    const waiting = (legacyFirst ? register(b, next) : legacyMethod(b, old))
      .then((result) => ({ result }), (error) => ({ error }));
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      const row = (await observer.query('select wait_event from pg_stat_activity where pid=$1', [bPid])).rows[0];
      if (row?.wait_event === 'advisory') { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, `${source}: contender actually blocked on shared advisory lock`); checks++;
    await a.query('commit');
    const outcome = await waiting;
    assert.match(outcome.error?.message || '', /SOURCE_CARD_BINDING_CONFLICT/); checks++;
    const count = (await observer.query('select count(*)::int n from public.bess_source_card_chunks where source_batch_id=$1', [source])).rows[0].n;
    assert.equal(count, legacyFirst ? 0 : 2, `${source}: loser leaves no registry mutation`); checks++;
    if (legacyFirst) {
      assert.equal((await legacyMethod(a, old)).rows[0].outcome, 'REUSED'); checks++;
      await a.query('select public.bess_assert_legacy_source_card_batch($1)', [old.root.batchId]); checks++;
    } else { await register(a, next); checks++; }
  }
  console.log(JSON.stringify({ ok: true, checks, engine: 'isolated localhost PostgreSQL 15',
    real_two_session_races: 4, observed_advisory_waits: 4, production_calls: 0 }));
} finally {
  if (a) { await a.query('rollback').catch(() => {}); await a.end(); }
  if (b) await b.end(); if (observer) await observer.end();
  await admin.query(`drop database if exists ${database} with (force)`); await admin.end();
}
