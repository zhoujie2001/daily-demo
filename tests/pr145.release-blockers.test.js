import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../lib/dispatch/ingest.js';
import { createDispatchSendHandler } from '../lib/dispatch/api/send.js';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { createDispatchStatusBatchHandler } from '../lib/dispatch/api/status-batch.js';
import { dispatchChunkBatchId } from '../lib/dispatch/card-chunks.js';
import { dispatchOperationId } from '../lib/dispatch/operation.js';
import { createDispatchStatusCache } from '../lib/dispatch/status-cache.js';

const secret = 'local-mock-only-pr145-release-review';
const chatId = 'oc_99cb9239c03701fe263b870cc26a825c';
process.env.BESS_DISPATCH_INGEST_SECRET = secret;
process.env.LARK_APP_ID = 'mock';
process.env.LARK_APP_SECRET = 'mock';
async function invoke(handler, body) {
  const result = { headers: {} };
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
  const response = {
    setHeader(k, v) { result.headers[k] = v; },
    status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; },
  };
  await handler({ method: 'POST', body, headers: {
    'x-bess-timestamp': String(timestamp), 'x-bess-signature': `sha256=${signature}`,
  } }, response);
  return result;
}
function cacheFixture() {
  const rows = new Map();
  return {
    rows,
    async get({ chatId, batchId }) { return rows.get(`${chatId}:${batchId}`) || null; },
    async set({ chatId, batchId, value }) { rows.set(`${chatId}:${batchId}`, structuredClone(value)); return true; },
  };
}
function sentChildren(root) {
  return [1, 2].map((i) => {
    const batchId = dispatchChunkBatchId(root, i, 2);
    return { chat_id: chatId, batch_id: batchId, found: true, status: 'SENT',
      operation_id: dispatchOperationId(chatId, batchId), message_id: `om_child_${i}`, request_ids: [`r${i}`] };
  });
}

for (const entrypoint of ['send', 'automation-send']) {
for (const cacheMode of ['warm', 'cold', 'worker-race']) {
test(`release gate: ${entrypoint} preserves split receipts (${cacheMode})`, async () => {
  const root = 'local_mock_sent_replay';
  const cache = cacheFixture();
  const children = sentChildren(root);
  if (cacheMode === 'warm') {
    for (const row of children) await cache.set({ chatId, batchId: row.batch_id, value: row });
  }
  const store = {
    async reserveDispatchIngestRoot() { return { outcome: 'REUSED' }; },
    async registerDispatchHandoff({ operationId, batchId }) {
      if (cacheMode === 'worker-race') {
        const receipt = children.find((row) => row.batch_id === batchId);
        await cache.set({ chatId, batchId, value: receipt });
      }
      return { outcome: 'REUSED', status: cacheMode === 'worker-race' ? 'QUEUED' : 'SENT', operation_id: operationId };
    },
    async getIngestBatchStatus({ batchId }) { return children.find((row) => row.batch_id === batchId) || { found: false }; },
  };
  const body = { chat_id: chatId, batch_id: root, card_title: 'local mock only', time_segment: 'E',
    items: Array.from({ length: 21 }, (_, i) => ({
      request_id: `r${i + 1}`, request_name: 'local mock', business_type: '本地推', target_category: 'local_promo',
      created_at: '2026-10-23 12:00:00', creator: 'mock', sheet_url: 'https://example.feishu.cn/sheets/mock',
      sheet_id: 'sheetA', row_index: i + 2, assignee_field_id: 'J', assignee_field_name: '执行人',
    })) };
  const options = { secret, storeFactory: () => store, statusCache: cache,
    publishDispatch: async () => { throw new Error('must never publish an already SENT batch'); }, defer() {} };
  const send = entrypoint === 'send' ? createDispatchSendHandler(options) : createAutomationSendHandler(options);
  const replay = await invoke(send, entrypoint === 'send' ? body : {
    automation_token: secret, dispatch_payload: body,
  });
  assert.equal(replay.status, cacheMode === 'worker-race' ? 202 : 200);
  const status = createDispatchStatusHandler({ storeFactory: () => store, statusCache: cache, defer() {} });
  const receipt = await invoke(status, { chat_id: chatId, batch_id: children[0].batch_id });
  assert.equal(receipt.body.message_id, 'om_child_1');
});
}
}

