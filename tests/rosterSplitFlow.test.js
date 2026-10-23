import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

class FakeClient {
  constructor() {
    this.calls = [];
  }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    return { message_id: 'om_form' };
  }
  async replyMessage(args) {
    this.calls.push({ kind: 'replyMessage', ...args });
    return { message_id: 'om_audit' };
  }
  async updateMessageCard(id, card) {
    this.calls.push({ kind: 'update', id, card });
  }
  async writeSheetAssignee(args) {
    this.calls.push({ kind: 'write', ...args });
  }
  async getMessage() { return { msg_type: 'interactive', body: { content: '{}' } }; }
  async readSheetDispatchRows(args) {
    return args.selectLatest([], 1);
  }
  async readSheetAssignee() { return ''; }
}

const options = (store, client) => ({
  store,
  client,
  config: { allowedChatIds: 'oc_allowed', featureEnabled: 'true' },
  logger: { info() {} },
  now: () => new Date('2026-09-03T01:00:00Z'),
});

test('名单保存与派单拆分：单条派单流程', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dispatchValue = {
    action: 'bess_auto_dispatch', request_id: 'req_1', request_name: '需求1',
    business_type: '千川', sheet_url: 'u', sheet_id: 's', row_index: 10,
    date_field_id: 'H', assignee_field_id: 'J'
  };

  // 1. 点击按钮，因为未初始化，应返回名单表单
  const event1 = {
    header: { event_id: 'evt_1' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: dispatchValue },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };
  const result1 = await handleDispatchEvent(event1, options(store, client));
  assert.equal(result1.httpStatus, 200);
  assert.match(result1.body.toast.content, /填写今日在班名单/);

  // 2. 提交名单，应保存并返回成功卡片，但不执行派单（不写表）
  const event2 = {
    header: { event_id: 'evt_2' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { roster_names: '张三,李四', shuffle_roster: false },
        tag: 'dispatch_roster_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  };
  const result2 = await handleDispatchEvent(event2, options(store, client));
  assert.equal(result2.httpStatus, 200);
  assert.match(result2.body.toast.content, /今日名单已保存/);
  
  const savedCard = result2.updatedCard;
  const startButton = savedCard.body.elements.find(el => el.tag === 'button' && el.text.content.includes('开始自动派单'));
  assert.ok(startButton, '应包含“开始自动派单”按钮');
  assert.equal(startButton.behaviors[0].value.action, 'bess_auto_dispatch');

  const writeCall = client.calls.find(c => c.kind === 'write');
  assert.ok(!writeCall, '保存名单时不应触发写表');

  // 3. 点击“开始派单”，触发实际派单
  const event3 = {
    header: { event_id: 'evt_3' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: startButton.behaviors[0].value },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };
  const result3 = await handleDispatchEvent(event3, options(store, client));
  assert.equal(result3.httpStatus, 200);
  assert.match(result3.body.toast.content, /派单成功：张三/);
  
  const writeCallFinal = client.calls.find(c => c.kind === 'write');
  assert.ok(writeCallFinal, '点击开始派单后应触发写表');
  assert.equal(writeCallFinal.assignee, '张三');
});

test('过期数据清理失败不应阻断名单保存', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const logs = [];
  const now = () => new Date('2026-10-22T04:00:49Z');

  await store.savePending({
    form_message_id: 'om_cleanup_conflict',
    request_id: 'req_cleanup_conflict',
    original_message_id: 'om_original',
    chat_id: 'oc_allowed',
    request_context: {
      requestId: 'req_cleanup_conflict', requestName: '需求', businessType: '千川',
      sheetUrl: 'u', sheetId: 's', rowIndex: 10, dateFieldId: 'H', assigneeFieldId: 'J',
    },
    expires_at: '2026-10-23T00:00:00Z',
  });
  store.cleanupExpired = async () => {
    const error = new Error('expired pending form is still referenced');
    error.code = 'DISPATCH_DB_ERROR';
    throw error;
  };

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_cleanup_conflict' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { roster_names: '张三,李四', shuffle_roster: false },
        tag: 'dispatch_roster_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_cleanup_conflict' },
    },
  }, {
    store,
    client,
    config: { allowedChatIds: 'oc_allowed', featureEnabled: 'true' },
    logger: { info(entry) { logs.push(JSON.parse(entry)); } },
    now,
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.errorCode, undefined);
  assert.match(result.body.toast.content, /今日名单已保存/);
  assert.ok(logs.some((entry) => entry.stage === 'cleanup_failed'
    && entry.error_code === 'DISPATCH_DB_ERROR'));
});

test('名单保存与派单拆分：批量派单流程', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const batchValue = {
    action: 'bess_batch_auto_dispatch',
    batch_id: 'batch_1',
    items: [
      { action: 'bess_auto_dispatch', request_id: 'req_1', request_name: '需求1', business_type: '千川', sheet_url: 'u', sheet_id: 's', row_index: 10, date_field_id: 'H', assignee_field_id: 'J' },
      { action: 'bess_auto_dispatch', request_id: 'req_2', request_name: '需求2', business_type: '千川', sheet_url: 'u', sheet_id: 's', row_index: 11, date_field_id: 'H', assignee_field_id: 'J' }
    ]
  };

  // 1. 提交名单表单
  const batchItems = batchValue.items.map(item => ({
    requestId: item.request_id,
    requestName: item.request_name,
    businessType: item.business_type,
    sheetUrl: item.sheet_url,
    sheetId: item.sheet_id,
    rowIndex: item.row_index,
    dateFieldId: item.date_field_id,
    assigneeFieldId: item.assignee_field_id,
    batchCard: true
  }));

  // 先伪造一个 pending 状态，模拟 handleDispatchEvent 已经返回了表单
  await store.savePending({
    form_message_id: 'om_form_batch', request_id: 'batch_batch_1',
    original_message_id: 'om_original', chat_id: 'oc_allowed',
    request_context: { batchId: 'batch_1', items: batchItems, kind: 'batch' }, expires_at: '2026-09-04T00:00:00Z'
  });

  const eventForm = {
    header: { event_id: 'evt_batch_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { roster_names: '王五,赵六', shuffle_roster: false },
        tag: 'dispatch_roster_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form_batch' },
    },
  };

  const resultForm = await handleDispatchEvent(eventForm, options(store, client));
  assert.equal(resultForm.httpStatus, 200);
  assert.match(resultForm.body.toast.content, /今日名单已保存/);
  
  const savedCard = resultForm.updatedCard;
  const startButton = savedCard.body.elements.find(el => el.tag === 'button' && el.text.content.includes('开始自动派单'));
  assert.ok(startButton, '应包含“开始自动派单”按钮');
  assert.equal(startButton.behaviors[0].value.action, 'bess_batch_auto_dispatch');

  // 2. 点击“开始批量派单”
  const eventStart = {
    header: { event_id: 'evt_batch_start' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: startButton.behaviors[0].value },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };

  const resultStart = await handleDispatchEvent(eventStart, options(store, client));
  assert.equal(resultStart.httpStatus, 200);
  assert.match(resultStart.body.toast.content, /批量派单请求已受理/);

  // 模拟 background 处理
  await resultStart.afterResponse();

  const writeCalls = client.calls.filter(c => c.kind === 'write');
  assert.equal(writeCalls.length, 2);
  assert.equal(writeCalls[0].assignee, '王五');
  assert.equal(writeCalls[1].assignee, '赵六');
});
