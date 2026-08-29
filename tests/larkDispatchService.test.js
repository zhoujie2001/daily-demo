import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { LarkApiError } from '../lib/lark/client.js';

const ALLOWED_CHAT = 'oc_allowed';
const silentLogger = { info() {}, error() {}, warn() {} };

class FakeLarkClient {
  constructor({ replyError = null, getMessageError = null, message = undefined } = {}) {
    this.calls = [];
    this.replyError = replyError;
    this.getMessageError = getMessageError;
    this.message = message === undefined ? interactiveMessage('806001') : message;
  }

  async replyMessage(args) {
    this.calls.push({ kind: 'reply', ...args });
    if (this.replyError) {
      throw this.replyError;
    }
    return { message_id: `om_reply_${args.messageId}` };
  }

  async getMessage(messageId) {
    this.calls.push({ kind: 'getMessage', messageId });
    if (this.getMessageError) {
      throw this.getMessageError;
    }
    return this.message;
  }
}

function sampleCard(requestId) {
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
                  content: `**需求 ${requestId}｜示例需求**\n- 业务类型：千川\n- 已分配给：-`,
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
                    { type: 'callback', value: { action: 'bess_auto_dispatch', request_id: requestId } },
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

function interactiveMessage(requestId) {
  return {
    msg_type: 'interactive',
    message_id: 'om_card_1',
    body: { content: JSON.stringify(sampleCard(requestId)) },
  };
}

function triggerBody({
  requestId = '806001',
  value,
  chatId = ALLOWED_CHAT,
  messageId = 'om_card_1',
  operatorOpenId = 'ou_operator_1',
  eventId = 'evt_1',
} = {}) {
  return {
    header: { event_id: eventId, event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: operatorOpenId },
      action: {
        tag: 'button',
        value: value ?? {
          schema_version: 1,
          action: 'bess_auto_dispatch',
          request_id: requestId,
          request_name: `示例需求_${requestId}`,
          business_type: '千川',
          target_category: 'qianchuan',
          card_title: '【千川/本地推】新增回扫需求',
          sheet_id: 'TQuzLA',
          row_index: 12,
        },
      },
      context: { open_chat_id: chatId, open_message_id: messageId },
    },
  };
}

async function runDispatch(body, { client, config = {} } = {}) {
  return handleDispatchEvent(body, {
    client: client || new FakeLarkClient(),
    config: { allowedChatIds: ALLOWED_CHAT, ...config },
    logger: silentLogger,
  });
}

test('成功：回复原消息建话题并回写已派单卡片', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(triggerBody(), { client });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.toast.type, 'success');
  assert.equal(result.body.card.type, 'raw');
  assert.equal(result.body.card.data.schema, '2.0');

  const reply = client.calls.find((call) => call.kind === 'reply');
  assert.ok(reply, '必须调用回复消息接口');
  assert.equal(reply.messageId, 'om_card_1');
  assert.equal(reply.uuid, 'bess-dispatch-806001');
  assert.equal(reply.msgType, 'text');
  assert.match(reply.content.text, /自动派单话题已创建/);
  assert.match(reply.content.text, /需求 ID：806001/);
  assert.match(reply.content.text, /业务类型：千川/);
  assert.match(reply.content.text, /台账行号：第 12 行/);

  assert.ok(client.calls.some((call) => call.kind === 'getMessage'));

  const button = result.body.card.data.body.elements[0].columns[1].elements[0];
  assert.equal(button.disabled, true);
  assert.equal(button.type, 'default');
  assert.equal(button.text.content, '✅ 已派单');
  assert.deepEqual(button.behaviors, []);
  const details = result.body.card.data.body.elements[0].columns[0].elements[0].content;
  assert.match(details, /已分配给：✅ 派单话题已创建/);
  const note = result.body.card.data.body.elements[1];
  assert.equal(note.tag, 'markdown');
  assert.match(note.content, /✅ \*\*已派单\*\*｜需求 806001/);
});

test('无 action.value 的卡片动作：空响应且无任何 OpenAPI 调用', async () => {
  const client = new FakeLarkClient();
  const body = triggerBody();
  body.event.action.value = undefined;
  const result = await runDispatch(body, { client });

  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, {});
  assert.equal(client.calls.length, 0);
});

test('未知 action：拒绝且不调用 OpenAPI', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(
    triggerBody({ value: { action: 'something_else', request_id: '806002' } }),
    { client },
  );

  assert.equal(result.body.toast.type, 'error');
  assert.equal(result.errorCode, 'UNSUPPORTED_ACTION');
  assert.equal(client.calls.length, 0);
});

test('request_id 非法：返回校验错误', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(
    triggerBody({
      value: { action: 'bess_auto_dispatch', request_id: '', request_name: 'x', business_type: '千川' },
    }),
    { client },
  );

  assert.equal(result.body.toast.type, 'error');
  assert.equal(result.errorCode, 'INVALID_REQUEST_ID');
  assert.equal(client.calls.length, 0);
});

