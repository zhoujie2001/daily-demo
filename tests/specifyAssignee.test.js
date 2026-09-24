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
  sheet_url: 'https://bytedance.larkoffice.com/wiki/QKfAwxRAaiRRfvkb73ZchrIBnQb?sheet=288afd',
  sheet_id: '288afd',
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
  assert.equal(fields.sheetId, '288afd');
  assert.equal(fields.sheetUrl, 'https://bytedance.larkoffice.com/sheets/CeBAsJgwnh5mwCtAbgocpVCsnib');
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
  const write = client.calls.find((call) => call.operation === 'write');
  assert.ok(write, JSON.stringify({ submitted, calls: client.calls }));
  assert.equal(write.sheetId, '288afd');
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
