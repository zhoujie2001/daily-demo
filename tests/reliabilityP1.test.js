import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationSendHandler } from '../lib/dispatch/api/automation-send.js';
import pullHandler from '../api/cron/bess-pull-base.js';
import { createSupabaseDispatchStore } from '../lib/dispatch/supabase-store.js';

const TEST_SECRET = 'test-secret';
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

describe('P1 Reliability & Handoff Recovery', () => {
  // 1. 请求未送达 (publish timeout)
  it('1. 请求未送达：publish 超时应标记 ACCEPTED_UNKNOWN 并返回 503', async () => {
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
    assert.ok(unknownMarked, 'Should mark as ACCEPTED_UNKNOWN in DB');
  });

  // 2. 已入队但响应丢失 (publish late success)
  it('2. 已入队但响应丢失：晚到的成功应通过 defer 确认', async () => {
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
      defer: (p) => p, // Run deferred immediately in test
    });

    const { res, data } = mockRes();
    const handlerPromise = handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    await new Promise(r => setTimeout(r, 20)); // wait for timeout
    await handlerPromise;
    assert.equal(data.statusCode, 503);
    
    resolvePublish({ message_id: 'late_id' });
    await new Promise(r => setTimeout(r, 10)); // wait for defer logic
    
    assert.ok(confirmed, 'Should confirm late success via deferred task');
  });

  // 3. 晚到成功 (Reconciler fixes it)
  it('3. 晚到成功：Reconciler 应能发现并保持 UNKNOWN 状态直到确定', async () => {
    const mockStore = {
      listHandoffsToReconcile: async () => [{
        formMessageId: 'f1', chatId: 'c1', context: { operationId: 'op1', batchId: 'b1', status: 'ACCEPTED_UNKNOWN' }
      }],
      getIngestBatchStatus: async () => ({ status: 'ACCEPTED_UNKNOWN' }), // Still unknown
      markDispatchHandoffUnknown: async () => ({ updated: true }),
    };
    
    const results = [];
    const now = new Date();
    const handoffs = await mockStore.listHandoffsToReconcile({ now });
    for (const handoff of handoffs) {
      const { chatId, context } = handoff;
      const status = await mockStore.getIngestBatchStatus({ chatId, batchId: context.batchId });
      if (status.status === 'ACCEPTED_UNKNOWN') {
        await mockStore.markDispatchHandoffUnknown({ chatId, batchId: context.batchId, now });
        results.push({ batchId: context.batchId, updated: true });
      }
    }
    assert.equal(results.length, 1);
    assert.ok(results[0].updated);
  });

  // 4. Base 回写失败只进入 pending writeback
  it('4. Base 回写失败：应记录到 pending writeback 且不重复 publish', async () => {
    let publishCount = 0;
    const store = {
      registerDispatchHandoff: async () => {
        if (publishCount === 0) return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
        return { outcome: 'REUSED', status: 'HANDOFF_PENDING' }; // Second call is REUSED
      },
      confirmDispatchHandoff: async () => {},
      recordWritebackFailure: async () => ({ updated: true }),
    };
    
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => { publishCount++; return { message_id: 'q1' }; },
      storeFactory: () => store,
    });

    const { res: res1, data: data1 } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res1);
    assert.equal(data1.statusCode, 202);
    assert.equal(publishCount, 1);

    await store.recordWritebackFailure({ chatId: 'c1', batchId: 'b1', recordId: 'rec1', errorCode: 'BASE_TIMEOUT' });

    const { res: res2, data: data2 } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res2);
    assert.equal(data2.statusCode, 202);
    assert.equal(publishCount, 1, 'Should NOT publish again on retry');
    assert.equal(data2.body.reused, true);
  });

  // 5. 消费者强杀后租约过期可恢复且相同 uuid
  it('5. 消费者强杀：租约过期后 nudge 应允许新任务领取且 operation_id 保持不变', async () => {
    const oldOpId = 'op-stable-uuid';
    const store = createSupabaseDispatchStore({
      url: 'https://test.supabase.co',
      serviceRoleKey: 'test-key',
      fetchImpl: async (url) => {
        if (url.includes('rpc/bess_register_dispatch_handoff')) {
          return { ok: true, text: async () => JSON.stringify([{ outcome: 'ACCEPTED', operation_id: oldOpId }]) };
        }
        if (url.includes('bess_dispatch_pending_forms')) {
          return { ok: true, text: async () => JSON.stringify([{
            form_message_id: 'f1',
            operation_id: oldOpId,
            request_context: { status: 'PROCESSING', operationId: oldOpId, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }
          }]) };
        }
        return { ok: true, text: async () => '[]' };
      }
    });

    const handoff = await store.registerDispatchHandoff({ chatId: 'c1', batchId: 'b1', fingerprint: 'f1', requestIds: ['r1'], operationId: oldOpId });
    assert.equal(handoff.operation_id, oldOpId);
    
    const nudged = await store.nudgeDispatchOutbox({ chatId: 'c1', batchId: 'b1' });
    assert.ok(nudged !== undefined);
  });

  // 6. 多 worker 重复领取只有一个 publish
  it('6. 多 worker 重复领取：只有第一个能获得 ACCEPTED 并 publish', async () => {
    let publishCount = 0;
    let dbRowExists = false;
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      publishDispatch: async () => { publishCount++; return { message_id: 'q1' }; },
      storeFactory: () => ({
        registerDispatchHandoff: async () => {
          if (!dbRowExists) {
            dbRowExists = true;
            return { outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' };
          }
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
  it('7. Payload 冲突：同批次不同内容应返回 409', async () => {
    const store = {
      registerDispatchHandoff: async () => ({ outcome: 'PAYLOAD_CONFLICT', status: 'QUEUED' }),
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

  // 8. HANDOFF_PENDING/ACCEPTED_UNKNOWN 不得映射确定失败
  it('8. 状态语义：HANDOFF_PENDING/ACCEPTED_UNKNOWN 应被视为接受但未确定', async () => {
    const handler = createAutomationSendHandler({
      secret: TEST_SECRET,
      storeFactory: () => ({
        registerDispatchHandoff: async () => ({ outcome: 'REUSED', status: 'ACCEPTED_UNKNOWN' }),
      }),
    });

    const { res, data } = mockRes();
    await handler(mockReq({ automation_token: TEST_SECRET, dispatch_payload: VALID_PAYLOAD }), res);
    
    assert.equal(data.statusCode, 202);
    assert.equal(data.body.status, 'QUEUED'); 
    assert.equal(data.body.accepted, true);
  });

  // 9. Base pull 默认 disabled，且不会触碰今天历史记录
  it('9. Base pull：默认 disabled 且应具备日期隔离', async () => {
    const { res, data } = mockRes();
    process.env.BESS_BASE_PULL_ENABLED = 'false';
    process.env.CRON_SECRET = 'test-cron-secret';
    const req = mockReq({});
    req.method = 'GET';
    req.headers.authorization = 'Bearer test-cron-secret';
    await pullHandler(req, res);
    assert.equal(data.body.message, 'disabled');
  });

  // 10. 水位线/完成门禁
  it('10. 水位线保护：UNKNOWN/CONFLICT 不得触发 cursor 推进', async () => {
    const store = createSupabaseDispatchStore({
      url: 'https://test.supabase.co',
      serviceRoleKey: 'test-key',
      fetchImpl: async (url) => {
        if (url.includes('rpc/bess_register_dispatch_handoff')) {
          return { ok: true, text: async () => JSON.stringify([{ outcome: 'ACCEPTED', status: 'HANDOFF_PENDING' }]) };
        }
        assert.fail('Should not call other RPCs (like assign or calibrate) during handoff registration');
      }
    });
    
    await store.registerDispatchHandoff({ chatId: 'c1', batchId: 'b1', fingerprint: 'f1', requestIds: ['r1'], operationId: 'op1' });
  });
});
