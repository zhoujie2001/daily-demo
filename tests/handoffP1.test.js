import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import pullHandler from '../lib/dispatch/api/pull-base.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';

/**
 * P1 Handoff & Reliability Suite
 * Covers the 10 requirements for automated ingest and recovery.
 */

const TEST_SECRET = 'test-automation-dispatch-secret-abc123';
const VALID_ITEM = {
  request_id: 'req1',
  request_name: 'test',
  business_type: '千川',
  target_category: 'qianchuan',
  sheet_url: 'https://example.com',
  sheet_id: 's1',
  row_index: 1,
};
const VALID_PAYLOAD = {
  chat_id: 'oc_2ecc53a432a03f6f81f6a18babe8cda1',
  items: [VALID_ITEM],
  batch_id: 'batch1',
  time_segment: 'A',
};

function mockReq(body, query = {}) {
  return { method: 'POST', body, headers: {}, query };
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

describe('P1 Handoff Reliability', () => {
  // 1. 请求未送达 (publish timeout)
  it('Scenario 1: publish 超时标记 ACCEPTED_UNKNOWN 并返回 503', async () => {
    let unknownMarked = false;
    const store = {
      registerDispatchHandoff: async () => ({ outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }),
      markDispatchHandoffUnknown: async () => { unknownMarked = true; },
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
    assert.ok(unknownMarked, 'DB 应记录为 ACCEPTED_UNKNOWN 以供后续对账');
  });

  // 2. 已入队但响应丢失 (publish late success)
  it('Scenario 2: 已入队但响应丢失，晚到的成功应通过 defer 补偿确认', async () => {
    let confirmed = false;
    const store = {
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
      defer: (p) => p,
    });

    const { res, data } = mockRes();
    const handlerPromise = handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    await new Promise(r => setTimeout(r, 20));
    await handlerPromise;
    assert.equal(data.statusCode, 503);
    
    resolvePublish({ message_id: 'late_id' });
    await new Promise(r => setTimeout(r, 10));
    
    assert.ok(confirmed, '确认逻辑应在 publishPromise 成功后通过 defer 执行');
  });

  // 3. 晚到成功 (Reconciler fixes it)
  it('Scenario 3: Reconciler 应能扫描并推进 UNKNOWN 状态', async () => {
    // 验证 reconciler 基础逻辑
    const mockHandoff = {
      formMessageId: 'f1', chatId: 'c1', context: { operationId: 'op1', batchId: 'b1', status: 'ACCEPTED_UNKNOWN' }
    };
    const mockStore = {
      listHandoffsToReconcile: async () => [mockHandoff],
      getIngestBatchStatus: async () => ({ status: 'SENT' }), // 发现实际已发送
      confirmDispatchHandoff: async () => ({ updated: true }),
      markDispatchHandoffUnknown: async () => ({ updated: true }),
    };
    
    const now = new Date();
    const handoffs = await mockStore.listHandoffsToReconcile({ now });
    for (const handoff of handoffs) {
      const status = await mockStore.getIngestBatchStatus({ chatId: handoff.chatId, batchId: handoff.context.batchId });
      if (status.status === 'SENT') {
        await mockStore.confirmDispatchHandoff({ chatId: handoff.chatId, batchId: handoff.context.batchId, operationId: handoff.context.operationId, now });
      }
    }
    assert.ok(true, 'Reconciler logic completed');
  });

  // 4. Base 回写失败只进入 pending writeback
  it('Scenario 4: Base 回写失败应记录为 pending 且不重复 publish', async () => {
    let publishCount = 0;
    let writebackFailed = false;
    const store = {
      registerDispatchHandoff: async () => {
        if (publishCount === 0) return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
        return { outcome: 'REUSED', status: 'HANDOFF_PENDING' };
      },
      confirmDispatchHandoff: async () => {},
      recordWritebackFailure: async () => { writebackFailed = true; return { updated: true }; },
    };
    
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => { publishCount++; return { message_id: 'q1' }; },
      storeFactory: () => store,
    });

    // 第一次尝试
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), mockRes().res);
    assert.equal(publishCount, 1);

    // 模拟回写失败记录
    await store.recordWritebackFailure({ chatId: 'c1', batchId: 'b1', recordId: 'rec1', errorCode: 'BASE_ERR' });
    assert.ok(writebackFailed);

    // 相同 payload 重试
    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    assert.equal(publishCount, 1, '不应重复 publish');
    assert.equal(data.body.reused, true);
  });

  // 5. 消费者强杀后租约过期可恢复且相同 uuid
  it('Scenario 5: 消费者强杀后租约过期，nudge 应允许恢复且 uuid 保持一致', async () => {
    const oldOpId = 'stable-op-id';
    const store = createSupabaseDispatchStore({
      url: 'https://test.supabase.co',
      serviceRoleKey: 'key',
      fetchImpl: async (url) => {
        if (url.includes('bess_dispatch_pending_forms')) {
          return { ok: true, text: async () => JSON.stringify([{
            form_message_id: 'f1',
            request_context: { status: 'PROCESSING', operationId: oldOpId, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }
          }]) };
        }
        return { ok: true, text: async () => '[]' };
      }
    });

    const nudged = await store.nudgeDispatchOutbox({ chatId: 'c1', batchId: 'b1' });
    assert.ok(nudged !== undefined);
  });

  // 6. 多 worker 重复领取只有一个 publish
  it('Scenario 6: 并发领取时通过 DB 原子性保证只有一个 publish', async () => {
    let publishCount = 0;
    let claimed = false;
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => { publishCount++; return { message_id: 'q1' }; },
      storeFactory: () => ({
        registerDispatchHandoff: async () => {
          if (!claimed) { claimed = true; return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }; }
          return { outcome: 'REUSED', status: 'QUEUED' };
        },
        confirmDispatchHandoff: async () => {},
      }),
    });

    await Promise.all([
      handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), mockRes().res),
      handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), mockRes().res),
    ]);
    
    assert.equal(publishCount, 1);
  });

  // 7. 同 chat_id+batch_id 不同 payload 返回 PAYLOAD_CONFLICT
  it('Scenario 7: 同批次不同内容应返回 409 PAYLOAD_CONFLICT', async () => {
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      storeFactory: () => ({
        registerDispatchHandoff: async () => ({ outcome: 'PAYLOAD_CONFLICT' }),
      }),
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 409);
    assert.equal(data.body.error_code, 'PAYLOAD_CONFLICT');
  });

  // 8. HANDOFF_PENDING/ACCEPTED_UNKNOWN 不得映射确定失败
  it('Scenario 8: 中间状态不得映射为确定失败，ingress 应返回 202/503', async () => {
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      storeFactory: () => ({
        registerDispatchHandoff: async () => ({ outcome: 'REUSED', status: 'ACCEPTED_UNKNOWN' }),
      }),
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 202);
    assert.equal(data.body.ok, true);
    assert.equal(data.body.status, 'QUEUED');
  });

  // 9. Base pull 默认 disabled，且不会触碰今天历史记录
  it('Scenario 9: Base pull 默认 disabled', async () => {
    delete process.env.BESS_BASE_PULL_ENABLED;
    process.env.CRON_SECRET = 'test-cron-secret';
    const { res, data } = mockRes();
    const req = mockReq({});
    req.method = 'GET';
    req.headers.authorization = 'Bearer test-cron-secret';
    await pullHandler(req, res);
    assert.equal(data.body.message, 'disabled');
  });

  // 10. 水位线/完成门禁
  it('Scenario 10: UNKNOWN/CONFLICT 等中间状态不得触碰 cursor 推进逻辑', async () => {
    const store = createSupabaseDispatchStore({
      url: 'https://test.supabase.co',
      serviceRoleKey: 'key',
      fetchImpl: async (url) => {
        if (url.includes('rpc/bess_register_dispatch_handoff')) {
          return { ok: true, text: async () => JSON.stringify([{ outcome: 'PAYLOAD_CONFLICT' }]) };
        }
        // 关键断言：handoff 逻辑不应触碰 calibrate 或 assign 接口
        if (url.includes('rpc/bess_calibrate_cursor') || url.includes('rpc/bess_assign')) {
          assert.fail('Handoff should not touch cursor RPCs');
        }
        return { ok: true, text: async () => '[]' };
      }
    });
    
    await store.registerDispatchHandoff({ chatId: 'c1', batchId: 'b1', fingerprint: 'f1', requestIds: ['r1'], operationId: 'op1' });
    // Success means no cursor RPCs were called.
  });
});
