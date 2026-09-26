import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { createDispatchSendHandler as _realHandlerFactory, resolveSyncWaitMs as handlerSyncResolve } from '../lib/dispatch/api/send.js';

const handler = _realHandlerFactory();
// 测试默认注入 no-op 拒绝理由回查，避免误触飞书网络；回查能力单独用真实模块测试。
const createTestHandler = (opts = {}) => _realHandlerFactory({
  enrichRejectReasons: async () => [],
  publishDispatch: async () => ({ message_id: 'q_test', deduplicated: false }),
  ...opts,
});
import {
  BESS_ADDITIONAL_CHAT_ID,
  BESS_AD_ADDITIONAL_CHAT_ID,
  LOCAL_PROMO_BLOCKED_REJECT_REASONS,
  TEST_DISPATCH_CHAT_ID,
  auditLocalPromoRejectReasons,
  batchDispatchActionValue,
  canonicalJson,
  dispatchActionValue,
  hasLocalPromoRejectReasonField,
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
  card_title: '【本地推】新增回扫需求', time_segment: 'E', created_at: '2026-09-01 16:05:00', creator: '张三', sheet_url: 'https://example.feishu.cn/sheets/token',
  sheet_id: 'sheetA', row_index: 89, assignee_field_id: 'J', assignee_field_name: '执行人',
};

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
}

async function invoke(body, { timestamp = NOW, signed = true, targetHandler = handler } = {}, reqExtras = {}) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await targetHandler({
    method: 'POST', body,
    url: reqExtras.url || '/api/dispatch/send',
    headers: {
      'x-bess-timestamp': String(timestamp),
      'x-bess-signature': signed ? `sha256=${signature(body, timestamp)}` : 'bad',
      ...(reqExtras.headers || {}),
    },
  }, response);
  return result;
}

test('接入参数强制绑定群聊与业务类型', () => {
  assert.throws(() => normalizeDispatchIngest({ ...localBody, business_type: '千川', target_category: 'qianchuan' }), (error) => error.code === 'BINDING_MISMATCH');
  assert.throws(() => normalizeDispatchIngest({ ...localBody, chat_id: 'oc_unknown' }), (error) => error.code === 'FORBIDDEN_CHAT');
});

test('测试群允许多业务派单并保留领取人字段', () => {
  const normalized = normalizeDispatchIngest({
    ...localBody,
    chat_id: TEST_DISPATCH_CHAT_ID,
    business_type: '存量',
    target_category: 'stock',
    assignee_field_id: 'N',
    assignee_field_name: '领取人',
  });
  assert.equal(normalized.chatId, TEST_DISPATCH_CHAT_ID);
  assert.equal(normalized.fields.targetCategory, 'stock');
  assert.equal(normalized.fields.assigneeFieldId, 'N');
  assert.equal(normalized.fields.assigneeFieldName, '领取人');
});

test('本地推不再按拒绝理由过滤', () => {
  const reasons = [
    '【团购】涉及保证产品/服务效果',
    '投资类：未显著标明“投资有风险”提示语',
    '【团购】其他有违客观事实的虚假内容',
    '【团购】涉及联系方式',
  ];
  for (const reason of reasons) {
    assert.equal(shouldSkipLocalPromoDispatch(localBody.chat_id, { reject_reason: reason }), false);
  }
});

test('拒绝理由审计兼容接口不再产生跳过或缺失项', () => {
  const items = [
    { request_id: '1', reject_reason: '【团购】涉及保证产品/服务效果' },
    { request_id: '2', rejectReason: '合规内容' },
    { request_id: '3' },
    { request_id: '4', reject_reason: '' },
  ];
  assert.deepEqual(auditLocalPromoRejectReasons(localBody.chat_id, items), { skipped: [], missingField: [] });
  assert.equal(hasLocalPromoRejectReasonField({ reject_reason: '' }), true);
  assert.equal(hasLocalPromoRejectReasonField({ rejectReason: null }), true);
  assert.equal(hasLocalPromoRejectReasonField({}), false);
});

test('本地推批次保留全部需求及原始顺序', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_reject_reason_disabled',
    card_title: '【本地推】E 段自动派单',
    time_segment: 'E',
    items: [
      { ...localBody, request_id: 'first', reject_reason: '【团购】涉及保证产品/服务效果' },
      { ...localBody, request_id: 'second', reject_reason: '【团购】有违社会主流价值观的内容' },
      { ...localBody, request_id: 'third' },
    ],
  };
  const published = [];
  const targetHandler = createTestHandler({
    async publishDispatch(message) { published.push(message); return { message_id: 'q_all' }; },
  });
  const response = await invoke(body, { targetHandler }, { headers: { 'x-bess-wait': 'async' } });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body.request_ids, ['first', 'second', 'third']);
  assert.deepEqual(response.body.skipped_request_ids, []);
  assert.deepEqual(published[0].request_ids, ['first', 'second', 'third']);
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

