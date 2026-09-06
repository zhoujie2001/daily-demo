import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import handler, { createDispatchSendHandler } from '../api/dispatch/send.js';
import {
  batchDispatchActionValue,
  canonicalJson,
  dispatchActionValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  shouldSkipLocalPromoDispatch,
} from '../lib/dispatch/ingest.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../lib/lark/card-renderer.js';

const SECRET = 'dispatch-ingest-test-secret';
const NOW = Math.floor(Date.now() / 1000);
const localBody = {
  chat_id: 'oc_99cb9239c03701fe263b870cc26a825c',
  request_id: '715430', request_name: '本地新增需求', business_type: '本地推', target_category: 'local_promo',
  card_title: '【本地推】新增回扫需求', time_segment: 'E', sheet_url: 'https://example.feishu.cn/sheets/token',
  sheet_id: 'sheetA', row_index: 89, assignee_field_id: 'J', assignee_field_name: '执行人',
};

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
}

async function invoke(body, { timestamp = NOW, signed = true, targetHandler = handler } = {}) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await targetHandler({
    method: 'POST', body,
    headers: { 'x-bess-timestamp': String(timestamp), 'x-bess-signature': signed ? `sha256=${signature(body, timestamp)}` : 'bad' },
  }, response);
  return result;
}

function createMemoryIngestStore() {
  const rows = new Map();
  return {
    async claimIngestBatch({ chatId, batchId, fingerprint }) {
      const key = `${chatId}:${batchId}`;
      const row = rows.get(key);
      if (!row) { rows.set(key, { fingerprint, status: 'SENDING' }); return { outcome: 'CLAIMED' }; }
      if (row.fingerprint !== fingerprint) return { outcome: 'CONFLICT' };
      return { outcome: row.status === 'SENT' ? 'COMPLETE' : 'IN_FLIGHT', message_id: row.messageId || '' };
    },
    async completeIngestBatch({ chatId, batchId, fingerprint, messageId }) {
      rows.set(`${chatId}:${batchId}`, { fingerprint, status: 'SENT', messageId });
    },
  };
}

test('接入参数强制绑定群聊与业务类型', () => {
  assert.throws(() => normalizeDispatchIngest({ ...localBody, business_type: '千川', target_category: 'qianchuan' }), (error) => error.code === 'BINDING_MISMATCH');
  assert.throws(() => normalizeDispatchIngest({ ...localBody, chat_id: 'oc_unknown' }), (error) => error.code === 'FORBIDDEN_CHAT');
});

test('仅本地推群过滤指定拒绝理由，团购价值观需求正常派单', () => {
  const blockedReasons = [
    '涉及保证产品/服务效果',
    '投资类:未显著标明“投资有风险”提示语',
    '【团购】其他有违客观事实的虚假内容',
  ];
  for (const reason of blockedReasons) {
    assert.equal(shouldSkipLocalPromoDispatch(localBody.chat_id, { reject_reason: `前缀 ${reason} 后缀` }), true);
  }
  assert.equal(shouldSkipLocalPromoDispatch(localBody.chat_id, { reject_reason: '【团购】有违社会主流价值观的内容' }), false);
  assert.equal(shouldSkipLocalPromoDispatch('oc_2ecc53a432a03f6f81f6a18babe8cda1', { reject_reason: blockedReasons[0] }), false);
});

