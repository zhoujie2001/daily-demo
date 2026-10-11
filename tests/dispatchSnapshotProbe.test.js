import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotProbeHandler } from '../lib/dispatch/api/snapshot-probe.js';

const NOW = Date.parse('2026-10-11T09:00:00Z');
const TOKEN = 'a'.repeat(64);
const baseEnv = {
  VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'fix/dispatch-anchor-consistency',
  VERCEL_PROJECT_ID: 'prj_AmQbJLMoimeuOM9uLQzjznKcxvXv',
  VERCEL_GIT_COMMIT_SHA: 'test-commit', PR110_SNAPSHOT_READ_TOKEN: TOKEN,
  PR110_SNAPSHOT_EXPIRES_AT: '2026-10-11T10:00:00Z', PR110_SNAPSHOT_DAY: '2026-10-11',
  PR110_SNAPSHOT_API_KEY: 'sb_publishable_test',
  SUPABASE_SERVICE_ROLE_KEY: 'DO_NOT_USE_PRODUCTION_SECRET',
};
function snapshot(scope) {
  return [{ day_key: '2026-10-11', scope, version: 3,
    assignments: [2, 1].map((id) => ({ id, day_key: '2026-10-11', scope,
      created_at: '2026-10-11T01:00:00Z', assignee: 'PRIVATE_PERSON' })) }];
}
async function invoke({ env = {}, request = {}, transform = (rows) => rows, fail = false } = {}) {
  const calls = [];
  const handler = createSnapshotProbeHandler({ env: { ...baseEnv, ...env }, now: () => NOW,
    fetchImpl: async (input, options) => {
      calls.push({ input, options });
      if (fail) throw new Error(`PRIVATE_PERSON ${TOKEN} DO_NOT_USE_PRODUCTION_SECRET`);
      const scope = new URL(input).searchParams.get('scope').slice(3);
      return { ok: true, status: 200, async text() { return JSON.stringify(transform(snapshot(scope))); } };
    } });
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', body: {}, headers: { 'x-pr110-probe-token': TOKEN }, ...request }, res);
  return { res, calls };
}
test('snapshot probe uses the real FK store query twice, GET only, returns only summary', async () => {
  const { res, calls } = await invoke();
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'PASS');
  assert.equal(res.body.database_gets, 2);
  assert.deepEqual(res.body.checks.map((row) => row.scope), ['ad', 'ad_game']);
  for (const { input, options } of calls) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://cusjrnfczwrbmgkihwls.supabase.co');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.apikey, 'sb_publishable_test');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['x-pr110-read-token'], TOKEN);
    assert.match(url.searchParams.get('select'), /bess_dispatch_assignments_day_scope_fkey/);
  }
  assert.doesNotMatch(JSON.stringify(res), /PRIVATE_PERSON|DO_NOT_USE|aaaa/);
});
for (const env of [
  { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' },
  { VERCEL_GIT_COMMIT_REF: 'main' }, { VERCEL_PROJECT_ID: 'other-project' },
]) test(`probe invisible outside approved preview ${JSON.stringify(env)}`, async () => {
  const { res, calls } = await invoke({ env });
  assert.equal(res.code, 404); assert.equal(calls.length, 0);
});
test('wrong method or token cannot query the database', async () => {
  for (const [request, expected] of [[{ method: 'GET' }, 405], [{ headers: {} }, 403]]) {
    const { res, calls } = await invoke({ request });
    assert.equal(res.code, expected); assert.equal(calls.length, 0);
  }
});
for (const env of [
  { PR110_SNAPSHOT_READ_TOKEN: '' }, { PR110_SNAPSHOT_API_KEY: 'sb_secret_privileged' },
  { PR110_SNAPSHOT_EXPIRES_AT: '2026-10-11T08:00:00Z' },
  { PR110_SNAPSHOT_EXPIRES_AT: '2026-10-12T08:00:00Z' },
  { PR110_SNAPSHOT_DAY: '2026-02-31' },
]) test(`invalid or expired config fails closed ${Object.keys(env)[0]}`, async () => {
  const { res, calls } = await invoke({ env });
  assert.equal(res.code, 503); assert.equal(calls.length, 0);
});
test('service-role JWT is rejected, not treated as read-only', async () => {
  const key = `eyJ.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  const { res, calls } = await invoke({ env: { PR110_SNAPSHOT_API_KEY: key } });
  assert.equal(res.code, 503); assert.equal(calls.length, 0);
});
test('client cannot select resources, dates, scopes or SQL', async () => {
  const { res, calls } = await invoke({ request: { body: { scope: 'default' } } });
  assert.equal(res.code, 400); assert.equal(calls.length, 0);
});
for (const transform of [
  (rows) => { rows[0].scope = 'wrong'; return rows; },
  (rows) => { rows[0].assignments[1].day_key = '2026-10-10'; return rows; },
  (rows) => { rows[0].assignments.reverse(); return rows; },
  () => [],
]) test('mismatched, empty or unordered snapshot is not a PASS', async () => {
  const { res } = await invoke({ transform });
  assert.equal(res.code, 502); assert.equal(res.body.ok, false);
});
test('upstream exceptions never expose secrets or business records', async () => {
  const { res } = await invoke({ fail: true });
  assert.equal(res.code, 502);
  assert.deepEqual(res.body, { ok: false, error_code: 'SNAPSHOT_VERIFICATION_FAILED' });
});
