import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createDispatchSendHandler } from '../lib/dispatch/api/send.js';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { createDispatchStatusBatchHandler } from '../lib/dispatch/api/status-batch.js';
import {
  AD_DISPATCH_CHAT_ID, canonicalJson, normalizeBatchDispatchIngest,
} from '../lib/dispatch/ingest.js';
import { dispatchOperationId } from '../lib/dispatch/operation.js';

const SECRET = 'isolated-batch-capacity-test-secret';
const previousSecret = process.env.BESS_DISPATCH_INGEST_SECRET;
before(() => { process.env.BESS_DISPATCH_INGEST_SECRET = SECRET; });
after(() => {
  if (previousSecret === undefined) delete process.env.BESS_DISPATCH_INGEST_SECRET;
  else process.env.BESS_DISPATCH_INGEST_SECRET = previousSecret;
});

const profiles = {
  ad: {
    chat_id: AD_DISPATCH_CHAT_ID, business_type: 'AD', target_category: 'ad',
    dispatch_profile: 'ad', assignee_field_id: 'B', assignee_field_name: '姓名',
    date_field_id: 'J',
  },
  qianchuan: {
    chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1',
    business_type: '千川', target_category: 'qianchuan',
    assignee_field_id: 'J', assignee_field_name: '执行人',
  },
  local: {
    chat_id: 'oc_99cb9239c03701fe263b870cc26a825c',
    business_type: '本地推', target_category: 'local_promo',
    assignee_field_id: 'J', assignee_field_name: '执行人',
  },
};

function payload(count, { batchId = `capacity_${count}`, profile = 'ad' } = {}) {
  return {
    chat_id: profiles[profile].chat_id, batch_id: batchId,
    card_title: '隔离批次容量测试', time_segment: 'D',
    items: Array.from({ length: count }, (_, index) => ({
      ...profiles[profile], request_id: `capacity_${index + 1}`,
      request_name: `隔离需求 ${index + 1}`, created_at: '2026-10-26 12:30:00',
      sheet_url: 'https://example.feishu.cn/sheets/isolated', sheet_id: 'sheetA',
      row_index: 14952 + index, reject_reason: '隔离测试',
    })),
  };
}

function headers(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'x-bess-timestamp': timestamp,
    'x-bess-signature': `sha256=${createHmac('sha256', SECRET)
      .update(`${timestamp}.${canonicalJson(body)}`).digest('hex')}`,
  };
}

async function invoke(handler, body, { signed = true } = {}) {
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return res; },
    json(value) { result.body = value; return res; },
  };
  await handler({ method: 'POST', body, headers: signed ? headers(body) : {} }, res);
  return result;
}

// In-memory boundary fixtures only: no production credentials, DB, Queue or Lark.
function harness() {
  const roots = new Map();
  const handoffs = new Map();
  const published = [];
  let storeCreations = 0;
  const key = (chatId, batchId) => `${chatId}:${batchId}`;
  const store = {
    async reserveDispatchIngestRoot(root) {
      const id = key(root.chatId, root.batchId);
      const value = JSON.stringify({
        fingerprint: root.fingerprint, requestIds: root.requestIds, chunkPlan: root.chunkPlan,
      });
      const previous = roots.get(id);
      if (previous && previous !== value) return { outcome: 'PAYLOAD_CONFLICT' };
      roots.set(id, value);
      return { outcome: previous ? 'REUSED' : 'ACCEPTED' };
    },
    async registerDispatchHandoff(registration) {
      const id = key(registration.chatId, registration.batchId);
      const previous = handoffs.get(id);
      if (previous) {
        return { ...previous, outcome: previous.fingerprint === registration.fingerprint ? 'REUSED' : 'PAYLOAD_CONFLICT' };
      }
      const row = {
        found: true, chat_id: registration.chatId, batch_id: registration.batchId,
        fingerprint: registration.fingerprint, status: 'HANDOFF_PENDING',
        operation_id: registration.operationId, request_ids: registration.requestIds,
      };
      handoffs.set(id, row);
      return { ...row, outcome: 'ACCEPTED' };
    },
    async confirmDispatchHandoff({ chatId, batchId }) {
      handoffs.get(key(chatId, batchId)).status = 'QUEUED';
    },
    async markDispatchHandoffUnknown({ chatId, batchId }) {
      handoffs.get(key(chatId, batchId)).status = 'ACCEPTED_UNKNOWN';
    },
    async getIngestBatchStatus({ chatId, batchId }) {
      return handoffs.get(key(chatId, batchId)) || { found: false };
    },
    async getIngestBatchStatuses(items) {
      return items.map(({ chatId, batchId }) => ({
        chat_id: chatId, batch_id: batchId,
        ...(handoffs.get(key(chatId, batchId)) || { found: false }),
      }));
    },
  };
  const dependencies = {
    storeFactory: () => { storeCreations += 1; return store; },
    statusCache: { get: async () => null, set: async () => true },
    publishDispatch: async (message) => {
      published.push(message);
      return { message_id: `queue_${published.length}` };
    },
    defer: () => {},
  };
  const send = createDispatchSendHandler(dependencies);
  const automation = createAutomationSendHandler({ ...dependencies, secret: SECRET });
  return {
    roots, handoffs, published,
    get storeCreations() { return storeCreations; },
    send: (body) => invoke(send, body),
    automation: (body, { dryRun = false, encoded = false } = {}) => invoke(automation, {
      automation_token: SECRET, source_record_id: 'rec_isolated_capacity', dry_run: dryRun,
      dispatch_payload: encoded ? Buffer.from(JSON.stringify(body)).toString('base64') : body,
    }, { signed: false }),
    status: (body) => invoke(createDispatchStatusHandler(dependencies), body),
    statusBatch: (body) => invoke(createDispatchStatusBatchHandler(dependencies), body),
  };
}