test('本地推批次跳过命中拒绝理由的需求且全部命中时不发卡', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_reject_reason',
    card_title: '【本地推】E 段自动派单',
    time_segment: 'E',
    items: [
      { ...localBody, request_id: 'blocked_1', reject_reason: '涉及保证产品/服务效果' },
      { ...localBody, request_id: 'allowed_1', reject_reason: '【团购】有违社会主流价值观的内容' },
    ],
  };
  const sentCards = [];
  const client = {
    async sendMessage(payload) {
      sentCards.push(payload);
      return { message_id: 'om_filtered_batch' };
    },
  };
  const targetHandler = createDispatchSendHandler({ client, storeFactory: () => createMemoryIngestStore() });
  const partial = await invoke(body, { targetHandler });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body.request_ids, ['allowed_1']);
  assert.deepEqual(partial.body.skipped_request_ids, ['blocked_1']);
  assert.doesNotMatch(JSON.stringify(sentCards[0].content), /blocked_1/);
  assert.match(JSON.stringify(sentCards[0].content), /allowed_1/);

  sentCards.length = 0;
  const allBlocked = await invoke({
    ...body,
    batch_id: 'batch_all_rejected',
    items: [{ ...localBody, request_id: 'blocked_2', reject_reason: '【团购】其他有违客观事实的虚假内容' }],
  }, { targetHandler });
  assert.equal(allBlocked.status, 200);
  assert.equal(allBlocked.body.skipped, true);
  assert.deepEqual(allBlocked.body.skipped_request_ids, ['blocked_2']);
  assert.equal(sentCards.length, 0);
});

test('主监控群允许多业务类型，但必须显式提供工作表', () => {
  const mainChatId = 'oc_aa1602f07bf35a5fdfd289aff67025a4';
  const qianchuan = normalizeDispatchIngest({
    ...localBody,
    chat_id: mainChatId,
    business_type: '千川',
    target_category: 'qianchuan',
    sheet_id: 'TQuzLA',
  });
  assert.equal(qianchuan.fields.businessType, '千川');
  assert.equal(qianchuan.fields.targetCategory, 'qianchuan');

  const stock = normalizeDispatchIngest({
    ...localBody,
    chat_id: mainChatId,
    business_type: '存量',
    target_category: 'stock',
    sheet_id: 'StockSheet',
  });
  assert.equal(stock.fields.businessType, '存量');
  assert.equal(stock.fields.targetCategory, 'stock');

  assert.throws(
    () => normalizeDispatchIngest({ ...localBody, chat_id: mainChatId, sheet_id: undefined }),
    (error) => error.code === 'INVALID_SHEET_TARGET',
  );
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

  const explicitSheetId = normalizeDispatchIngest({
    ...localBody, sheet_id: 'runtime-sheet-id',
  }).fields;
  assert.equal(explicitSheetId.projectFieldId, 'C');
  assert.equal(explicitSheetId.projectFieldName, '项目');
  assert.equal(explicitSheetId.projectValue, '本地');
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
    time_segment: 'E',
    window_start: '2026-09-01 16:00:00',
    window_end: '2026-09-01 17:00:00',
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

test('batch dispatch card contains one callback button with batch_id and all items', () => {
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_715430',
    card_title: '【本地推】E 段自动派单',
    time_segment: 'E',
    window_start: '2026-09-01 16:00:00',
    window_end: '2026-09-01 17:00:00',
    items: [
      localBody,
      { ...localBody, request_id: '715431', request_name: '本地新增需求 2', row_index: 90 },
    ],
  };
  const { fieldsList, cardTitle, batchId, period } = normalizeBatchDispatchIngest(body);
  const card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), { cardTitle, batchId, period });
  assert.equal(card.header.title.content, '【本地推】E 段新增 2 条｜批量自动派单（2026-09-01 16:00:00 ~ 2026-09-01 17:00:00 CST）');
  const buttons = card.body.elements.filter((element) => element.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].element_id, 'batch_batch_715430');
  assert.equal(buttons[0].behaviors[0].value.action, 'bess_batch_auto_dispatch');
  assert.equal(buttons[0].behaviors[0].value.batch_id, 'batch_715430');
  assert.equal(buttons[0].behaviors[0].value.items.length, 2);
  assert.match(JSON.stringify(card), /共 \*\*2\*\* 条 E 段需求/);
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


