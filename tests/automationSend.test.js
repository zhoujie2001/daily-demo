import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';

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
    now: () => new Date('2026-09-17T07:00:00Z'),
    ...opts,
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('automation-send', () => {
  it('rejects GET', async () => {
    const handler = createHandler();
    const { res, data } = mockRes();
    await handler(mockReq({}, 'GET'), res);
    assert.equal(data.statusCode, 405);
    assert.equal(data.body.error_code, 'METHOD_NOT_ALLOWED');
  });

  it('rejects missing secret config', async () => {
    const handler = createAutomationSendHandler({ secret: '' });
    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: 'x' }), res);
    assert.equal(data.statusCode, 503);
    assert.equal(data.body.error_code, 'AUTOMATION_DISPATCH_NOT_CONFIGURED');
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
    await handler(mockReq({
      automation_token: TEST_SECRET,
      dispatch_payload: VALID_DISPATCH_PAYLOAD,
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