for (const profile of Object.keys(profiles)) {
  for (const count of [1, 20, 21, 30, 31, 32, 40]) {
    test(`${profile} ${count} 条在单个原批次中通过接入并保持每卡最多20条`, async () => {
      const body = payload(count, { profile });
      const normalized = normalizeBatchDispatchIngest(body);
      assert.equal(normalized.fieldsList.length, count);
      for (const entry of ['send', 'automation']) {
        const h = harness();
        const response = await h[entry](body);
        assert.equal(response.status, 202);
        assert.equal(response.body.batch_id, body.batch_id);
        assert.equal(response.body.request_ids.length, count);
        assert.equal(h.roots.size, 1);
        assert.equal(h.published.length, Math.ceil(count / 20));
        assert.deepEqual(h.published.flatMap((message) => message.request_ids), body.items.map((item) => item.request_id));
        assert.ok(h.published.every((message) => message.request_ids.length <= 20));
        assert.equal(new Set(h.published.map((message) => message.operation_id)).size, h.published.length);
        if (count > 20) assert.deepEqual(response.body.chunks.map((chunk) => chunk.item_count), [20, count - 20]);
      }
    });
  }
}

for (const count of [0, 41]) {
  for (const entry of ['send', 'automation']) {
    test(`${entry} ${count} 条明确返回不可重试的400和容量证据，零受理/入队`, async () => {
      const h = harness();
      const response = await h[entry](payload(count));
      assert.equal(response.status, 400);
      assert.equal(response.body.error_code, 'INVALID_BATCH_SIZE');
      assert.equal(response.body.accepted, false);
      assert.equal(response.body.retryable, false);
      assert.equal(response.body.item_count, count);
      assert.match(response.body.message, /1 至 40/);
      assert.deepEqual(response.body.limits, { min_items: 1, max_items: 40, max_items_per_card: 20, max_card_count: 2 });
      assert.equal(response.body.operation_id, undefined);
      assert.equal(h.storeCreations, 0);
      assert.equal(h.roots.size, 0);
      assert.equal(h.handoffs.size, 0);
      assert.equal(h.published.length, 0);
    });
  }
}

for (const count of [31, 32, 40]) {
  test(`${count} 条两入口 dry-run 规划一致且零持久化、零入队`, async () => {
    const h = harness();
    const body = payload(count);
    const send = await h.send({ ...body, dry_run: true });
    const automation = await h.automation(body, { dryRun: true, encoded: true });
    assert.equal(send.status, 200);
    assert.equal(automation.status, 200);
    assert.equal(send.body.status, 'DRY_RUN_OK');
    assert.equal(automation.body.status, 'DRY_RUN_OK');
    assert.deepEqual(send.body.chunks, automation.body.chunks);
    assert.deepEqual(send.body.chunks.map((chunk) => chunk.item_count), [20, count - 20]);
    assert.equal(h.storeCreations, 0);
    assert.equal(h.published.length, 0);
  });
}

test('32条 Base64接入→两入口交叉幂等重放→两份权威回执→根批次SENT', async () => {
  const h = harness();
  const body = payload(32);
  const identity = { chat_id: body.chat_id, batch_id: body.batch_id };
  const before = await h.status(identity);
  assert.equal(before.body.status, 'NOT_FOUND');
  assert.equal(before.body.found, false);
  assert.equal(before.body.operation_id, dispatchOperationId(body.chat_id, body.batch_id));
  assert.equal(h.roots.size, 0, 'status生成操作号不等于受理');

  const first = await h.automation(body, { encoded: true });
  const replay = await h.send(structuredClone(body));
  assert.equal(first.status, 202);
  assert.equal(replay.body.reused, true);
  assert.deepEqual(replay.body.operation_ids, first.body.operation_ids);
  assert.equal(h.published.length, 2);
  assert.equal(h.handoffs.size, 2);

  const rows = [...h.handoffs.values()];
  Object.assign(rows[0], { status: 'SENT', message_id: 'om_isolated_1' });
  Object.assign(rows[1], { status: 'ACCEPTED_UNKNOWN' });
  const partial = await h.status(identity);
  assert.equal(partial.body.status, 'SENDING');
  assert.deepEqual(partial.body.message_ids, ['om_isolated_1']);

  Object.assign(rows[1], { status: 'SENT', message_id: 'om_isolated_2' });
  for (const response of [await h.status(identity), await h.statusBatch({ items: [identity] })]) {
    const result = response.body.items ? response.body.items[0] : response.body;
    assert.equal(result.status, 'SENT');
    assert.deepEqual(result.message_ids, ['om_isolated_1', 'om_isolated_2']);
    assert.equal(result.request_ids.length, 32);
    assert.equal(new Set(result.request_ids).size, 32);
    assert.deepEqual(result.operation_ids, first.body.operation_ids);
  }
  assert.equal(h.published.length, 2, '状态读取和回执恢复不得重新入队');
});

for (const [from, to] of [[30, 32], [32, 30], [32, 40], [40, 32], [32, 20]]) {
  test(`同根批次 ${from}→${to} 条漂移被拒绝，不生成额外分卡`, async () => {
    const h = harness();
    const body = payload(from, { batchId: 'capacity_conflict' });
    assert.equal((await h.automation(body)).status, 202);
    const publishes = h.published.length;
    const conflict = await h.send(payload(to, { batchId: body.batch_id }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error_code, 'PAYLOAD_CONFLICT');
    assert.equal(h.published.length, publishes);
    assert.equal(h.roots.size, 1);
  });
}
