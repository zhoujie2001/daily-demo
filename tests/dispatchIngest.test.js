import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/dispatch/send.js';
import { canonicalJson, normalizeDispatchIngest } from '../lib/dispatch/ingest.js';
import { buildInitialDispatchCard } from '../lib/lark/card-renderer.js';

const SECRET = 'dispatch-ingest-test-secret';
const NOW = Math.floor(Date.now() / 1000);
const localBody = {
  chat_id: 'oc_99cb9239c03701fe263b870cc26a825c',
  request_id: '715430', request_name: '本地新增需求', business_type: '本地推', target_category: 'local_promo',
  card_title: '【本地推】新增回扫需求', sheet_url: 'https://example.feishu.cn/sheets/token',
  sheet_id: 'sheetA', row_index: 89, assignee_field_id: 'J', assignee_field_name: '执行人',
};

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
}

async function invoke(body, { timestamp = NOW, signed = true } = {}) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await handler({
    method: 'POST', body,
    headers: { 'x-bess-timestamp': String(timestamp), 'x-bess-signature': signed ? `sha256=${signature(body, timestamp)}` : 'bad' },
  }, response);
  return result;
}

test('接入参数强制绑定群聊与业务类型', () => {
  assert.throws(() => normalizeDispatchIngest({ ...localBody, business_type: '千川', target_category: 'qianchuan' }), (error) => error.code === 'BINDING_MISMATCH');
  assert.throws(() => normalizeDispatchIngest({ ...localBody, chat_id: 'oc_unknown' }), (error) => error.code === 'FORBIDDEN_CHAT');
});

test('初始派单卡包含可回调按钮和完整写回参数', () => {
  const { fields } = normalizeDispatchIngest(localBody);
  const card = buildInitialDispatchCard(fields, { action: 'bess_auto_dispatch', request_id: fields.requestId });
  const text = JSON.stringify(card);
  assert.match(text, /🎯 自动派单/);
  assert.match(text, /715430/);
  assert.match(text, /bess_auto_dispatch/);
});

test('有效签名由排单buddy发送卡片并携带幂等 uuid', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  process.env.LARK_APP_ID = 'cli_dispatch';
  process.env.LARK_APP_SECRET = 'secret';
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/v3/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 });
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_ingest_1' } }), { status: 200 });
  };
  try {
    const result = await invoke(localBody);
    assert.equal(result.status, 200);
    assert.equal(result.body.message_id, 'om_ingest_1');
    const sendBody = JSON.parse(calls[1].options.body);
    assert.equal(sendBody.receive_id, localBody.chat_id);
    assert.equal(sendBody.uuid, 'bess-ingest-715430');
    assert.match(sendBody.content, /🎯 自动派单/);
  } finally { globalThis.fetch = originalFetch; }
});

test('错误签名和过期请求均拒绝且不调用飞书', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call'); };
  try {
    const invalid = await invoke(localBody, { signed: false });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.error_code, 'INVALID_SIGNATURE');
    const stale = await invoke(localBody, { timestamp: NOW - 600 });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error_code, 'STALE_REQUEST');
  } finally { globalThis.fetch = originalFetch; }
});
