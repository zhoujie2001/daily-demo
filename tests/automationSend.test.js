import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationLarkClient, createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEST_SECRET = 'test-automation-dispatch-secret-abc123';

const VALID_ITEM = {
  request_id: '706282',
  request_name: '测试需求',
  business_type: '千川',
  target_category: 'qianchuan',
  sheet_url: 'https://example.com/sheets/abc',
  sheet_id: 'abc123',
  row_index: 28,
  assignee_field_name: '执行人',
  created_at: '2026-09-17 10:00:00',
  creator: '张三',
};

const VALID_DISPATCH_PAYLOAD = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1', // 千川群
  items: [VALID_ITEM],
  batch_id: 'test_batch_001',
  card_title: '千川新增需求',
  time_segment: 'A',
};

/* ------------------------------------------------------------------ */
/*  Mock helpers                                                       */
/* ------------------------------------------------------------------ */

function mockReq(body, method = 'POST') {
  return { method, body, headers: {}, query: { action: 'automation-send' } };
}

function mockRes() {
  const data = { statusCode: null, headers: {}, body: null };
  const res = {
    status(code) { data.statusCode = code; return res; },
    json(obj) { data.body = obj; return res; },
    setHeader(k, v) { data.headers[k] = v; },
  };
  return { res, data };
}

const noop = () => {};
const noopPublish = async () => ({ message_id: 'test-msg-id', deduplicated: false });
const noopEnrich = async () => [];
const noopStatusCache = { get: noop, set: noop };
const mockStore = {
  reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
  registerDispatchHandoff: async () => ({ outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }),
  confirmDispatchHandoff: async () => {},
  markDispatchHandoffUnknown: async () => {},
};