test('release gate: batch status must aggregate SENT children and not poison root single-status cache', async () => {
  const root = 'local_mock_batch_status';
  const children = sentChildren(root);
  const cache = cacheFixture();
  const store = {
    async getIngestBatchStatus() { return { found: false }; },
    async getIngestBatchStatuses(targets) { return targets.map(({ batchId }) =>
      children.find((row) => row.batch_id === batchId) || { chat_id: chatId, batch_id: batchId, found: false }); },
  };
  const single = createDispatchStatusHandler({ storeFactory: () => store, statusCache: cache, defer() {} });
  const before = await invoke(single, { chat_id: chatId, batch_id: root });
  assert.equal(before.body.status, 'SENT');
  const batch = createDispatchStatusBatchHandler({ storeFactory: () => store, statusCache: cache });
  const bulk = await invoke(batch, { items: [{ chat_id: chatId, batch_id: root }] });
  const after = await invoke(single, { chat_id: chatId, batch_id: root });
  assert.equal(bulk.body.items[0].status, 'SENT');
  assert.equal(after.body.status, 'SENT');
  assert.deepEqual(bulk.body.items[0].message_ids, ['om_child_1', 'om_child_2']);
  assert.deepEqual(bulk.body.items[0].operation_ids, children.map((row) => row.operation_id));
});

for (const secondState of ['PROCESSING', 'NOT_FOUND', 'DEAD', 'SENT_NO_RECEIPT']) {
test(`release gate: partial split ${secondState} stays consistent across query APIs`, async () => {
  const root = `local_mock_${secondState}`;
  let children = sentChildren(root);
  children[1] = { ...children[1], status: secondState === 'SENT_NO_RECEIPT' ? 'SENT' : secondState,
    found: secondState !== 'NOT_FOUND', message_id: '', retryable: false, error_code: secondState === 'DEAD' ? 'LARK_API_230099' : '' };
  const cache = cacheFixture();
  const store = {
    async getIngestBatchStatus() { return { found: false }; },
    async getIngestBatchStatuses(targets) { return targets.map(({ chatId, batchId }) =>
      children.find((row) => row.chat_id === chatId && row.batch_id === batchId) || { chat_id: chatId, batch_id: batchId, found: false }); },
  };
  const options = { storeFactory: () => store, statusCache: cache, defer() {} };
  const bulk = await invoke(createDispatchStatusBatchHandler(options), { items: [{ chat_id: chatId, batch_id: root }] });
  const one = await invoke(createDispatchStatusHandler(options), { chat_id: chatId, batch_id: root });
  const expected = secondState === 'DEAD' ? 'FAILED' : 'SENDING';
  assert.equal(bulk.body.items[0].status, expected);
  assert.equal(one.body.status, expected);
  assert.equal(cache.rows.has(`${chatId}:${root}`), false, 'must not cache partial/failed aggregates');
  children = sentChildren(root);
  const completed = await invoke(createDispatchStatusBatchHandler(options), { items: [{ chat_id: chatId, batch_id: root }] });
  assert.equal(completed.body.items[0].status, 'SENT', 'new receipt must not wait for a pending cache TTL');
});
}

test('release gate: absent root is NOT_FOUND and never cached as queue acceptance', async () => {
  const cache = cacheFixture();
  const store = {
    async getIngestBatchStatus() { return { found: false }; },
    async getIngestBatchStatuses() { return []; },
  };
  const options = { statusCache: cache, storeFactory: () => store, defer() {} };
  const body = { chat_id: chatId, batch_id: 'never_accepted_mock' };
  const bulk = await invoke(createDispatchStatusBatchHandler(options), { items: [body] });
  assert.equal(bulk.body.items[0].status, 'NOT_FOUND');
  assert.equal(bulk.body.items[0].found, false);
  assert.equal(cache.rows.size, 0);
  const one = await invoke(createDispatchStatusHandler(options), body);
  assert.equal(one.body.status, 'NOT_FOUND');
});

test('release gate: equal root batch IDs in different chats never share child receipts', async () => {
  const root = 'same_root_different_chat_mock';
  const children = sentChildren(root);
  const otherChat = 'oc_other_mock';
  const store = {
    async getIngestBatchStatuses(targets) { return targets.map(({ chatId, batchId }) =>
      children.find((row) => row.chat_id === chatId && row.batch_id === batchId) || { chat_id: chatId, batch_id: batchId, found: false }); },
  };
  const result = await invoke(createDispatchStatusBatchHandler({ storeFactory: () => store, statusCache: cacheFixture() }), {
    items: [{ chat_id: chatId, batch_id: root }, { chat_id: otherChat, batch_id: root }],
  });
  assert.equal(result.body.items[0].status, 'SENT');
  assert.equal(result.body.items[1].status, 'NOT_FOUND');
  assert.equal(result.body.items[1].message_id, undefined);
});

test('release gate: incomplete SENT cache is rejected on both read and write', async () => {
  let writes = 0;
  const cache = createDispatchStatusCache({
    cache: { async get() { return { found: true, status: 'SENT', operation_id: 'mock' }; }, async set() { writes += 1; } },
    logger: { info() {}, warn() {} },
  });
  assert.equal(await cache.get({ chatId, batchId: 'mock' }), null);
  assert.equal(await cache.set({ chatId, batchId: 'mock', value: { status: 'SENT' } }), false);
  assert.equal(writes, 0);
});
