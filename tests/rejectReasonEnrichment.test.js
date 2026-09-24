import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichLocalPromoRejectReasons } from '../lib/dispatch/reject-reason-enrichment.js';
import { createDispatchSendHandler } from '../lib/dispatch/api/send.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';
import { createHmac } from 'node:crypto';

const LOCAL_CHAT = 'oc_99cb9239c03701fe263b870cc26a825c';
const SECRET = 'enrich-test-secret';
const NOW = Math.floor(Date.now() / 1000);

function baseItem(overrides = {}) {
  return {
    request_id: '760104',
    request_name: '本地新增需求',
    business_type: '本地推',
    target_category: 'local_promo',
    time_segment: 'E',
    created_at: '2026-09-15 16:05:00',
    creator: '测试人',
    sheet_url: 'https://feishu.cn/sheets/tok',
    sheet_id: 'sheetA',
    row_index: 89,
    ...overrides,
  };
}

function createFakeClient(valuesByRow) {
  const calls = { resolve: [], getValues: 0 };
  return {
    calls,
    async getTenantAccessToken() { return 't'; },
    async resolveSheetColumn({ fieldName }) {
      calls.resolve.push(fieldName);
      return 'J';
    },
    async getSheetValues({ range }) {
      calls.getValues += 1;
      calls.range = range;
      // 返回从第 89 行开始的值
      return [valuesByRow];
    },
  };
}

test('漏传字段时回查台账并补写 reject_reason', async () => {
  const item = baseItem();
  const client = createFakeClient(['投资类：未显著标明“投资有风险”提示语']);
  const enriched = await enrichLocalPromoRejectReasons({ chatId: LOCAL_CHAT, items: [item], client });
  assert.deepEqual(enriched, ['760104']);
  assert.equal(item.reject_reason, '投资类：未显著标明“投资有风险”提示语');
  assert.equal(client.calls.range, 'sheetA!J89:J89');
});

test('已有非空字段不回查，空串会回查并覆盖', async () => {
  const items = [
    baseItem({ request_id: 'a', reject_reason: '已有' }),
    baseItem({ request_id: 'b', reject_reason: '' }),
  ];
  const client = createFakeClient(['【团购】其它有违客观事实的虚假内容']);
  const enriched = await enrichLocalPromoRejectReasons({ chatId: LOCAL_CHAT, items, client });
  assert.deepEqual(enriched, ['b']);
  assert.equal(client.calls.getValues, 1);
  assert.equal(items[1].reject_reason, '【团购】其它有违客观事实的虚假内容');
});

test('飞书富文本对象数组会被规范化为拒绝理由文本', async () => {
  const item = baseItem();
  const client = createFakeClient([{ type: 'text', text: '【团购】涉及保证产品/服务效果' }]);
  const enriched = await enrichLocalPromoRejectReasons({ chatId: LOCAL_CHAT, items: [item], client });
  assert.deepEqual(enriched, ['760104']);
  assert.equal(item.reject_reason, '【团购】涉及保证产品/服务效果');
});

test('非本地推群不回查', async () => {
  const item = baseItem();
  const client = createFakeClient(['x']);
  const enriched = await enrichLocalPromoRejectReasons({ chatId: 'oc_other', items: [item], client });
  assert.deepEqual(enriched, []);
  assert.equal(item.reject_reason, undefined);
});

test('回查失败 fail-closed，阻断派单并返回可重试错误', async () => {
  const item = baseItem();
  const client = {
    async getTenantAccessToken() { return 't'; },
    async resolveSheetColumn() { throw Object.assign(new Error('api'), { code: 'LARK_999' }); },
  };
  const logs = [];
  await assert.rejects(
    enrichLocalPromoRejectReasons({
      chatId: LOCAL_CHAT, items: [item], client,
      log: (level, stage, fields) => logs.push({ level, stage, fields }),
    }),
    (error) => error.code === 'REJECT_REASON_LOOKUP_FAILED' && error.status === 503,
  );
  assert.equal(item.reject_reason, undefined);
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].stage, 'local_promo_reject_reason_lookup_failed');
});

// ── 端到端：生产派单不再执行拒绝理由回查或过滤 ─────────────────────────
function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
}

test('端到端：/send 保留全部需求并跳过拒绝理由回查', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const fakeClient = createFakeClient(['【团购】涉及保证产品/服务效果']);
  let queued;
  const targetHandler = createDispatchSendHandler({
    client: fakeClient,
    async publishDispatch(message) { queued = message; return { message_id: 'q_dispatch' }; },
  });
  const body = {
    chat_id: LOCAL_CHAT,
    batch_id: 'batch_no_reject_filter',
    card_title: '批量派单',
    time_segment: 'E',
    items: [
      baseItem({ request_id: '760104', reject_reason: '【团购】涉及保证产品/服务效果' }),
      baseItem({ request_id: '760105', reject_reason: '' }),
    ],
  };
  const result = { headers: {} };
  const response = {
    setHeader() {},
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await targetHandler({
    method: 'POST', body, url: '/api/send',
    headers: {
      'x-bess-timestamp': String(NOW),
      'x-bess-signature': `sha256=${signature(body)}`,
    },
  }, response);

  assert.equal(result.status, 202);
  assert.deepEqual(result.body.request_ids, ['760104', '760105']);
  assert.deepEqual(result.body.skipped_request_ids, []);
  assert.equal(fakeClient.calls.getValues, 0);
  assert.equal(queued.kind, 'dispatch');
  assert.deepEqual(queued.request_ids, ['760104', '760105']);
});
