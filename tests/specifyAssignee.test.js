import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { validateSpecifyAssigneeValue } from '../lib/lark/card-actions.js';

const actionValue = {
  schema_version: 1,
  action: 'bess_specify_assignee',
  request_id: 'ad_9001',
  request_name: 'AD 指定负责人测试',
  business_type: 'AD',
  target_category: 'qianchuan_ad',
  sheet_url: 'https://bytedance.larkoffice.com/wiki/N7tlw50bliGg87kk3ZmciPECnKe?sheet=Vp2A6O',
  sheet_id: 'Vp2A6O',
  row_index: 12,
  date_field_id: 'A',
  date_field_name: '需求创建时间',
  assignee_field_id: 'F',
  assignee_field_name: '回扫人',
};

function event({ form = false } = {}) {
  return {
    header: { event_id: form ? 'evt_submit' : 'evt_open' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: form
        ? { tag: 'button', value: {}, form_value: { assignee_name: '周杰' } }
        : { tag: 'button', value: actionValue },
      context: {
        open_chat_id: 'oc_allowed',
        open_message_id: form ? 'om_specify_form' : 'om_original',
      },
    },
  };
}

function rosterSubmitEvent() {
  return {
    header: { event_id: 'evt_roster_submit' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'button', value: {}, form_value: { roster_names: '周杰\n张三' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_roster_form' },
    },
  };
}

class Store {
  constructor({ initialized = true } = {}) {
    this.pending = new Map();
    this.state = initialized ? { roster: ['周杰', '张三'], off_duty: [] } : null;
  }
  async cleanupExpired() {}
  async getDailyState(_dayKey, scope) { this.lastScope = scope; return this.state; }
  async getAssignment(_dayKey, requestId) {
    const assignee = this.assignments?.get(requestId);
    return assignee ? { assignee } : null;
  }
  async initializeRoster({ scope, roster }) {
    this.lastScope = scope;
    this.state ||= { roster, off_duty: [] };
    return this.state;
  }
  async savePending(row) { this.pending.set(row.form_message_id, { ...row, completed_at: null }); return row; }
  async getPending(id, _now, { includeCompleted = false } = {}) {
    const row = this.pending.get(id) || null;
    return !includeCompleted && row?.completed_at ? null : row;
  }
  async markPendingCompleted(id, at, requestContext = undefined) {
    const row = this.pending.get(id);
    row.completed_at = at.toISOString();
    if (requestContext !== undefined) row.request_context = requestContext;
    return row;
  }
  async assignSpecific({ scope, requestId, assignee }) {
    this.lastScope = scope;
    this.assignments ||= new Map();
    const existing = this.assignments.get(requestId);
    if (existing) return { assignee: existing, replayed: true };
    this.assignments.set(requestId, assignee);
    return { assignee, replayed: false };
  }
  async calibrateCursor({ direction, assignee, roster }) {
    this.calibration = { direction, assignee, roster };
    return this.state;
  }
}

class Client {
  constructor(currentAssignee = '') { this.currentAssignee = currentAssignee; this.calls = []; }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'reply', ...args });
    if (args.uuid?.startsWith('bess-specify-roster-')) return { message_id: 'om_roster_form' };
    return { message_id: 'om_specify_form' };
  }
  async getSheetValues(args) { this.calls.push({ kind: 'read', ...args }); return [[this.currentAssignee]]; }
  async writeSheetAssignee(args) { this.calls.push({ ...args, operation: 'write' }); this.currentAssignee = args.assignee; }
  async getMessage(messageId) { this.calls.push({ kind: 'get', messageId }); return null; }
  async updateMessageCard(messageId, card) { this.calls.push({ kind: 'update', messageId, card }); }
}

const options = (store, client) => ({
  store, client,
  config: { allowedChatIds: 'oc_allowed' },
  logger: { info() {} },
  now: () => new Date('2026-09-24T08:00:00Z'),
});