test('功能开关关闭：拒绝派单', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(triggerBody(), { client, config: { featureEnabled: 'false' } });

  assert.equal(result.body.toast.type, 'info');
  assert.equal(result.errorCode, 'FEATURE_DISABLED');
  assert.equal(client.calls.length, 0);
});

test('群白名单未配置：fail-closed 拒绝派单', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(triggerBody(), { client, config: { allowedChatIds: '' } });

  assert.equal(result.body.toast.type, 'error');
  assert.equal(result.errorCode, 'CHAT_ALLOWLIST_NOT_CONFIGURED');
  assert.equal(client.calls.length, 0);
});

test('非白名单群：拒绝派单', async () => {
  const client = new FakeLarkClient();
  const result = await runDispatch(triggerBody({ chatId: 'oc_other' }), { client });

  assert.equal(result.body.toast.type, 'error');
  assert.match(result.body.toast.content, /当前群未开启自动派单/);
  assert.equal(result.errorCode, 'CHAT_NOT_ALLOWED');
  assert.equal(client.calls.length, 0);
});

test('缺少操作者或原消息 ID：返回可理解错误', async () => {
  const client = new FakeLarkClient();
  const noOperator = await runDispatch(triggerBody({ operatorOpenId: '' }), { client });
  assert.equal(noOperator.errorCode, 'MISSING_OPERATOR');

  const noMessage = await runDispatch(triggerBody({ messageId: '' }), { client });
  assert.equal(noMessage.errorCode, 'MISSING_MESSAGE_ID');
  assert.equal(client.calls.length, 0);
});

test('并发重复点击：第二次返回处理中，只创建一个话题', async () => {
  let releaseReply;
  const blocked = new Promise((resolve) => {
    releaseReply = resolve;
  });
  const client = new FakeLarkClient({ message: interactiveMessage('806100') });
  client.replyMessage = async (args) => {
    client.calls.push({ kind: 'reply', ...args });
    await blocked;
    return { message_id: 'om_reply_x' };
  };

  const first = runDispatch(triggerBody({ requestId: '806100', eventId: 'evt_a' }), { client });
  // Give the first call a tick to register the in-flight marker.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await runDispatch(triggerBody({ requestId: '806100', eventId: 'evt_b' }), { client });

  assert.equal(second.body.toast.type, 'info');
  assert.equal(second.errorCode, 'IN_FLIGHT');
  releaseReply();
  const firstResult = await first;
  assert.equal(firstResult.body.toast.type, 'success');
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 1);
});

test('成功后重复点击：幂等返回已派单，不再调用 OpenAPI', async () => {
  const client = new FakeLarkClient({ message: interactiveMessage('806200') });
  const first = await runDispatch(triggerBody({ requestId: '806200', eventId: 'evt_c' }), { client });
  assert.equal(first.body.toast.type, 'success');
  const callsAfterFirst = client.calls.length;

  const replay = await runDispatch(triggerBody({ requestId: '806200', eventId: 'evt_d' }), { client });
  assert.equal(replay.body.toast.type, 'success');
  assert.equal(replay.errorCode, 'ALREADY_DISPATCHED');
  assert.equal(client.calls.length, callsAfterFirst);
});

test('回复消息失败：错误 Toast 且不回写卡片', async () => {
  const client = new FakeLarkClient({ replyError: new LarkApiError('LARK_API_230001', 'boom') });
  const result = await runDispatch(triggerBody({ requestId: '806300' }), { client });

  assert.equal(result.body.toast.type, 'error');
  assert.match(result.body.toast.content, /派单失败/);
  assert.equal(result.errorCode, 'LARK_API_230001');
  assert.ok(!result.body.card);
});

test('读取原卡片失败：话题已创建但降级为警告 Toast', async () => {
  const client = new FakeLarkClient({ getMessageError: new LarkApiError('LARK_API_TIMEOUT', 'slow') });
  const result = await runDispatch(triggerBody({ requestId: '806400' }), { client });

  assert.equal(result.body.toast.type, 'warning');
  assert.match(result.body.toast.content, /派单话题已创建/);
  assert.ok(!result.body.card);
  assert.ok(client.calls.some((call) => call.kind === 'reply'));
});

test('原消息非交互卡片：降级为警告 Toast', async () => {
  const client = new FakeLarkClient({ message: { msg_type: 'text', body: { content: '{}' } } });
  const result = await runDispatch(triggerBody({ requestId: '806500' }), { client });

  assert.equal(result.body.toast.type, 'warning');
  assert.ok(!result.body.card);
});

test('卡片中找不到对应按钮：降级为警告 Toast', async () => {
  const client = new FakeLarkClient({ message: interactiveMessage('999999') });
  const result = await runDispatch(triggerBody({ requestId: '806600' }), { client });

  assert.equal(result.body.toast.type, 'warning');
  assert.ok(!result.body.card);
});