test('附加群允许千川、本地推、存量、EHC 其它及 EHC 千川/本地推', () => {
  for (const targetCategory of ['qianchuan', 'local_promo', 'stock', 'ehc_emergency_other']) {
    const businessType = targetCategory === 'qianchuan' ? '千川' : targetCategory === 'stock' ? '存量' : '本地推';
    const normalized = normalizeDispatchIngest({
      ...localBody,
      chat_id: BESS_ADDITIONAL_CHAT_ID,
      business_type: businessType,
      target_category: targetCategory,
      sheet_id: targetCategory === 'stock' ? 'StockSheet' : 'TQuzLA',
    });
    assert.equal(normalized.fields.targetCategory, targetCategory);
  }

  for (const businessType of ['千川', '本地推']) {
    const normalized = normalizeDispatchIngest({
      ...localBody,
      chat_id: BESS_ADDITIONAL_CHAT_ID,
      business_type: businessType,
      target_category: 'ehc_emergency',
      sheet_id: 'TQuzLA',
    });
    assert.equal(normalized.fields.businessType, businessType);
  }

  for (const [targetCategory, businessType] of [
    ['qianchuan_ad', 'AD'],
    ['ehc_emergency_ad', 'AD'],
    ['ehc_emergency', 'AD'],
  ]) {
    assert.throws(
      () => normalizeDispatchIngest({
        ...localBody,
        chat_id: BESS_ADDITIONAL_CHAT_ID,
        business_type: businessType,
        target_category: targetCategory,
        sheet_id: 'TQuzLA',
      }),
      (error) => error.code === 'BINDING_MISMATCH',
    );
  }
});

test('AD 附加群只允许 AD 分类写入 AD 应急表', () => {
  for (const targetCategory of ['qianchuan_ad', 'ehc_emergency_ad']) {
    const normalized = normalizeDispatchIngest({
      ...localBody,
      chat_id: BESS_AD_ADDITIONAL_CHAT_ID,
      business_type: 'AD',
      target_category: targetCategory,
      sheet_id: '288afd',
      date_field_id: 'A',
      date_field_name: '需求创建时间',
      assignee_field_id: 'F',
      assignee_field_name: '回扫人',
    });
    assert.equal(normalized.fields.targetCategory, targetCategory);
    assert.equal(normalized.fields.businessType, 'AD');
    assert.equal(normalized.fields.sheetId, '288afd');
    assert.equal(normalized.fields.dateFieldId, 'A');
    assert.equal(normalized.fields.assigneeFieldId, 'F');
  }

  for (const [targetCategory, businessType, sheetId, dateFieldId, assigneeFieldId] of [
    ['qianchuan', '千川', 'TQuzLA'],
    ['qianchuan_ad', '千川', '288afd'],
    ['ehc_emergency_ad', 'AD', 'TQuzLA', 'A', 'F'],
    ['qianchuan_ad', 'AD', '288afd', 'H', 'F'],
    ['ehc_emergency_ad', 'AD', '288afd', 'A', 'J'],
  ]) {
    assert.throws(
      () => normalizeDispatchIngest({
        ...localBody,
        chat_id: BESS_AD_ADDITIONAL_CHAT_ID,
        business_type: businessType,
        target_category: targetCategory,
        sheet_id: sheetId,
        date_field_id: dateFieldId,
        assignee_field_id: assigneeFieldId,
        assignee_field_name: '回扫人',
      }),
      (error) => error.code === 'BINDING_MISMATCH',
    );
  }
});