test('指定人员按钮复用派单字段校验并保留 AD 的 A/F 列绑定', () => {
  const fields = validateSpecifyAssigneeValue(actionValue);
  assert.equal(fields.businessType, 'AD');
  assert.equal(fields.sheetId, 'Vp2A6O');
  assert.equal(fields.sheetUrl, 'https://bytedance.larkoffice.com/sheets/YS8FsohUyhUfxhtNnKXc6vApnUb');
  assert.equal(fields.dateFieldId, 'A');
  assert.equal(fields.assigneeFieldId, 'F');
});

test('指定人员首次操作：先录入对应 scope 在班名单，再继续创建指定人员表单', async () => {
  const store = new Store({ initialized: false });
  const client = new Client();

  const opened = await handleDispatchEvent(event(), options(store, client));
  assert.equal(opened.body.toast.type, 'success');
  assert.match(opened.body.toast.content, /先填写.*在班人员名单/);
  assert.equal(store.pending.get('om_roster_form').request_context.kind, 'specify_assignee_roster');
  assert.match(JSON.stringify(client.calls.find((call) => call.kind === 'reply').card), /roster_names/);

  const continued = await handleDispatchEvent(rosterSubmitEvent(), options(store, client));
  assert.equal(continued.body.toast.type, 'success');
  assert.deepEqual(new Set(store.state.roster), new Set(['周杰', '张三']));
  assert.ok(store.pending.get('om_roster_form').completed_at);
  assert.equal(store.pending.get('om_specify_form').request_context.kind, 'specify_assignee');
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 2);
  assert.match(JSON.stringify(continued.updatedCard), /AD 名单已保存/);
  const specifyFormReply = client.calls.filter((call) => call.kind === 'reply').at(-1);
  assert.match(JSON.stringify(specifyFormReply.card), /指定.*负责人/);
});

test('指定人员首次操作：后续指定表单创建失败时名单表单保持可重试', async () => {
  const store = new Store({ initialized: false });
  const client = new Client();
  await handleDispatchEvent(event(), options(store, client));
  const originalReply = client.replyInteractiveCard.bind(client);
  client.replyInteractiveCard = async (args) => {
    if (args.uuid?.startsWith('bess-specify-') && !args.uuid.startsWith('bess-specify-roster-')) {
      throw new Error('temporary reply failure');
    }
    return originalReply(args);
  };

  const failed = await handleDispatchEvent(rosterSubmitEvent(), options(store, client));
  assert.equal(failed.body.toast.type, 'error');
  assert.equal(store.pending.get('om_roster_form').completed_at, null);
});

test('指定人员：创建单条需求表单并写回 AD 回扫人列', async () => {
  const store = new Store();
  const client = new Client();
  const opened = await handleDispatchEvent(event(), options(store, client));
  assert.equal(opened.body.toast.type, 'success');
  const pending = store.pending.get('om_specify_form');
  assert.equal(pending.request_context.kind, 'specify_assignee');
  assert.equal(pending.request_context.assigneeFieldId, 'F');
  const formReply = client.calls.find((call) => call.kind === 'reply');
  assert.match(JSON.stringify(formReply.card), /assignee_name/);

  const submitted = await handleDispatchEvent(event({ form: true }), options(store, client));
  assert.equal(submitted.body.toast.type, 'success');
  assert.match(JSON.stringify(submitted.updatedCard), /已指定负责人/);
  const write = client.calls.find((call) => call.operation === 'write');
  assert.ok(write, JSON.stringify({ submitted, calls: client.calls }));
  assert.equal(write.sheetId, 'Vp2A6O');
  assert.equal(write.assigneeFieldId, 'F');
  assert.equal(write.rowIndex, 12);
  assert.equal(write.assignee, '周杰');
  assert.ok(store.pending.get('om_specify_form').completed_at);
});

