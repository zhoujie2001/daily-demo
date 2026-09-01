import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/dispatch/revoke.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';

const SECRET = 'dispatch-ingest-test-secret';

function response() {
  let statusCode = 200;
  let payload;
  return {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
    result() { return { statusCode, payload }; },
  };
}

function signedRequest(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
  return { method: 'POST', body, headers: { 'x-bess-timestamp': timestamp, 'x-bess-signature': signature } };
}

test('dispatch revoke 使用原 bot token 批量撤回消息', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const calls = [];
  process.env.LARK_APP_ID = 'cli_test';
  process.env.LARK_APP_SECRET = 'secret';
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0 }); } };
  };
  try {
    const body = { message_ids: ['om_aaa', 'om_bbb'] };
    const res = response();
    await handler(signedRequest(body), res);
    assert.deepEqual(res.result(), { statusCode: 200, payload: { ok: true, revoked_message_ids: body.message_ids } });
    assert.deepEqual(calls.slice(1).map((call) => [call.options.method, call.url.split('/').at(-1)]), [['DELETE', 'om_aaa'], ['DELETE', 'om_bbb']]);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('dispatch revoke 拒绝无效 message_id', async () => {
  const original = process.env.BESS_DISPATCH_INGEST_SECRET;
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  try {
    const res = response();
    await handler(signedRequest({ message_ids: ['bad-id'] }), res);
    assert.deepEqual(res.result(), { statusCode: 400, payload: { ok: false, error_code: 'INVALID_MESSAGE_IDS' } });
  } finally {
    if (original === undefined) delete process.env.BESS_DISPATCH_INGEST_SECRET;
    else process.env.BESS_DISPATCH_INGEST_SECRET = original;
  }
});