test('初始派单卡包含可回调按钮和完整写回参数', () => {
  const { fields } = normalizeDispatchIngest(localBody);
  const card = buildInitialDispatchCard(fields, { action: 'bess_auto_dispatch', request_id: fields.requestId });
  const text = JSON.stringify(card);
  assert.match(text, /🎯 自动派单/);
  assert.match(text, /715430/);
  assert.match(text, /bess_auto_dispatch/);
  assert.match(text, /指定人员/);
  assert.match(text, /bess_specify_assignee/);
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
  assert.equal(actionValue.created_at, '2026-09-01 16:05:00');
  assert.equal(actionValue.creator, '张三');
  assert.equal(actionValue.project_field_id, 'C');
  assert.equal(actionValue.project_value, '本地');
  const explicit = normalizeDispatchIngest({
    ...localBody, project_field_id: 'E', project_field_name: '业务项目', project_value: '本地业务',
  }).fields;
  assert.deepEqual(
    [explicit.projectFieldId, explicit.projectFieldName, explicit.projectValue],
    ['E', '业务项目', '本地业务'],
  );
  const compatibility = normalizeDispatchIngest({
    ...localBody,
    created_at: '',
    created_at_raw: '2026-09-01 16:06:00',
    creator: '',
    creator_name: '李四',
  }).fields;
  assert.equal(compatibility.createdAt, '2026-09-01 16:06:00');
  assert.equal(compatibility.creator, '李四');
  const card = buildInitialDispatchCard(fields, actionValue);
  assert.match(JSON.stringify(card), /project_field_id/);

  const explicitSheetId = normalizeDispatchIngest({
    ...localBody, sheet_id: 'runtime-sheet-id',
  }).fields;
  assert.equal(explicitSheetId.projectFieldId, 'C');
  assert.equal(explicitSheetId.projectFieldName, '项目');
  assert.equal(explicitSheetId.projectValue, '本地');
});

test('单条 ingest 持久投递队列并快速返回 202', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  let queued;
  const targetHandler = createTestHandler({
    async publishDispatch(message) { queued = message; return { message_id: 'q_ingest_1' }; },
  });
  const result = await invoke(localBody, { targetHandler }, { headers: { 'x-bess-wait': 'async' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'QUEUED');
  assert.equal(result.body.queue_message_id, 'q_ingest_1');
  assert.equal(result.body.batch_id, 'single:715430');
  assert.equal(queued.chat_id, localBody.chat_id);
  assert.equal(queued.operation_id, result.body.operation_id);
  assert.match(JSON.stringify(queued.card), /🎯 自动派单/);
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
  assert.equal(buttons.length, 3);
  const specifyButtons = buttons.filter((button) => button.element_id.startsWith('spec_'));
  assert.equal(specifyButtons.length, 2);
  assert.ok(specifyButtons.every((button) => button.behaviors[0].value.action === 'bess_specify_assignee'));
  const batchButton = buttons.find((button) => button.element_id === 'batch_batch_715430');
  assert.equal(batchButton.behaviors[0].value.action, 'bess_batch_auto_dispatch');
  assert.equal(batchButton.behaviors[0].value.batch_id, 'batch_715430');
  assert.equal(batchButton.behaviors[0].value.items.length, 2);
  assert.equal(batchButton.behaviors[0].value.items[0].created_at, '2026-09-01 16:05:00');
  assert.equal(batchButton.behaviors[0].value.items[0].creator, '张三');
  assert.match(JSON.stringify(card), /共 \*\*2\*\* 条 E 段需求/);
  assert.match(JSON.stringify(card), /创建时间：2026-09-01 16:05:00/);
  assert.match(JSON.stringify(card), /创建人：张三/);
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


test('batch ingest 将单按钮卡写入队列并返回 batch_id', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  process.env.LARK_APP_ID = 'cli_dispatch';
  process.env.LARK_APP_SECRET = 'secret';
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_api_1',
    card_title: '批量派单',
    items: [localBody, { ...localBody, request_id: '715432', request_name: '需求三', row_index: 91 }],
  };
  let queued;
  const targetHandler = createTestHandler({
    async publishDispatch(message) { queued = message; return { message_id: 'q_batch_1' }; },
  });
  const result = await invoke(body, { targetHandler }, { headers: { 'x-bess-wait': 'async' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.batch_id, 'batch_api_1');
  assert.equal(result.body.queue_message_id, 'q_batch_1');
  const expectedUuid = `bess-outbox-${createHash('sha256')
    .update(`${body.chat_id}:${body.batch_id}`)
    .digest('hex')
    .slice(0, 32)}`;
  assert.equal(queued.operation_id, expectedUuid);
  assert.equal(queued.operation_id.length, 44);
  const buttons = queued.card.body.elements.filter((element) => element.tag === 'button');
  assert.equal(buttons.filter((button) => button.element_id.startsWith('spec_')).length, 2);
  assert.equal(buttons.filter((button) => button.element_id.startsWith('batch_')).length, 1);
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

  const uuids = [];
  const targetHandler = createTestHandler({
    async publishDispatch(message) {
      uuids.push(message.operation_id);
      return { message_id: `q_${uuids.length}` };
    },
  });
  await invoke(bodies[0], { targetHandler });
  await invoke(bodies[1], { targetHandler });
  assert.equal(uuids.length, 2);
  assert.notEqual(uuids[0], uuids[1]);
  assert.ok(uuids.every((uuid) => uuid.length <= 50));
});


test('batch send 并发重放使用相同 operation_id 且不直接调用 Lark', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const published = [];
  let larkSends = 0;
  const client = {
    async sendMessage() { larkSends += 1; throw new Error('must not send in request'); },
  };
  const targetHandler = createTestHandler({
    client,
    async publishDispatch(message) {
      published.push(message);
      return { message_id: published.length === 1 ? 'q_once' : '', deduplicated: published.length > 1 };
    },
  });
  const body = {
    chat_id: localBody.chat_id, batch_id: 'batch_gate',
    items: [localBody, { ...localBody, request_id: '715499', row_index: 99 }],
  };
  const [first, concurrent] = await Promise.all([
    invoke(body, { targetHandler }, { headers: { 'x-bess-wait': 'async' } }),
    invoke(body, { targetHandler }),
  ]);
  assert.equal(first.status, 202);
  assert.equal(concurrent.status, 202);
  assert.equal(first.body.operation_id, concurrent.body.operation_id);
  assert.equal(larkSends, 0);
  const replay = await invoke(body, { targetHandler });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.reused, true);
  assert.ok(published.every((message) => message.operation_id === first.body.operation_id));
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


test('send 只等待队列接受，不调用 Supabase 或 Lark', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  let larkSends = 0;
  let publishes = 0;
  const targetHandler = createTestHandler({
    client: { async sendMessage() { larkSends += 1; throw new Error('must not send'); } },
    async publishDispatch() { publishes += 1; return { message_id: 'q_fast' }; },
  });
  const startedAt = Date.now();
  const response = await invoke(
    { chat_id: localBody.chat_id, batch_id: 'batch_fast', items: [localBody] },
    { targetHandler },
    { headers: { 'x-bess-request-id': 'send-request-1' } },
  );
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'QUEUED');
  assert.equal(publishes, 1);
  assert.equal(larkSends, 0);
  assert.ok(Date.now() - startedAt < 200);
  assert.equal(response.headers['X-Bess-Request-Id'], 'send-request-1');
  assert.equal(response.headers['X-Bess-Status-Source'], 'queue');
  assert.match(response.headers['Server-Timing'], /auth;dur=/);
  assert.match(response.headers['Server-Timing'], /database;dur=/);
  assert.match(response.headers['Server-Timing'], /queue;dur=/);
  assert.match(response.headers['Server-Timing'], /cache;dur=/);
  assert.match(response.headers['Server-Timing'], /total;dur=/);
});

test('send 首次入队写入 QUEUED 热状态，幂等重放不覆盖既有终态', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const writes = [];
  let publishes = 0;
  const targetHandler = createTestHandler({
    async publishDispatch() {
      publishes += 1;
      return publishes === 1
        ? { message_id: 'q_cache_once', deduplicated: false }
        : { message_id: '', deduplicated: true };
    },
    statusCache: {
      async set(payload) { writes.push(payload); return true; },
    },
  });

  const first = await invoke(localBody, { targetHandler });
  const replay = await invoke(localBody, { targetHandler });

  assert.equal(first.status, 202);
  assert.equal(replay.body.reused, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.status, 'QUEUED');
  assert.equal(writes[0].value.found, false);
  assert.deepEqual(writes[0].value.request_ids, ['715430']);
});