test('batch ingest 发送单按钮卡并返回 batch_id', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  process.env.LARK_APP_ID = 'cli_dispatch';
  process.env.LARK_APP_SECRET = 'secret';
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_api_1',
    card_title: '批量派单',
    items: [localBody, { ...localBody, request_id: '715432', request_name: '需求三', row_index: 91 }],
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/v3/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 });
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_batch_1' } }), { status: 200 });
  };
  try {
    const targetHandler = createDispatchSendHandler({ storeFactory: () => createMemoryIngestStore() });
    const result = await invoke(body, { targetHandler });
    assert.equal(result.status, 200);
    assert.equal(result.body.batch_id, 'batch_api_1');
    const send = calls.find((call) => call.url.includes('/im/v1/messages'));
    const payload = JSON.parse(send.options.body);
    const expectedUuid = `bess-batch-${createHash('sha256')
      .update(`${body.chat_id}:${body.batch_id}`)
      .digest('hex')
      .slice(0, 32)}`;
    assert.equal(payload.uuid, expectedUuid);
    assert.equal(payload.uuid.length, 43);
    const card = JSON.parse(payload.content);
    assert.equal(card.body.elements.filter((element) => element.tag === 'button').length, 1);
  } finally { globalThis.fetch = originalFetch; }
});


test('长 batch_id 共享相同前缀时消息 UUID 仍不碰撞', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  process.env.LARK_APP_ID = 'cli_dispatch';
  process.env.LARK_APP_SECRET = 'secret';
  const prefix = 'batch_'.padEnd(55, 'x');
  const bodies = ['first0001', 'second002'].map((suffix) => ({
    chat_id: localBody.chat_id,
    batch_id: `${prefix}${suffix}`.slice(0, 64),
    items: [localBody],
  }));
  assert.equal(bodies[0].batch_id.slice(0, 50), bodies[1].batch_id.slice(0, 50));

  const originalFetch = globalThis.fetch;
  const uuids = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/auth/v3/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 });
    uuids.push(JSON.parse(options.body).uuid);
    return new Response(JSON.stringify({ code: 0, data: { message_id: `om_${uuids.length}` } }), { status: 200 });
  };
  try {
    const store = createMemoryIngestStore();
    const targetHandler = createDispatchSendHandler({ storeFactory: () => store });
    await invoke(bodies[0], { targetHandler });
    await invoke(bodies[1], { targetHandler });
    assert.equal(uuids.length, 2);
    assert.notEqual(uuids[0], uuids[1]);
    assert.ok(uuids.every((uuid) => uuid.length <= 50));
  } finally { globalThis.fetch = originalFetch; }
});


test('batch send 持久化门禁阻止并发重复发送并拒绝需求集合冲突', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const store = createMemoryIngestStore();
  let resolveSend;
  let sends = 0;
  const client = {
    async sendMessage() {
      sends += 1;
      await new Promise((resolve) => { resolveSend = resolve; });
      return { message_id: 'om_once' };
    },
  };
  const targetHandler = createDispatchSendHandler({ client, storeFactory: () => store });
  const body = {
    chat_id: localBody.chat_id, batch_id: 'batch_gate',
    items: [localBody, { ...localBody, request_id: '715499', row_index: 99 }],
  };
  const firstPromise = invoke(body, { targetHandler });
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await invoke(body, { targetHandler });
  assert.equal(concurrent.status, 202);
  assert.equal(sends, 1);
  resolveSend();
  const first = await firstPromise;
  assert.equal(first.status, 200);

  const replay = await invoke(body, { targetHandler });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reused, true);
  assert.equal(sends, 1);

  const conflict = await invoke({
    ...body, items: [{ ...localBody, request_id: 'different', row_index: 101 }],
  }, { targetHandler });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error_code, 'BATCH_ID_CONFLICT');
  assert.equal(sends, 1);
});


test('dedicated business chats reject missing or conflicting time segments', () => {
  const missing = {
    chat_id: localBody.chat_id,
    card_title: '本地推复盘线上化批量自动派单',
    items: [{ ...localBody, time_segment: undefined }],
  };
  assert.throws(
    () => normalizeBatchDispatchIngest(missing),
    (error) => error.code === 'MISSING_TIME_SEGMENT',
  );

  const conflicting = {
    chat_id: localBody.chat_id,
    card_title: '本地推复盘线上化 D 段批量自动派单',
    time_segment: 'E',
    items: [localBody],
  };
  assert.throws(
    () => normalizeBatchDispatchIngest(conflicting),
    (error) => error.code === 'TIME_SEGMENT_CONFLICT',
  );
});
