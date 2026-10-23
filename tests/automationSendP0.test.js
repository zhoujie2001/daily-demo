import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import { DispatchStoreError } from '../lib/dispatch/supabase-store.js';

const TEST_SECRET = 'test-secret';
const VALID_ITEM = {
  request_id: 'req1',
  request_name: 'test',
  business_type: '千川',
  target_category: 'qianchuan',
  sheet_url: 'https://example.com',
  sheet_id: 's1',
  row_index: 1,
  assignee_field_name: 'a',
};
const VALID_PAYLOAD = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1',
  items: [VALID_ITEM],
  batch_id: 'batch1',
  time_segment: 'A',
};

function mockReq(body) {
  return { method: 'POST', body, headers: {}, query: {} };
}

function mockRes() {
  const data = { statusCode: null, body: null, headers: {} };
  const res = {
    status(code) { data.statusCode = code; return res; },
    json(obj) { data.body = obj; return res; },
    setHeader(k, v) { data.headers[k] = v; },
  };
  return { res, data };
}

describe('automation-send P0 Handoff', () => {
  it('registers handoff before publishing', async () => {
    let registered = false;
    let published = false;
    const store = {
      reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
      registerDispatchHandoff: async () => {
        registered = true;
        return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
      },
      confirmDispatchHandoff: async () => {},
    };
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => {
        assert.ok(registered, 'Should register before publishing');
        published = true;
        return { message_id: 'q1' };
      },
      storeFactory: () => store,
      defer: (p) => p,
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 202);
    assert.ok(published);
  });

  it('returns 409 on payload conflict', async () => {
    const store = {
      reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
      registerDispatchHandoff: async () => ({ outcome: 'PAYLOAD_CONFLICT', status: 'QUEUED', operation_id: 'old_op' }),
    };
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      storeFactory: () => store,
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 409);
    assert.equal(data.body.error_code, 'PAYLOAD_CONFLICT');
  });

  it('handles queue timeout by marking status as ACCEPTED_UNKNOWN', async () => {
    let unknownMarked = false;
    const store = {
      reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
      registerDispatchHandoff: async () => ({ outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }),
      markDispatchHandoffUnknown: async () => { unknownMarked = true; },
      confirmDispatchHandoff: async () => {},
    };
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
      publishTimeoutMs: 10,
      storeFactory: () => store,
      defer: () => {},
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 503);
    assert.equal(data.body.accepted_unknown, true);
    assert.ok(unknownMarked);
  });

  it('updates late success to QUEUED', async () => {
    let confirmed = false;
    const store = {
      reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
      registerDispatchHandoff: async () => ({ outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }),
      markDispatchHandoffUnknown: async () => {},
      confirmDispatchHandoff: async () => { confirmed = true; },
    };
    let resolvePublish;
    const publishPromise = new Promise((resolve) => { resolvePublish = resolve; });
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: () => publishPromise,
      publishTimeoutMs: 10,
      storeFactory: () => store,
      defer: (p) => p, // Run deferred immediately in test
    });

    const { res, data } = mockRes();
    const handlerPromise = handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    // Wait for timeout
    await new Promise(r => setTimeout(r, 20));
    await handlerPromise;
    assert.equal(data.statusCode, 503);
    
    // Now resolve the late publish
    resolvePublish({ message_id: 'late_id' });
    await new Promise(r => setTimeout(r, 10)); // wait for defer
    
    assert.ok(confirmed, 'Should confirm late success as QUEUED');
  });

  it('does not re-publish if status is already QUEUED', async () => {
    let publishCount = 0;
    const store = {
      reserveDispatchIngestRoot: async () => ({ outcome: 'ACCEPTED' }),
      registerDispatchHandoff: async () => ({ outcome: 'REUSED', status: 'QUEUED', operation_id: 'op1' }),
    };
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => { publishCount++; return { message_id: 'q1' }; },
      storeFactory: () => store,
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 202);
    assert.equal(publishCount, 0, 'Should not re-publish');
  });
});