test('Queue 已接受后缓存写失败仍返回 202', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const targetHandler = createTestHandler({
    async publishDispatch() { return { message_id: 'q_cache_fail', deduplicated: false }; },
    statusCache: { async set() { throw new Error('cache down'); } },
  });

  const response = await invoke(localBody, { targetHandler });
  assert.equal(response.status, 202);
  assert.equal(response.body.queue_message_id, 'q_cache_fail');
});

test('同批次队列重放返回相同 operation_id', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const messages = [];
  const targetHandler = createTestHandler({
    async publishDispatch(message) {
      messages.push(message);
      return { message_id: messages.length === 1 ? 'q_once' : '', deduplicated: messages.length > 1 };
    },
  });
  const first = await invoke(localBody, { targetHandler });
  const replay = await invoke(localBody, { targetHandler });
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.reused, true);
  assert.equal(replay.body.request_id, '715430');
  assert.equal(first.body.operation_id, replay.body.operation_id);
  assert.equal(messages[0].operation_id, messages[1].operation_id);
});

test('wait 提示不改变队列接受语义', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const targetHandler = createTestHandler({
    async publishDispatch() { return { message_id: 'q_wait_hint' }; },
  });
  const response = await invoke(localBody, { targetHandler }, { url: 'https://api/send?wait=0' });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'QUEUED');
});