test('指定人员：目标单元格已有其他负责人时按钮入口即拒绝且不创建表单', async () => {
  const store = new Store();
  const client = new Client('张三');
  const opened = await handleDispatchEvent(event(), options(store, client));
  assert.equal(opened.body.toast.type, 'error');
  assert.equal(opened.errorCode, 'ASSIGNEE_ALREADY_SET');
  assert.equal(client.calls.some((call) => call.kind === 'reply'), false);
  assert.equal(client.calls.some((call) => call.operation === 'write'), false);
});

test('指定人员：数据库预留存在但表格为空时只允许原负责人幂等补写', async () => {
  const store = new Store();
  store.assignments = new Map([['ad_9001', '周杰']]);
  const client = new Client();
  const opened = await handleDispatchEvent(event(), options(store, client));
  assert.equal(opened.body.toast.type, 'success');
  const form = client.calls.find((call) => call.kind === 'reply').card;
  assert.match(JSON.stringify(form), /周杰/);
  assert.doesNotMatch(JSON.stringify(form), /张三/);

  const submitted = await handleDispatchEvent(event({ form: true }), options(store, client));
  assert.equal(submitted.body.toast.type, 'success');
  assert.ok(client.calls.some((call) => call.operation === 'write' && call.assignee === '周杰'));
});

test('指定人员：并发预留已有其他负责人时拒绝覆盖', async () => {
  const store = new Store();
  const client = new Client();
  await handleDispatchEvent(event(), options(store, client));
  store.assignments = new Map([['ad_9001', '张三']]);
  const submitted = await handleDispatchEvent(event({ form: true }), options(store, client));
  assert.equal(submitted.body.toast.type, 'error');
  assert.equal(submitted.errorCode, 'ASSIGNEE_ALREADY_SET');
  assert.equal(client.calls.some((call) => call.operation === 'write'), false);
});

test('指定人员：拒绝工号且不写表', async () => {
  const store = new Store();
  const client = new Client();
  await handleDispatchEvent(event(), options(store, client));
  const invalid = event({ form: true });
  invalid.event.action.form_value.assignee_name = '123456';
  const submitted = await handleDispatchEvent(invalid, options(store, client));
  assert.equal(submitted.body.toast.type, 'error');
  assert.equal(submitted.errorCode, 'INVALID_ROSTER');
  assert.equal(client.calls.some((call) => call.operation === 'write'), false);
});

// Historical AD/game identity was later registered in a source. New forms must
// retain the proven server-side origin through open, roster continuation/retry,
// assignment compensation and completed replay.
for (const initialized of [true, false]) test(`历史AD游戏旧卡→指定表单→提交/补偿/完成重试，initialized=${initialized}`, async () => {
  const store = new Store({ initialized }); const client = new Client();
  const body = event();
  body.event.action.value = { ...actionValue, target_category: 'game_agent', dispatch_profile: 'ad',
    sheet_id: 'gameSheet', sheet_url: 'https://example.feishu.cn/sheets/game', date_field_id: 'J', assignee_field_id: 'B' };
  const guards = [];
  store.assertLegacySourceCardMembers = async ({ chatId, messageId, items }) => {
    guards.push(messageId);
    assert.equal(chatId, 'oc_allowed'); assert.equal(messageId, 'om_original');
    assert.equal(items[0].requestId, 'ad_9001');
    assert.equal(items[0].dispatchProfile, 'ad'); assert.equal(items[0].targetCategory, 'game_agent');
  };
  const opened = await handleDispatchEvent(body, options(store, client));
  assert.equal(opened.errorCode, undefined);
  if (!initialized) {
    const reply = client.replyInteractiveCard.bind(client); let fail = true;
    client.replyInteractiveCard = async (args) => {
      if (fail && args.uuid.startsWith('bess-specify-') && !args.uuid.startsWith('bess-specify-roster-')) {
        fail = false; throw new Error('isolated form reply failure');
      }
      return reply(args);
    };
    const failed = await handleDispatchEvent(rosterSubmitEvent(), options(store, client));
    assert.equal(failed.body.toast.type, 'error');
    assert.equal(store.pending.get('om_roster_form').completed_at, null);
    const continued = await handleDispatchEvent(rosterSubmitEvent(), options(store, client));
    assert.equal(continued.errorCode, undefined);
  }
  const pending = store.pending.get('om_specify_form');
  assert.equal(pending.original_message_id, 'om_original');
  assert.equal(pending.chat_id, 'oc_allowed'); assert.equal(pending.request_context.dispatchScope, 'ad_game');
  const calibration = store.calibrateCursor.bind(store); let fail = true;
  store.calibrateCursor = async (args) => { if (fail) { fail = false; throw new Error('isolated calibration failure'); } return calibration(args); };
  const submit = event({ form: true });
  // Neither action nor form data is allowed to override the pending origin/context.
  submit.event.action.value = { original_message_id: 'om_attacker', request_id: 'attacker' };
  submit.event.action.form_value.original_message_id = 'om_attacker';
  const failed = await handleDispatchEvent(submit, options(store, client));
  assert.equal(failed.body.toast.type, 'error'); assert.equal(pending.completed_at, null);
  const completed = await handleDispatchEvent(submit, options(store, client));
  assert.equal(completed.errorCode, undefined); assert.ok(pending.completed_at);
  const replay = await handleDispatchEvent(submit, options(store, client));
  assert.equal(replay.errorCode, 'ALREADY_SPECIFIED');
  assert.equal(client.calls.filter((call) => call.operation === 'write').length, 1);
  assert.ok(guards.length >= (initialized ? 4 : 6));
});

