import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';

const SECRET = 'dispatch-status-test-secret';
const NOW = Math.floor(Date.now() / 1000);

function signature(body, timestamp = NOW) {
  return createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest('hex');
}

async function invoke(body, store) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  const handler = createDispatchStatusHandler({ storeFactory: () => store });
  await handler({
    method: 'POST',
    body,
    headers: {
      'x-bess-timestamp': String(NOW),
      'x-bess-signature': `sha256=${signature(body)}`,
    },
  }, response);
  return result;
}

test('不存在的持久化批次以 HTTP 200 返回 found=false', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_missing' },
    { async getIngestBatchStatus() { return { found: false }; } },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, found: false });
});

test('持久化批次完成后返回 SENT 和 message_id', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = await invoke(
    { chat_id: 'oc_test', batch_id: 'batch_sent' },
    {
      async getIngestBatchStatus({ chatId, batchId }) {
        assert.equal(chatId, 'oc_test');
        assert.equal(batchId, 'batch_sent');
        return { found: true, status: 'SENT', message_id: 'om_sent' };
      },
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    found: true,
    status: 'SENT',
    message_id: 'om_sent',
  });
});
