import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import handler from '../api/lark/callback.js';

const VERIFICATION_TOKEN = 'verification-token';
const APP_ID = 'cli_test_app';
const ENCRYPT_KEY = 'test-encrypt-key';

process.env.LARK_VERIFICATION_TOKEN = VERIFICATION_TOKEN;
process.env.LARK_APP_ID = APP_ID;
process.env.LARK_ENCRYPT_KEY = ENCRYPT_KEY;

function encryptPayload(payload) {
  const key = createHash('sha256').update(ENCRYPT_KEY).digest();
  const initializationVector = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, initializationVector);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return Buffer.concat([initializationVector, ciphertext]).toString('base64');
}

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

test('真实 encrypt 外层载荷可解密并返回 challenge', () => {
  const result = invoke({
    encrypt: encryptPayload({
      type: 'url_verification',
      token: VERIFICATION_TOKEN,
      challenge: 'encrypted-challenge',
    }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: 'encrypted-challenge' });
});

test('正确 Token 且省略 type 的 URL verification 返回 challenge', () => {
  const result = invoke({
    token: VERIFICATION_TOKEN,
    challenge: 'challenge-without-type',
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: 'challenge-without-type' });
});

test('省略 type 且 Token 错误的 URL verification 返回 403', () => {
  const result = invoke({
    token: 'wrong-token',
    challenge: 'challenge-without-type',
  });

  assert.equal(result.status, 403);
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

test('加密 card.action.trigger 仍严格校验 App ID', () => {
  const result = invoke({
    encrypt: encryptPayload({
      header: {
        event_type: 'card.action.trigger',
        token: VERIFICATION_TOKEN,
        app_id: 'cli_wrong_app',
      },
    }),
  });

  assert.equal(result.status, 403);
});

test('带 challenge 的 card.action.trigger 仍校验 App ID', () => {
  const result = invoke({
    challenge: 'not-url-verification',
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
