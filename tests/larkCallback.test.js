import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import handler from '../api/lark/callback.js';

const VERIFICATION_TOKEN = 'verification-token';
const APP_ID = 'cli_test_app';
const ENCRYPT_KEY = 'test-encrypt-key';
const APP_SECRET = 'test-app-secret';
const ALLOWED_CHAT_ID = 'oc_allowed_chat';

process.env.LARK_VERIFICATION_TOKEN = VERIFICATION_TOKEN;
process.env.LARK_APP_ID = APP_ID;
process.env.LARK_ENCRYPT_KEY = ENCRYPT_KEY;
process.env.LARK_APP_SECRET = APP_SECRET;
process.env.LARK_API_BASE_URL = 'https://open.feishu.test';
process.env.LARK_DISPATCH_ALLOWED_CHAT_IDS = ALLOWED_CHAT_ID;

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

async function invoke(body, { method = 'POST', headers = {} } = {}) {
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

  await handler({ method, headers, body }, response);
  return result;
}

function dispatchCard(requestId) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '【千川/本地推】新增回扫需求' } },
    body: {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [
                {
                  tag: 'markdown',
                  content: `**需求 ${requestId}｜测试需求**\n- 业务类型：千川\n- 已分配给：-`,
                },
              ],
            },
            {
              tag: 'column',
              elements: [
                {
                  tag: 'button',
                  element_id: `dsp_${requestId}`,
                  text: { tag: 'plain_text', content: '自动派单' },
                  type: 'primary_filled',
                  behaviors: [
                    {
                      type: 'callback',
                      value: {
                        schema_version: 1,
                        action: 'bess_auto_dispatch',
                        request_id: requestId,
                        request_name: '测试需求',
                        business_type: '千川',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function dispatchTrigger({ requestId, chatId = ALLOWED_CHAT_ID, messageId = 'om_card_1' }) {
  return {
    header: {
      event_id: `evt_${requestId}`,
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
    },
    event: {
      token: `c-update-${requestId}`,
      operator: { open_id: 'ou_operator_1' },
      action: {
        tag: 'button',
        value: {
          schema_version: 1,
          action: 'bess_auto_dispatch',
          request_id: requestId,
          request_name: `测试需求_${requestId}`,
          business_type: '千川',
          row_index: 12,
          card_title: '【千川/本地推】新增回扫需求',
        },
      },
      context: { open_chat_id: chatId, open_message_id: messageId },
    },
  };
}

// Stub fetch to emulate Feishu OpenAPI without network access.
function stubFetch(card) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/tenant_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ code: 0, tenant_access_token: 't-test-token', expire: 7200 });
        },
      };
    }
    if (parsed.pathname.endsWith('/reply')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ code: 0, data: { message_id: 'om_thread_reply_1' } });
        },
      };
    }
    if (parsed.pathname === '/open-apis/interactive/v1/card/update') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ code: 0, msg: 'ok' });
        },
      };
    }
    if (parsed.pathname.includes('/im/v1/messages/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  msg_type: 'interactive',
                  body: { content: JSON.stringify(card) },
                },
              ],
            },
          });
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async text() {
        return JSON.stringify({ code: 404, msg: 'not found' });
      },
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('正确 Token 的 URL verification 返回 challenge', async () => {
  const result = await invoke({
    type: 'url_verification',
    token: VERIFICATION_TOKEN,
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'application/json');
  assert.deepEqual(result.body, { challenge: 'challenge-value' });
});

test('真实 encrypt 外层载荷可解密并返回 challenge', async () => {
  const result = await invoke({
    encrypt: encryptPayload({
      type: 'url_verification',
      token: VERIFICATION_TOKEN,
      challenge: 'encrypted-challenge',
    }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: 'encrypted-challenge' });
});

test('正确 Token 且省略 type 的 URL verification 返回 challenge', async () => {
  const result = await invoke({
    token: VERIFICATION_TOKEN,
    challenge: 'challenge-without-type',
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { challenge: 'challenge-without-type' });
});

test('省略 type 且 Token 错误的 URL verification 返回 403', async () => {
  const result = await invoke({
    token: 'wrong-token',
    challenge: 'challenge-without-type',
  });

  assert.equal(result.status, 403);
});

test('URL verification 无 Token 返回 403', async () => {
  const result = await invoke({
    type: 'url_verification',
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 403);
});

test('URL verification 错误 Token 返回 403', async () => {
  const result = await invoke({
    type: 'url_verification',
    token: 'wrong-token',
    challenge: 'challenge-value',
  });

  assert.equal(result.status, 403);
});

test('URL verification 的 challenge 必须是非空字符串', async () => {
  const result = await invoke({
    type: 'url_verification',
    token: VERIFICATION_TOKEN,
    challenge: '',
  });

  assert.equal(result.status, 400);
});

test('合法 card.action.trigger 无派单动作时返回 200 空响应', async () => {
  const result = await invoke({
    header: {
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});
});

test('card.action.trigger 错误 App ID 返回 403', async () => {
  const result = await invoke({
    header: {
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: 'cli_wrong_app',
    },
  });

  assert.equal(result.status, 403);
});

test('加密 card.action.trigger 仍严格校验 App ID', async () => {
  const result = await invoke({
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

test('带 challenge 的 card.action.trigger 仍校验 App ID', async () => {
  const result = await invoke({
    challenge: 'not-url-verification',
    header: {
      event_type: 'card.action.trigger',
      token: VERIFICATION_TOKEN,
      app_id: 'cli_wrong_app',
    },
  });

  assert.equal(result.status, 403);
});

test('card.action.trigger 错误 Token 返回 403', async () => {
  const result = await invoke({
    header: {
      event_type: 'card.action.trigger',
      token: 'wrong-token',
      app_id: APP_ID,
    },
  });

  assert.equal(result.status, 403);
});

test('非 POST 请求返回 405', async () => {
  const result = await invoke({}, { method: 'GET' });

  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, 'POST');
});

test('派单回调成功：回复建话题并回写卡片', async () => {
  const requestId = '706001';
  const card = dispatchCard(requestId);
  const fetchStub = stubFetch(card);
  try {
    const result = await invoke(dispatchTrigger({ requestId }));

    assert.equal(result.status, 200);
    assert.equal(result.body.toast.type, 'success');
    assert.ok(!result.body.card, '回调先返回 Toast，卡片通过延时接口更新');

    const replyCall = fetchStub.calls.find((call) => call.url.includes('/reply'));
    assert.ok(replyCall, '必须调用回复消息接口');
    assert.match(replyCall.url, /uuid=bess-dispatch-706001/);
    assert.match(replyCall.options.headers.Authorization, /^Bearer t-test-token$/);
    const replyBody = JSON.parse(replyCall.options.body);
    assert.equal(replyBody.msg_type, 'text');
    const replyText = JSON.parse(replyBody.content).text;
    assert.match(replyText, /需求 ID：706001/);
    assert.match(replyText, /业务类型：千川/);

    await new Promise((resolve) => setImmediate(resolve));
    const updateCall = fetchStub.calls.find((call) => call.url.includes('/interactive/v1/card/update'));
    assert.ok(updateCall, 'HTTP 响应后必须调用延时更新卡片接口');
    const updateBody = JSON.parse(updateCall.options.body);
    assert.equal(updateBody.token, 'c-update-706001');
    assert.equal(updateBody.card.schema, '2.0');
    const patchedButton = updateBody.card.body.elements[0].columns[1].elements[0];
    assert.equal(patchedButton.disabled, true);
    assert.equal(patchedButton.text.content, '✅ 已派单');
    assert.deepEqual(patchedButton.behaviors, []);

    // 回调响应中不得泄露密钥
    assert.ok(!JSON.stringify(result.body).includes(APP_SECRET));
  } finally {
    fetchStub.restore();
  }
});

test('派单回调：非白名单群返回错误 Toast 且不调用 OpenAPI', async () => {
  const fetchStub = stubFetch(dispatchCard('706002'));
  try {
    const result = await invoke(dispatchTrigger({ requestId: '706002', chatId: 'oc_other_chat' }));

    assert.equal(result.status, 200);
    assert.equal(result.body.toast.type, 'error');
    assert.match(result.body.toast.content, /当前群未开启自动派单/);
    assert.ok(!fetchStub.calls.some((call) => call.url.includes('/im/')));
  } finally {
    fetchStub.restore();
  }
});

test('派单回调：回复接口失败时返回错误 Toast', async () => {
  const requestId = '706003';
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/tenant_access_token/internal')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }); } };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ code: 230001, msg: 'reply failed' });
      },
    };
  };
  try {
    const result = await invoke(dispatchTrigger({ requestId }));

    assert.equal(result.status, 200);
    assert.equal(result.body.toast.type, 'error');
    assert.match(result.body.toast.content, /派单失败/);
    assert.ok(!result.body.card, '失败时不得回写卡片');
  } finally {
    globalThis.fetch = original;
  }
});