for (const [name, mutate, code] of [
  ['cross chat', (p) => { p.chat_id = 'oc_other'; }, 'PENDING_CHAT_MISMATCH'],
  ['wrong form', (p) => { p.form_message_id = 'om_other'; }, 'PENDING_CONTEXT_MISMATCH'],
  ['wrong request', (p) => { p.request_id = 'specify_other'; }, 'PENDING_CONTEXT_MISMATCH'],
  ['wrong context chat', (p) => { p.request_context.chatId = 'oc_other'; }, 'PENDING_CONTEXT_MISMATCH'],
  ['wrong kind', (p) => { p.request_context.kind = 'batch'; }, 'INVALID_PENDING_KIND'],
  ['missing origin', (p) => { delete p.original_message_id; }, 'SOURCE_CARD_BINDING_CONFLICT'],
  ['unproven origin', (p) => { p.original_message_id = 'om_stripped_source'; }, 'SOURCE_CARD_BINDING_CONFLICT'],
  ['wrong member', (p) => { p.request_context.requestId = 'other_registered_member'; p.request_id = 'specify_other_registered_member'; }, 'SOURCE_CARD_BINDING_CONFLICT'],
]) test(`历史指定submit拒绝${name}，不读表/派单/完成/更新卡`, async () => {
  const store = new Store(); const client = new Client(); const body = event();
  body.event.action.value = { ...actionValue, target_category: 'game_agent', dispatch_profile: 'ad',
    sheet_id: 'gameSheet', sheet_url: 'https://example.feishu.cn/sheets/game', date_field_id: 'J', assignee_field_id: 'B' };
  store.assertLegacySourceCardMembers = async ({ messageId, items }) => {
    if (messageId !== 'om_original' || items[0].requestId !== 'ad_9001') {
      throw Object.assign(new Error('conflict'), { code: 'SOURCE_CARD_BINDING_CONFLICT' });
    }
  };
  await handleDispatchEvent(body, options(store, client));
  mutate(store.pending.get('om_specify_form')); client.calls = [];
  const result = await handleDispatchEvent(event({ form: true }), options(store, client));
  assert.equal(result.errorCode, code); assert.deepEqual(client.calls, []);
  assert.equal(store.assignments, undefined); assert.equal(store.pending.get('om_specify_form').completed_at, null);
});
