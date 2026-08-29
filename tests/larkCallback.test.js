import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/lark/callback.js';

const VERIFICATION_TOKEN = 'verification-token';
const APP_ID = 'cli_test_app';

process.env.LARK_VERIFICATION_TOKEN = VERIFICATION_TOKEN;
process.env.LARK_APP_ID = APP_ID;

function invoke(body, { method = 'POST', headers = {} } = {}) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) {
      result.headers[name] = value;
    },
    status(statusCode) {
      result.status = statusCode;
      return response;
    },
    json(responseBody) {
      result.body = responseBody;
      return response;
    },
  };

  handler({ method, headers, body }, response);
  return result;
}

test('正确 Token 的 URL verification 返回 challenge', () => {
  const result = invoke({
    type: 'url_verification',
    token: VERIFICATION_TOKEN,
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'application/json');
  assert.deepEqual(result.body, { challenge: 'challenge-value' });
});

test('正确 Token 且省略 type 的 URL verification 返回 challenge', () => {
  const result = invoke({
    token: VERIFICATION_TOKEN,
    challenge: 'challenge-without-type',
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: 'challenge-without-type' });
});

test('URL verification 无 Token 返回 403', () => {
  const result = invoke({
    type: 'url_verification',
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 403);
});

test('URL verification 错误 Token 返回 403', () => {
  const result = invoke({
    type: 'url_verification',
    token: 'wrong-token',
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 403);
});

test('URL verification 的 challenge 必须是非空字符串', () => {
  const result = invoke({
    type: 'url_verification',
    token: VERIFICATION_TOKEN,
    challenge: '',
  });

  assert.equal(result.status, 400);
});

test('合法 card.action.trigger 返回 200', () => {
  const result = invoke({
    header: {
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});
});

test('card.action.trigger 错误 App ID 返回 403', () => {
  const result = invoke({
    header: {
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: 'cli_wrong_app',
    },
  });

  assert.equal(result.status, 403);
});

test('card.action.trigger 错误 Token 返回 403', () => {
  const result = invoke({
    header: {
      event_type: 'card.action.trigger',
      token: 'wrong-token',
      app_id: APP_ID,
    },
  });

  assert.equal(result.status, 403);
});

test('非 POST 请求返回 405', () => {
  const result = invoke({}, { method: 'GET' });

  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, 'POST');
});