test('resolveSyncWaitMs 仍解析旧信号供兼容观测，但不改变同步发送', () => {
  const mkReq = (url, headers = {}) => ({ url, headers });
  assert.equal(handlerSyncResolve(mkReq('/api/send?wait=0')), -1);
  assert.equal(handlerSyncResolve(mkReq('/api/send', { 'x-bess-wait': 'async' })), -1);
  assert.equal(handlerSyncResolve(mkReq('/api/send')), 0);
  assert.ok(handlerSyncResolve(mkReq('/api/send?wait=1')) > 0);
});


test('拒绝理由变化不会改变同批次幂等指纹或过滤需求', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const published = [];
  const targetHandler = createTestHandler({
    async publishDispatch(message) {
      published.push(message);
      return { message_id: published.length === 1 ? 'q_reason' : '', deduplicated: published.length > 1 };
    },
    async enrichRejectReasons({ items }) {
      const missing = items.filter((item) => item.request_id === 'blocked_stable' && item.reject_reason === undefined);
      for (const item of missing) item.reject_reason = '【团购】涉及保证产品/服务效果';
      return missing.map((item) => item.request_id);
    },
  });
  const baseBody = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_stable_external_reason',
    items: [
      { ...localBody, request_id: 'blocked_stable', reject_reason: undefined },
      { ...localBody, request_id: 'allowed_stable', reject_reason: '不命中过滤规则' },
    ],
  };
  const explicitBody = structuredClone(baseBody);
  explicitBody.items[0].reject_reason = '【团购】涉及保证产品/服务效果';

  const first = await invoke(structuredClone(baseBody), { targetHandler });
  const replay = await invoke(explicitBody, { targetHandler });
  assert.equal(first.status, 202);
  assert.deepEqual(first.body.skipped_request_ids, []);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.reused, true);
  assert.equal(published.length, 2);
  assert.equal(published[0].fingerprint, published[1].fingerprint);
  assert.equal(published[0].operation_id, published[1].operation_id);
});

test('派单入口不再调用拒绝理由回查', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const body = { ...localBody, batch_id: undefined };
  let enrichmentCalled = false;
  let queued = false;
  const targetHandler = createTestHandler({
    enrichmentTimeoutMs: 5,
    async enrichRejectReasons() {
      enrichmentCalled = true;
      throw new Error('不应调用');
    },
    async publishDispatch() { queued = true; return { message_id: 'q_no_lookup' }; },
  });

  const response = await invoke(body, { targetHandler });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'QUEUED');
  assert.equal(enrichmentCalled, false);
  assert.equal(queued, true);
});

test('队列发布超时时返回可安全重试的未知接受状态', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const deferred = [];
  const targetHandler = createTestHandler({
    defer(promise) { deferred.push(promise); },
    publishTimeoutMs: 5,
    async publishDispatch() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { message_id: 'q_late' };
    },
  });

  const response = await invoke(localBody, { targetHandler });
  assert.equal(response.status, 503);
  assert.equal(response.body.accepted_unknown, true);
  assert.equal(response.body.status, 'QUEUING');
  assert.equal(response.body.error_code, 'DISPATCH_QUEUE_TIMEOUT');
  assert.ok(response.body.operation_id);
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
});

test('队列发布明确失败时返回 503 且不谎报已接受', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const targetHandler = createTestHandler({
    async publishDispatch() {
      throw Object.assign(new Error('queue unavailable'), { code: 'DISPATCH_QUEUE_UNAVAILABLE', status: 503 });
    },
  });

  const response = await invoke(localBody, { targetHandler });
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error_code, 'DISPATCH_QUEUE_UNAVAILABLE');
  assert.equal(response.body.accepted_unknown, undefined);
});

test('原部分过滤批次现在按原顺序全部入队', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const body = {
    chat_id: localBody.chat_id,
    batch_id: 'batch_partial_inflight',
    items: [
      { ...localBody, request_id: 'blocked_inflight', reject_reason: '【团购】涉及保证产品/服务效果' },
      { ...localBody, request_id: 'allowed_inflight', reject_reason: '不命中过滤规则' },
    ],
  };
  let queued;
  const targetHandler = createTestHandler({ async publishDispatch(message) { queued = message; return { message_id: 'q_partial' }; } });

  const response = await invoke(body, { targetHandler });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'QUEUED');
  assert.deepEqual(response.body.request_ids, ['blocked_inflight', 'allowed_inflight']);
  assert.deepEqual(response.body.skipped_request_ids, []);
  assert.deepEqual(queued.request_ids, ['blocked_inflight', 'allowed_inflight']);
});
