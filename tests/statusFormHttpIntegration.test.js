import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import callback from '../api/lark/callback.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import { nextShanghaiMidnight, shanghaiDay } from '../lib/dispatch/roster.js';

// Local HTTP integration simulation, NOT live Feishu/PostgREST acceptance.
// The production callback, LarkClient, Supabase adapter and renderer are real;
// remote endpoints and RPC transaction semantics below are explicitly simulated.
const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
const selection = { ad_review_off_duty: ['模拟乙'], ad_game_off_duty: [], ad_emergency_off_duty: ['模拟甲'] };
const appId = 'cli_local_status_simulation';
const token = 'local-simulation-verification-only';

async function harness(t) {
  const memory = createMemoryBatchStore();
  const now = new Date();
  const dayKey = shanghaiDay(now);
  await memory.initializeRoster({ dayKey, scope: 'ad_review', roster: ['模拟甲', '模拟乙'], expiresAt: nextShanghaiMidnight(now) });
  const initial = await Promise.all(scopes.map((scope) => memory.getDailyState(dayKey, scope)));
  await memory.updateAdRosterStatuses({
    dayKey, confirmationOperationId: 'seed', submissionHash: 'seed', confirmedBy: 'ou_local_simulation',
    updates: initial.map((s) => ({ scope: s.scope, offDuty: ['模拟甲'], expectedVersion: s.version, expectedRosterRevision: s.roster_revision })),
  });
  const requests = [];
  const cards = new Map();
  const errors = [];
  const injection = { completionErrors: 0, dropRpcReceipt: false, rpcDelayMs: 0 };
  let rpcCommits = 0;
  let replySequence = 0;
  let eventSequence = 0;
  const networkFetch = globalThis.fetch;
  const envKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LARK_APP_ID', 'LARK_APP_SECRET',
    'LARK_VERIFICATION_TOKEN', 'LARK_API_BASE_URL', 'LARK_DISPATCH_ALLOWED_CHAT_IDS', 'LARK_DISPATCH_FEATURE_ENABLED', 'LARK_ENCRYPT_KEY'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === '/api/lark/callback') {
        req.body = rawBody;
        res.status = (status) => { res.statusCode = status; return res; };
        res.json = (payload) => { json(res, res.statusCode || 200, payload); return res; };
        await callback(req, res);
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        assert.equal(req.headers.apikey, 'local-simulation-db-key');
        const resource = url.pathname.slice('/rest/v1/'.length);
        const eq = (field) => url.searchParams.get(field)?.replace(/^eq\./, '');
        if (resource === 'bess_dispatch_daily_state' && req.method === 'GET') {
          const state = await memory.getDailyState(eq('day_key'), eq('scope'));
          json(res, 200, state ? [state] : []);
          return;
        }
        if (resource === 'bess_dispatch_pending_forms') {
          if (req.method === 'POST') { json(res, 201, [await memory.savePending(body)]); return; }
          const id = eq('form_message_id');
          if (req.method === 'GET') {
            const pending = await memory.getPending(id, new Date(), { includeCompleted: !url.searchParams.has('completed_at') });
            json(res, 200, pending ? [pending] : []);
            return;
          }
          if (req.method === 'PATCH') {
            if (injection.completionErrors > 0) {
              injection.completionErrors -= 1;
              json(res, 503, { code: 'LOCAL_COMPLETION_RECEIPT_LOSS', message: 'injected local simulation' });
              return;
            }
            json(res, 200, [await memory.markPendingCompleted(id, new Date(body.completed_at))]);
            return;
          }
        }
        if (req.method === 'DELETE' && ['bess_dispatch_pending_forms', 'bess_dispatch_daily_state'].includes(resource)) {
          assert.ok(url.searchParams.get('expires_at')?.startsWith('lte.'));
          res.writeHead(204); res.end(); return;
        }
        if (resource === 'rpc/bess_update_ad_roster_statuses' && req.method === 'POST') {
          if (injection.rpcDelayMs) await new Promise((resolve) => setTimeout(resolve, injection.rpcDelayMs));
          let result;
          try {
            result = await memory.updateAdRosterStatuses({
              dayKey: body.p_day_key,
              confirmationOperationId: body.p_confirmation_operation_id,
              submissionHash: body.p_submission_hash,
              confirmedBy: body.p_confirmed_by,
              updates: body.p_updates.map((u) => ({ scope: u.scope, offDuty: u.off_duty,
                expectedVersion: u.expected_version, expectedRosterRevision: u.expected_roster_revision })),
            });
          } catch (error) {
            json(res, 409, { code: 'P0001', message: error.message });
            return;
          }
          if (!result.replayed) rpcCommits += 1;
          if (injection.dropRpcReceipt) {
            injection.dropRpcReceipt = false;
            res.destroy();
            return;
          }
          json(res, 200, [result]); return;
        }
        throw new Error(`Unexpected simulated database request: ${req.method} ${resource}`);
      }
      if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
        assert.equal(body.app_id, appId);
        assert.equal(body.app_secret, 'local-simulation-app-secret');
        json(res, 200, { code: 0, tenant_access_token: 'local-simulation-tenant-token', expire: 7200 });
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer local-simulation-tenant-token');
      if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(url.pathname) && req.method === 'POST') {
        const id = `om_simulated_${++replySequence}`;
        if (body.msg_type === 'interactive') cards.set(id, JSON.parse(body.content));
        json(res, 200, { code: 0, data: { message_id: id } }); return;
      }
      if (/^\/open-apis\/im\/v1\/messages\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
        cards.set(url.pathname.split('/').at(-1), JSON.parse(body.content));
        json(res, 200, { code: 0, data: {} }); return;
      }
      throw new Error(`Unexpected simulated Lark request: ${req.method} ${url.pathname}`);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) json(res, 500, { error: 'LOCAL_SIMULATION_CONTRACT_ERROR' });
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    SUPABASE_URL: baseUrl, SUPABASE_SERVICE_ROLE_KEY: 'local-simulation-db-key',
    LARK_APP_ID: appId, LARK_APP_SECRET: 'local-simulation-app-secret', LARK_VERIFICATION_TOKEN: token,
    LARK_API_BASE_URL: baseUrl, LARK_DISPATCH_ALLOWED_CHAT_IDS: 'oc_local_test,oc_other_test', LARK_DISPATCH_FEATURE_ENABLED: '1',
  });
  delete process.env.LARK_ENCRYPT_KEY;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, baseUrl, 'All simulation traffic must remain on the current loopback server');
    return networkFetch(input, init);
  };
  t.after(async () => {
    // Callback afterResponse work is observed below before closing the fixture.
    await new Promise((resolve) => setImmediate(resolve));
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = networkFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    assert.deepEqual(errors.map((e) => e.message), [], 'No unimplemented simulated endpoint may be silently accepted');
  });
  const event = (value, formValue, messageId, overrides = {}) => ({
    header: { event_id: `local-http-${++eventSequence}`, event_type: 'card.action.trigger', app_id: appId, token },
    event: { operator: { open_id: 'ou_local_simulation' },
      action: { tag: 'button', ...(value ? { value } : {}), ...(formValue ? { form_value: formValue } : {}) },
      context: { open_chat_id: 'oc_local_test', open_message_id: messageId }, ...overrides },
  });
  const post = async (payload) => {
    const response = await fetch(`${baseUrl}/api/lark/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const waitFor = async (predicate) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Local asynchronous callback did not reach its expected state');
  };
  const open = async () => {
    const previousIds = new Set(cards.keys());
    const result = await post(event({ action: 'bess_adjust_status', day_key: dayKey,
      business_type: 'AD', target_category: 'qianchuan_ad', dispatch_profile: 'ad' }, null, 'om_local_original'));
    assert.equal(result.status, 200);
    assert.equal(result.body.toast.type, 'success');
    const [id, card] = [...cards].find(([key]) => !previousIds.has(key));
    const form = card.body.elements.find((e) => e.tag === 'form');
    const button = form.elements.find((e) => e.name === 'adjust_status_submit');
    assert.ok(button.value);
    const text = JSON.stringify(card);
    for (const title of ['AD大盘名单', 'AD游戏名单', '应急需求名单']) assert.ok(text.includes(title));
    assert.ok(await memory.getPending(id), 'Opening the actual rendered form must persist its server context');
    return { id, value: structuredClone(button.value), card };
  };
  const snapshot = () => Promise.all(scopes.map((scope) => memory.getDailyState(dayKey, scope)));
  const submit = async (form, fields = selection, withValue = true) => {
    const result = await post(event(withValue ? form.value : null, fields, form.id));
    if (result.body.toast?.type === 'success') {
      await waitFor(() => JSON.stringify(cards.get(form.id)).includes('已更新'));
    }
    return result;
  };
  return { memory, dayKey, cards, requests, injection, open, snapshot, post, event, submit, waitFor,
    commits: () => rpcCommits };
}

for (const withValue of [true, false]) {
  test(`HTTP simulation: rendered status form ${withValue ? 'with button value' : 'form-only'} saves exactly once`, async (t) => {
    const f = await harness(t);
    const form = await f.open();
    const before = await f.snapshot();
    const result = await f.submit(form, selection, withValue);
    assert.equal(result.status, 200);
    assert.equal(result.body.toast.type, 'success');
    const after = await f.snapshot();
    assert.deepEqual(after.map((s) => s.off_duty), [['模拟乙'], [], ['模拟甲']]);
    assert.deepEqual(after.map((s) => s.version), before.map((s) => s.version + 1));
    assert.deepEqual(after.map((s) => [s.forward_cursor, s.reverse_cursor, s.emergency_forward_cursor, s.assignment_seq]),
      before.map((s) => [s.forward_cursor, s.reverse_cursor, s.emergency_forward_cursor, s.assignment_seq]));
    await f.waitFor(() => JSON.stringify(f.cards.get(form.id)).includes('已更新'));
    assert.equal((await f.submit(form, selection, withValue)).body.toast.type, 'success');
    assert.deepEqual(await f.snapshot(), after);
    assert.equal(f.commits(), 1);
  });
}

test('HTTP simulation: three explicit empty arrays clear all scopes', async (t) => {
  const f = await harness(t);
  const result = await f.submit(await f.open(), Object.fromEntries(scopes.map((s) => [`${s}_off_duty`, []])));
  assert.equal(result.body.toast.type, 'success');
  assert.deepEqual((await f.snapshot()).map((s) => s.off_duty), [[], [], []]);
});

for (const field of Object.keys(selection)) {
  test(`HTTP simulation: legacy pending missing ${field} rejects without a status RPC`, async (t) => {
    const f = await harness(t);
    const form = await f.open();
    const pending = await f.memory.getPending(form.id);
    delete pending.request_context.statusFormSelectionMode;
    delete pending.request_context.initialAdOffDuty;
    await f.memory.savePending(pending);
    const before = await f.snapshot();
    const fields = structuredClone(selection);
    delete fields[field];
    const result = await f.submit(form, fields);
    assert.equal(result.body.toast.type, 'error');
    assert.match(result.body.toast.content, /字段不完整或格式无效/);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.requests.filter((r) => r.path.startsWith('/rest/v1/rpc/')).length, 0);
  });
}

test('HTTP simulation: legacy pending cannot clear existing off-duty selections', async (t) => {
  const f = await harness(t);
  const form = await f.open();
  const pending = await f.memory.getPending(form.id);
  delete pending.request_context.statusFormProtocolVersion;
  await f.memory.savePending(pending);
  const before = await f.snapshot();
  assert.equal((await f.submit(form)).body.toast.type, 'error');
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.commits(), 0);
});

test('HTTP simulation: two real forms conflict on the captured CAS snapshot', async (t) => {
  const f = await harness(t);
  const first = await f.open();
  const stale = await f.open();
  assert.equal((await f.submit(first)).body.toast.type, 'success');
  const saved = await f.snapshot();
  assert.equal((await f.submit(stale)).body.toast.type, 'error');
  assert.deepEqual(await f.snapshot(), saved);
  assert.equal(f.commits(), 1);
});

for (const invalid of ['token', 'app_id']) {
  test(`HTTP simulation: invalid ${invalid} is rejected before database or Lark access`, async (t) => {
    const f = await harness(t);
    const form = await f.open();
    const body = f.event(form.value, selection, form.id);
    body.header[invalid] = 'wrong';
    const count = f.requests.filter((r) => r.path !== '/api/lark/callback').length;
    assert.equal((await f.post(body)).status, 403);
    assert.equal(f.requests.filter((r) => r.path !== '/api/lark/callback').length, count);
    assert.equal(f.commits(), 0);
  });
}

test('HTTP simulation: cross-chat callback preserves every roster', async (t) => {
  const f = await harness(t);
  const form = await f.open();
  const body = f.event(form.value, selection, form.id);
  body.event.context.open_chat_id = 'oc_other_test';
  const before = await f.snapshot();
  assert.equal((await f.post(body)).body.toast.type, 'error');
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.commits(), 0);
});

test('HTTP simulation: completion receipt loss replays the same operation without another commit', async (t) => {
  const f = await harness(t);
  const form = await f.open();
  f.injection.completionErrors = 1;
  assert.equal((await f.submit(form)).body.toast.type, 'success');
  const saved = await f.snapshot();
  assert.equal((await f.submit(form)).body.toast.type, 'success');
  assert.deepEqual(await f.snapshot(), saved);
  assert.equal(f.commits(), 1);
  const operations = f.requests.filter((r) => r.path.endsWith('/bess_update_ad_roster_statuses'));
  assert.equal(operations.length, 2);
  assert.equal(new Set(operations.map((r) => r.body.p_confirmation_operation_id)).size, 1);
});

test('HTTP simulation: committed RPC with lost HTTP response is recoverable under the original operation', async (t) => {
  const f = await harness(t);
  const form = await f.open();
  f.injection.dropRpcReceipt = true;
  assert.equal((await f.submit(form)).body.toast.type, 'error');
  const saved = await f.snapshot();
  assert.deepEqual(saved.map((s) => s.off_duty), [['模拟乙'], [], ['模拟甲']]);
  assert.equal((await f.submit(form)).body.toast.type, 'success');
  assert.deepEqual(await f.snapshot(), saved);
  assert.equal(f.commits(), 1);
});

test('HTTP simulation: callback deadline acknowledges first and publishes the eventual status result', async (t) => {
  const f = await harness(t);
  const form = await f.open();
  f.injection.rpcDelayMs = 650;
  const response = await f.submit(form);
  assert.equal(response.status, 200);
  assert.equal(response.body.toast.type, 'info');
  await f.waitFor(() => JSON.stringify(f.cards.get(form.id)).includes('已更新'));
  assert.deepEqual((await f.snapshot()).map((s) => s.off_duty), [['模拟乙'], [], ['模拟甲']]);
  assert.equal(f.commits(), 1);
});

for (const empty of [undefined, null, '']) {
  test(`HTTP simulation: sparse client fields ${String(empty)} preserve untouched non-empty rosters`, async (t) => {
    const f = await harness(t);
    const form = await f.open();
    const fields = { ad_review_off_duty: ['模拟乙'], reason: '晚班' };
    if (empty !== undefined) {
      fields.ad_game_off_duty = empty;
      fields.ad_emergency_off_duty = empty;
    }
    assert.equal((await f.submit(form, fields)).body.toast.type, 'success');
    assert.deepEqual((await f.snapshot()).map((s) => s.off_duty), [['模拟乙'], ['模拟甲'], ['模拟甲']]);
    assert.equal(f.commits(), 1);
  });
}

test('HTTP simulation: screenshot-shaped submission from three initially empty rosters succeeds', async (t) => {
  const f = await harness(t);
  const states = await f.snapshot();
  await f.memory.updateAdRosterStatuses({ dayKey: f.dayKey, confirmationOperationId: 'empty-seed', submissionHash: 'empty-seed', confirmedBy: 'ou_local_simulation',
    updates: states.map((s) => ({ scope: s.scope, offDuty: [], expectedVersion: s.version, expectedRosterRevision: s.roster_revision })) });
  const form = await f.open();
  const fields = { ad_review_off_duty: ['模拟乙'], reason: '晚班' };
  const response = await f.submit(form, fields);
  assert.equal(response.body.toast.type, 'success');
  assert.deepEqual((await f.snapshot()).map((s) => s.off_duty), [['模拟乙'], [], []]);
});

test('HTTP simulation: explicit all-on-duty value clears only its bound scope', async (t) => {
  const f = await harness(t);
  const response = await f.submit(await f.open(), { ad_game_off_duty: ['__BESS_ALL_ON_DUTY_V1__'] });
  assert.equal(response.body.toast.type, 'success');
  assert.deepEqual((await f.snapshot()).map((s) => s.off_duty), [['模拟甲'], [], ['模拟甲']]);
});
