import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createDispatchStatusHandler } from '../lib/dispatch/api/status.js';
import { canonicalJson, verifyDispatchStatusSignature } from '../lib/dispatch/ingest.js';
import { dispatchOperationId } from '../lib/dispatch/operation.js';

const SECRET = 'dispatch-status-signature-compat-secret';
const NOW_S = Math.floor(Date.now() / 1000);
const CHAT = 'oc_56debf24fa90e17ea92257c20454d742';
const BATCH = 'game-bess-d-8dc23461689e70d2e2f7263f';
const OP = dispatchOperationId(CHAT, BATCH);

function sign(body, timestamp = NOW_S, secret = SECRET) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest('hex');
}

function verify(body, signatureValue, timestamp = NOW_S) {
  return verifyDispatchStatusSignature({
    body,
    timestamp: String(timestamp),
    signature: `sha256=${signatureValue}`,
    secret: SECRET,
    now: () => NOW_S * 1000,
  });
}

test('严格形态：完整接收体签名通过（含 request_id 单条形态）', () => {
  const body = { chat_id: CHAT, request_id: 'single:abc' };
  assert.doesNotThrow(() => verify(body, sign(body)));
});

test('兼容形态 A：workflow 发 2 字段，AD skill 也按 2 字段签名', () => {
  const body = { chat_id: CHAT, batch_id: BATCH };
  assert.doesNotThrow(() => verify(body, sign(body)));
});

test('兼容形态 B：workflow 发 2 字段，旧 game skill 按确定性 operation_id 的 3 字段签名', () => {
  const received = { chat_id: CHAT, batch_id: BATCH };
  const signed = { chat_id: CHAT, batch_id: BATCH, operation_id: OP };
  assert.doesNotThrow(() => verify(received, sign(signed)));
});

test('兼容形态 C：workflow 发 3 字段，AD skill 按 2 字段投影签名', () => {
  const received = { chat_id: CHAT, batch_id: BATCH, operation_id: OP };
  const signed = { chat_id: CHAT, batch_id: BATCH };
  assert.doesNotThrow(() => verify(received, sign(signed)));
});

test('兼容形态 D：workflow 发 3 字段且双方都按 3 字段签名', () => {
  const body = { chat_id: CHAT, batch_id: BATCH, operation_id: OP };
  assert.doesNotThrow(() => verify(body, sign(body)));
});

test('operation_id 与确定性推导不一致时，2 字段投影签名必须拒绝（严格自签名仍合法）', () => {
  const received = { chat_id: CHAT, batch_id: BATCH, operation_id: 'bess-outbox-deadbeef' };
  // 严格形态：对完整接收体签名始终合法（持有密钥方可签）
  assert.doesNotThrow(() => verify(received, sign(received)));
  // 投影形态：伪造的 operation_id 不能借用 2 字段投影通过
  assert.throws(
    () => verify(received, sign({ chat_id: CHAT, batch_id: BATCH })),
    (err) => err.code === 'INVALID_SIGNATURE',
  );
});

test('携带未知字段的请求体不能借投影绕过验签', () => {
  const received = { chat_id: CHAT, batch_id: BATCH, evil: 'x' };
  assert.throws(
    () => verify(received, sign({ chat_id: CHAT, batch_id: BATCH })),
    (err) => err.code === 'INVALID_SIGNATURE',
  );
});

test('错误密钥、过期时间戳分别拒绝', () => {
  const body = { chat_id: CHAT, batch_id: BATCH };
  assert.throws(
    () => verify(body, sign(body, NOW_S, 'other-secret')),
    (err) => err.code === 'INVALID_SIGNATURE',
  );
  assert.throws(
    () => verify(body, sign(body, NOW_S - 6 * 60), NOW_S - 6 * 60),
    (err) => err.code === 'STALE_REQUEST',
  );
});

test('status 处理器端到端：game 旧版 3 字段签名 + workflow 2 字段请求体返回 200 NOT_FOUND', async () => {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const received = { chat_id: CHAT, batch_id: BATCH };
  const signed = { chat_id: CHAT, batch_id: BATCH, operation_id: OP };
  const result = { headers: {} };
  Object.defineProperty(result, 'deferred', { value: [], enumerable: false });
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  const handler = createDispatchStatusHandler({
    storeFactory: () => ({ async getIngestBatchStatus() { return { found: false }; } }),
    defer() {},
  });
  await handler({
    method: 'POST',
    body: received,
    headers: {
      'x-bess-timestamp': String(NOW_S),
      'x-bess-signature': `sha256=${sign(signed)}`,
    },
  }, response);

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'NOT_FOUND');
});
