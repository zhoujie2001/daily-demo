import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/dispatch/send.js';
import { canonicalJson, dispatchActionValue, normalizeBatchDispatchIngest, normalizeDispatchIngest } from '../lib/dispatch/ingest.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../lib/lark/card-renderer.js';

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

test('外部 ingest 缺省千川本地表字段并在 action.value 携带项目过滤配置', () => {
  const { fields } = normalizeDispatchIngest({ ...localBody, sheet_id: undefined });
  assert.equal(fields.dateFieldId, 'H');
  assert.equal(fields.dateFieldName, '提需时间');
  assert.equal(fields.sheetId, 'TQuzLA');
  assert.equal(fields.projectFieldId, 'C');
  assert.equal(fields.projectFieldName, '项目');
  assert.equal(fields.projectValue, '本地');
  const actionValue = dispatchActionValue(fields);
  assert.equal(actionValue.project_field_id, 'C');
  assert.equal(actionValue.project_value, '本地');
  const explicit = normalizeDispatchIngest({
    ...localBody, project_field_id: 'E', project_field_name: '业务项目', project_value: '本地业务',
  }).fields;
  assert.deepEqual(
    [explicit.projectFieldId, explicit.projectFieldName, explicit.projectValue],
    ['E', '业务项目', '本地业务'],
  );
  const card = buildInitialDispatchCard(fields, actionValue);
  assert.match(JSON.stringify(card), /project_field_id/);
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


test('batch ingest normalizes multiple unique requests for one allowed chat', () => {
  const body = {
    chat_id: localBody.chat_id,
    card_title: '【本地推】E 段自动派单',
    items: [
      localBody,
      { ...localBody, request_id: '715431', request_name: '本地新增需求 2', row_index: 90 },
    ],
  };
  const normalized = normalizeBatchDispatchIngest(body);
  assert.equal(normalized.chatId, localBody.chat_id);
  assert.equal(normalized.fieldsList.length, 2);
  assert.equal(normalized.fieldsList[0].batchCard, true);
  assert.equal(dispatchActionValue(normalized.fieldsList[0]).batch_card, true);
});

test('batch dispatch card contains one independent callback button per request', () => {
  const body = {
    chat_id: localBody.chat_id,
    card_title: '【本地推】E 段自动派单',
    items: [
      localBody,
      { ...localBody, request_id: '715431', request_name: '本地新增需求 2', row_index: 90 },
    ],
  };
  const { fieldsList, cardTitle } = normalizeBatchDispatchIngest(body);
  const card = buildBatchDispatchCard(fieldsList, fieldsList.map(dispatchActionValue), { cardTitle });
  assert.equal(card.header.title.content, '【本地推】E 段自动派单');
  const serialized = JSON.stringify(card);
  assert.match(serialized, /dsp_715430/);
  assert.match(serialized, /dsp_715431/);
  assert.match(serialized, /共 \*\*2\*\* 条 E 段需求/);
});

test('batch ingest rejects duplicate request ids', () => {
  assert.throws(
    () => normalizeBatchDispatchIngest({
      chat_id: localBody.chat_id,
      items: [localBody, { ...localBody }],
    }),
    (error) => error.code === 'DUPLICATE_REQUEST_ID',
  );
});
