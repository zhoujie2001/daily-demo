import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchOutboxQueueHandler } from '../api/cron/bess-dispatch-outbox.js';

test('队列消费者使用有界租约与退避，毒消息直接确认', async () => {
  let callback;
  let options;
  const createHandler = (targetCallback, targetOptions) => {
    callback = targetCallback;
    options = targetOptions;
    return 'private-queue-handler';
  };
  const seen = [];
  const handler = createDispatchOutboxQueueHandler({
    createHandler,
    async processMessage(message) { seen.push(message); return { ok: true }; },
  });
  assert.equal(handler, 'private-queue-handler');
  assert.equal(options.visibilityTimeoutSeconds, 60);
  assert.deepEqual(options.retry({ acknowledge: true }, { deliveryCount: 1 }), { acknowledge: true });
  assert.deepEqual(options.retry(new Error('retry'), { deliveryCount: 2 }), { afterSeconds: 10 });
  assert.deepEqual(options.retry(new Error('exhausted'), { deliveryCount: 12 }), { acknowledge: true });

  const result = await callback({ operation_id: 'op_1' }, { messageId: 'q_1', deliveryCount: 1 });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [{ operation_id: 'op_1' }]);
});
