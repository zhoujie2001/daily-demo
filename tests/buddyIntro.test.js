import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildBuddyIntroCard, createDispatchSendHandler } from '../api/dispatch/send.js';
import { canonicalJson } from '../lib/dispatch/ingest.js';

const SECRET = 'buddy-intro-test-secret';
const NOW = Math.floor(Date.now() / 1000);
const MAIN_CHAT_ID = 'oc_aa1602f07bf35a5fdfd289aff67025a4';

function sign(body) {
  return `sha256=${createHmac('sha256', SECRET).update(`${NOW}.${canonicalJson(body)}`).digest('hex')}`;
}

async function invoke(body, { signed = true, client } = {}) {
  process.env.BESS_DISPATCH_INGEST_SECRET = SECRET;
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return response; },
    json(value) { result.body = value; return response; },
  };
  await createDispatchSendHandler({ client })({
    method: 'POST', body,
    headers: { 'x-bess-timestamp': String(NOW), 'x-bess-signature': signed ? sign(body) : 'bad' },
  }, response);
  return result;
}

test('自我介绍动作只向固定主群发送固定无回调 Card 2.0', async () => {
  const calls = [];
  const result = await invoke({ action: 'send_buddy_intro' }, {
    client: { async sendMessage(payload) { calls.push(payload); return { message_id: 'om_intro_1' }; } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, message_id: 'om_intro_1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiveId, MAIN_CHAT_ID);
  assert.equal(calls[0].msgType, 'interactive');
  assert.equal(calls[0].content.schema, '2.0');
  assert.equal(calls[0].content.header.title.content, '自我介绍');
  assert.doesNotMatch(JSON.stringify(calls[0].content), /callback|behaviors|button/);
});

test('自我介绍动作拒绝无效签名及调用方注入的群或卡片', async () => {
  const client = { async sendMessage() { throw new Error('should not send'); } };
  const unsigned = await invoke({ action: 'send_buddy_intro' }, { signed: false, client });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.error_code, 'INVALID_SIGNATURE');

  const injected = await invoke({ action: 'send_buddy_intro', chat_id: 'oc_other', card: {} }, { client });
  assert.equal(injected.status, 400);
  assert.equal(injected.body.error_code, 'INVALID_SCHEMA');
});

test('固定卡片覆盖四个自我介绍主题', () => {
  const serialized = JSON.stringify(buildBuddyIntroCard());
  for (const heading of ['我能干什么', '我的工作逻辑', '我在什么情况下出现', '使用方式']) {
    assert.match(serialized, new RegExp(heading));
  }
});