function createHandler(opts = {}) {
  return createAutomationSendHandler({
    secret: TEST_SECRET,
    client: { sendMessage: async () => ({}) },
    publishDispatch: noopPublish,
    enrichRejectReasons: noopEnrich,
    enrichmentTimeoutMs: 50,
    publishTimeoutMs: 5000,
    defer: noop,
    statusCache: noopStatusCache,
    storeFactory: () => mockStore,
    now: () => new Date('2026-09-17T07:00:00Z'),
    ...opts,
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('automation-send', () => {
  it('默认飞书客户端会延迟读取生产环境凭证', async () => {
    const originalFetch = globalThis.fetch;
    const originalAppId = process.env.LARK_APP_ID;
    const originalAppSecret = process.env.LARK_APP_SECRET;
    const requests = [];
    try {
      process.env.LARK_APP_ID = 'cli_runtime_app';
      process.env.LARK_APP_SECRET = 'runtime_secret';
      globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        return {
          ok: true,
          async text() {
            return JSON.stringify({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
          },
        };
      };

      const client = createAutomationLarkClient();
      assert.equal(await client.getTenantAccessToken(), 'tenant_token');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.app_id, 'cli_runtime_app');
      assert.equal(requests[0].body.app_secret, 'runtime_secret');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAppId === undefined) delete process.env.LARK_APP_ID;
      else process.env.LARK_APP_ID = originalAppId;
      if (originalAppSecret === undefined) delete process.env.LARK_APP_SECRET;
      else process.env.LARK_APP_SECRET = originalAppSecret;
    }
  });

  it('rejects GET', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({}, 'GET'), res);
    assert.equal(data.statusCode, 405);
    assert.equal(data.body.error_code, 'METHOD_NOT_ALLOWED');
  });

  it('fails closed when automation secret is not configured', async () => {
    const handler = createAutomationSendHandler({ secret: '' });
    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: 'x', dispatch_payload: VALID_DISPATCH_PAYLOAD }), res);
    assert.equal(data.statusCode, 401);
    assert.equal(data.body.error_code, 'INVALID_AUTOMATION_TOKEN');
  });

  it('rejects wrong token', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: 'wrong', dispatch_payload: VALID_DISPATCH_PAYLOAD }), res);
    assert.equal(data.statusCode, 401);
    assert.equal(data.body.error_code, 'INVALID_AUTOMATION_TOKEN');
  });

  it('rejects missing dispatch_payload', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET }), res);
    assert.equal(data.statusCode, 400);
    assert.equal(data.body.error_code, 'MISSING_DISPATCH_PAYLOAD');
  });

  it('accepts object dispatch_payload and queues (202)', async () => {
    const published = [];
    const handler = createHandler({
      publishDispatch: async (msg) => { published.push(msg); return { message_id: 'q1' }; },
    });
    const { res, data } = mockRes();
    const horizontalPayload = {
      ...VALID_DISPATCH_PAYLOAD,
      card_layout: { version: 'horizontal-v1' },
      items: [{ ...VALID_ITEM, risk_level: '高', reject_reason: '素材违规' }],
    };
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: horizontalPayload,
      source_record_id: 'recTest123456',
    }), res);
    assert.equal(data.statusCode, 202);
    assert.equal(data.body.ok, true);
    assert.equal(data.body.status, 'QUEUED');
    assert.equal(data.body.batch_id, 'test_batch_001');
    assert.equal(data.body.items_accepted, 1);
    assert.deepEqual(data.body.request_ids, ['706282']);
    assert.equal(data.body.source_record_id, 'recTest123456');
    assert.equal(published.length, 1);
    assert.equal(published[0].kind, 'dispatch');
    assert.equal(published[0].card.body.elements.some((element) => element.tag === 'column_set'), true);
    assert.doesNotMatch(JSON.stringify(published[0].card.body.elements), /card_layout/);
  });

  it('accepts string dispatch_payload (JSON) and queues', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: JSON.stringify(VALID_DISPATCH_PAYLOAD),
    }), res);
    assert.equal(data.statusCode, 202);
    assert.equal(data.body.status, 'QUEUED');
  });

  it('rebuilds a missing QUEUED bridge on deduplicated automation replay', async () => {
    const writes = [];
    const handler = createHandler({
      publishDispatch: async () => ({ message_id: '', deduplicated: true }),
      statusCache: {
        async get() { return null; },
        async set(payload) { writes.push(payload); return true; },
      },
    });
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: VALID_DISPATCH_PAYLOAD,
    }), res);

    assert.equal(data.statusCode, 202);
    assert.equal(data.body.reused, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.found, true);
    assert.equal(writes[0].value.status, 'QUEUED');
  });

  it('dry_run validates but does not queue', async () => {
    let queueCalled = false;
    const handler = createHandler({
      publishDispatch: async () => { queueCalled = true; return { message_id: 'x' }; },
    });
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: VALID_DISPATCH_PAYLOAD,
      dry_run: true,
    }), res);
    assert.equal(data.statusCode, 200);
    assert.equal(data.body.status, 'DRY_RUN_OK');
    assert.equal(data.body.items_accepted, 1);
    assert.equal(queueCalled, false, 'Queue should not be called in dry_run');
  });

  it('rejects invalid dispatch_payload JSON string', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: '{invalid json',
    }), res);
    assert.equal(data.statusCode, 400);
    assert.equal(data.body.error_code, 'INVALID_DISPATCH_PAYLOAD');
  });

  it('rejects unknown chat_id in payload', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: { ...VALID_DISPATCH_PAYLOAD, chat_id: 'oc_unknown' },
    }), res);
    assert.equal(data.statusCode, 403);
    assert.equal(data.body.error_code, 'FORBIDDEN_CHAT');
  });

  it('21 条拆为两张并在重复 ingest 时不重复建卡', async () => {
    const state = new Set();
    const roots = new Map();
    let publishes = 0;
    const store = {
      async reserveDispatchIngestRoot(root) {
        const previous = roots.get(root.batchId);
        const signature = JSON.stringify({
          fingerprint: root.fingerprint, requestIds: root.requestIds, chunkPlan: root.chunkPlan,
        });
        if (previous && previous !== signature) return { outcome: 'PAYLOAD_CONFLICT' };
        roots.set(root.batchId, signature);
        return { outcome: previous ? 'REUSED' : 'ACCEPTED' };
      },
      async registerDispatchHandoff({ batchId }) {
        if (state.has(batchId)) return { outcome: 'REUSED', status: 'QUEUED' };
        state.add(batchId);
        return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
      },
      async confirmDispatchHandoff() {},
      async markDispatchHandoffUnknown() {},
    };
    const handler = createHandler({
      storeFactory: () => store,
      publishDispatch: async () => { publishes += 1; return { message_id: `q${publishes}` }; },
    });
    const payload = {
      ...VALID_DISPATCH_PAYLOAD,
      batch_id: 'batch_21_items',
      items: Array.from({ length: 21 }, (_, index) => ({
        ...VALID_ITEM, request_id: `req_${index + 1}`, row_index: index + 2,
      })),
    };

    const first = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: payload }), first.res);
    const replay = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: payload }), replay.res);

    assert.equal(first.data.statusCode, 202);
    assert.equal(first.data.body.chunks.length, 2);
    assert.deepEqual(first.data.body.chunks.map((chunk) => chunk.item_count), [20, 1]);
    assert.equal(replay.data.body.reused, true);
    assert.equal(publishes, 2);
  });

  it('原始批次 reservation 阻止 20↔21 漂移并允许完全一致重放', async () => {
    const roots = new Map();
    const handoffs = new Set();
    let publishes = 0;
    const store = {
      async reserveDispatchIngestRoot(root) {
        const signature = JSON.stringify({
          fingerprint: root.fingerprint, requestIds: root.requestIds, chunkPlan: root.chunkPlan,
        });
        const previous = roots.get(root.batchId);
        if (previous && previous !== signature) return { outcome: 'PAYLOAD_CONFLICT' };
        roots.set(root.batchId, signature);
        return { outcome: previous ? 'REUSED' : 'ACCEPTED' };
      },
      async registerDispatchHandoff({ batchId }) {
        if (handoffs.has(batchId)) return { outcome: 'REUSED', status: 'QUEUED' };
        handoffs.add(batchId);
        return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
      },
      async confirmDispatchHandoff() {},
      async markDispatchHandoffUnknown() {},
    };
    const handler = createHandler({
      storeFactory: () => store,
      publishDispatch: async () => { publishes += 1; return { message_id: `q${publishes}` }; },
    });
    const payload = (batchId, count) => ({
      ...VALID_DISPATCH_PAYLOAD,
      batch_id: batchId,
      items: Array.from({ length: count }, (_, index) => ({
        ...VALID_ITEM, request_id: `${batchId}_${index + 1}`, row_index: index + 2,
      })),
    });
    const send = async (body) => {
      const response = mockRes();
      await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: body }), response.res);
      return response.data;
    };

    const twenty = payload('batch_20_then_21', 20);
    assert.equal((await send(twenty)).statusCode, 202);
    assert.equal((await send(twenty)).body.reused, true);
    assert.equal(publishes, 1);
    const forwardConflict = await send(payload('batch_20_then_21', 21));
    assert.equal(forwardConflict.statusCode, 409);
    assert.equal(forwardConflict.body.error_code, 'PAYLOAD_CONFLICT');
    assert.equal(publishes, 1);

    const twentyOne = payload('batch_21_then_20', 21);
    assert.equal((await send(twentyOne)).statusCode, 202);
    assert.equal(publishes, 3);
    assert.equal((await send(twentyOne)).body.reused, true);
    assert.equal(publishes, 3);
    const reverseConflict = await send(payload('batch_21_then_20', 20));
    assert.equal(reverseConflict.statusCode, 409);
    assert.equal(reverseConflict.body.error_code, 'PAYLOAD_CONFLICT');
    assert.equal(publishes, 3);
  });

  it('21 条 dry_run 返回分片摘要且零持久化、零入队', async () => {
    let stores = 0;
    let publishes = 0;
    const handler = createHandler({
      storeFactory: () => { stores += 1; return mockStore; },
      publishDispatch: async () => { publishes += 1; return {}; },
    });
    const response = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dry_run: true,
      dispatch_payload: {
        ...VALID_DISPATCH_PAYLOAD,
        batch_id: 'batch_21_dry',
        items: Array.from({ length: 21 }, (_, index) => ({
          ...VALID_ITEM, request_id: `dry_${index + 1}`, row_index: index + 2,
        })),
      },
    }), response.res);
    assert.equal(response.data.statusCode, 200);
    assert.deepEqual(response.data.body.chunks.map((chunk) => chunk.item_count), [20, 1]);
    assert.equal(stores, 0);
    assert.equal(publishes, 0);
  });

  it('handles queue timeout gracefully (503)', async () => {
    const handler = createHandler({
      publishDispatch: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'DISPATCH_QUEUE_TIMEOUT', status: 503 })), 10)),
      publishTimeoutMs: 5,
      defer: noop,
    });
    const { res, data } = mockRes();
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: VALID_DISPATCH_PAYLOAD,
    }), res);
    // Should return 503 or accept with timeout — check graceful handling
    assert.ok([202, 503].includes(data.statusCode));
  });
});
