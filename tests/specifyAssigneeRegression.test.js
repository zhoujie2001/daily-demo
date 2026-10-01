import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';

class MockStore {
  constructor() {
    this.roster = ['周杰', '孙琴', '杨新雨', '林志平', '黄鲜'];
    this.state = {
      roster: this.roster,
      off_duty: [],
      forward_cursor: 0,
      reverse_cursor: 0,
      version: 1,
    };
    this.pending = new Map();
    this.assignments = new Map();
    this.calibrateCalls = [];
  }

  async cleanupExpired() {}
  async getDailyState() { return this.state; }
  async getAssignment(_day, id) { 
    const a = this.assignments.get(id);
    return a ? { assignee: a.assignee } : null;
  }
  async getDailyAssignments() { return []; }
  async savePending(row) { this.pending.set(row.form_message_id, row); return row; }
  async getPending(id) { return this.pending.get(id); }
  async markPendingCompleted(id, at, ctx) {
    const p = this.pending.get(id);
    if (p) { p.completed_at = at.toISOString(); p.request_context = ctx; }
  }

  async assignSpecific({ requestId, assignee }) {
    const res = { assignee, replayed: this.assignments.has(requestId) };
    this.assignments.set(requestId, { assignee });
    return res;
  }

  async calibrateCursor({ scope, direction, assignee }) {
    this.calibrateCalls.push({ scope, direction, assignee });
    const idx = this.roster.indexOf(assignee);
    if (direction === 'forward') this.state.forward_cursor = idx + 1;
    else this.state.reverse_cursor = this.roster.length - idx;
    return this.state;
  }

  async assign({ direction }) {
    const count = this.roster.length;
    let idx;
    if (direction === 'forward') {
      idx = this.state.forward_cursor % count;
      this.state.forward_cursor = idx + 1;
    } else {
      idx = count - 1 - (this.state.reverse_cursor % count);
      this.state.reverse_cursor = count - idx;
    }
    const assignee = this.roster[idx];
    return { assignee, roster: this.roster, original_message_id: 'om_1' };
  }
}

class MockClient {
  constructor() { this.calls = []; }
  async getSheetValues() { return [['']]; }
  async writeSheetAssignee(args) { this.calls.push({ kind: 'write', ...args }); }
  async replyInteractiveCard() { return { message_id: 'om_form' }; }
  async getMessage() { return { msg_type: 'interactive', body: { content: '{}' } }; }
  async updateMessageCard() {}
  async delayUpdateMessageCard() {}
  async replyMessage() { return { message_id: 'om_reply' }; }
  async readSheetDispatchRows({ selectLatest }) { return selectLatest([], 1); }
}

const options = (store, client) => ({
  store, client,
  config: { allowedChatIds: 'oc_1', featureEnabled: 'true' },
  logger: { info() {}, warn() {}, error() {} },
  now: () => new Date(),
});

test('本地推指定黄鲜后，下一批从倒序下一位林志平开始', async () => {
  const store = new MockStore();
  const client = new MockClient();

  await store.savePending({
    form_message_id: 'om_form',
    request_context: { kind: 'specify_assignee', businessType: '本地推', requestId: 'req_1', sheetUrl: 'https://sheet.url', sheetId: 's1', rowIndex: 10, assigneeFieldId: 'F' }
  });

  await handleDispatchEvent({
    header: { event_id: 'e1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', form_value: { assignee_name: '黄鲜' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.equal(store.calibrateCalls.length, 1);
  assert.equal(store.state.reverse_cursor, 1);

  const result = await handleDispatchEvent({
    header: { event_id: 'e2', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', value: { action: 'bess_auto_dispatch', business_type: '本地推', request_name: 'test', request_id: 'req_2', sheet_id: 's1', sheet_url: 'https://sheet.url', row_index: 11, date_field_id: 'A', assignee_field_id: 'F' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_2' },
    },
  }, options(store, client));
  
  assert.match(result.body.toast.content, /派单成功：林志平/);
});

test('千川与本地游标互不串扰 (Regression)', async () => {
  const store = new MockStore();
  const client = new MockClient();

  await store.savePending({
    form_message_id: 'om_form',
    request_context: { kind: 'specify_assignee', businessType: '本地推', requestId: 'req_1', sheetUrl: 'https://sheet.url', sheetId: 's1', rowIndex: 10, assigneeFieldId: 'F' }
  });
  await handleDispatchEvent({
    header: { event_id: 'e1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', form_value: { assignee_name: '黄鲜' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.equal(store.state.reverse_cursor, 1);
  assert.equal(store.state.forward_cursor, 0);

  const result = await handleDispatchEvent({
    header: { event_id: 'e2', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', value: { action: 'bess_auto_dispatch', business_type: '千川', request_name: 'test', request_id: 'req_3', sheet_id: 's1', sheet_url: 'https://sheet.url', row_index: 12, date_field_id: 'A', assignee_field_id: 'F' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_3' },
    },
  }, options(store, client));
  assert.match(result.body.toast.content, /派单成功：周杰/);
  assert.equal(store.state.forward_cursor, 1);
});

test('失败不推进游标 (Regression)', async () => {
  const store = new MockStore();
  const client = new MockClient();
  client.writeSheetAssignee = async () => { throw new Error('Sheet write failed'); };

  await store.savePending({
    form_message_id: 'om_form',
    request_context: { kind: 'specify_assignee', businessType: '本地推', requestId: 'req_1', sheetUrl: 'https://sheet.url', sheetId: 's1', rowIndex: 10, assigneeFieldId: 'F' }
  });

  try {
    await handleDispatchEvent({
      header: { event_id: 'e1', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'u1' },
        action: { tag: 'button', form_value: { assignee_name: '黄鲜' } },
        context: { open_chat_id: 'oc_1', open_message_id: 'om_form' },
      },
    }, options(store, client));
  } catch {
    // expected
  }

  assert.equal(store.calibrateCalls.length, 0);
  assert.equal(store.state.reverse_cursor, 0);
});


test('游标校准失败时不把指定表单标记为完成', async () => {
  const store = new MockStore();
  const client = new MockClient();
  store.calibrateCursor = async () => { throw new Error('cursor calibration failed'); };

  await store.savePending({
    form_message_id: 'om_form',
    request_context: { kind: 'specify_assignee', businessType: '本地推', requestId: 'req_1', sheetUrl: 'https://sheet.url', sheetId: 's1', rowIndex: 10, assigneeFieldId: 'F' },
  });

  const result = await handleDispatchEvent({
    header: { event_id: 'e1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', form_value: { assignee_name: '黄鲜' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.equal(result.body.toast.type, 'error');
  assert.equal(store.pending.get('om_form').completed_at, undefined);
});


test('AD 游戏指定人员后重置共享 AD 正序游标，复盘下一条按第四→第三→第二→第一→第五继续', async () => {
  const store = new MockStore();
  const client = new MockClient();

  await store.savePending({
    form_message_id: 'om_ad_form',
    request_context: {
      kind: 'specify_assignee', dispatchProfile: 'ad', businessType: 'AD',
      targetCategory: 'game_agent', requestId: 'ad_game_1', requestName: 'AD 游戏',
      sheetUrl: 'https://sheet.url', sheetId: 'game', rowIndex: 10,
      dateFieldId: 'J', assigneeFieldId: 'B',
    },
  });

  const specified = await handleDispatchEvent({
    header: { event_id: 'ad_e1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', form_value: { assignee_name: '黄鲜' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_ad_form' },
    },
  }, options(store, client));
  assert.equal(specified.body.toast.type, 'success');
  assert.deepEqual(store.calibrateCalls[0], { scope: 'ad', direction: 'reverse', assignee: '黄鲜' });

  const replay = await handleDispatchEvent({
    header: { event_id: 'ad_e2', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'u1' },
      action: { tag: 'button', value: {
        action: 'bess_auto_dispatch', dispatch_profile: 'ad',
        business_type: 'AD', target_category: 'ad', request_name: 'AD 复盘', request_id: 'ad_review_2',
        sheet_id: 'review', sheet_url: 'https://sheet.url', row_index: 11,
        date_field_id: 'J', assignee_field_id: 'B',
      } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_ad_2' },
    },
  }, options(store, client));

  assert.match(replay.body.toast.content, /派单成功：林志平/);
  assert.equal(store.state.forward_cursor, 0);
  assert.equal(store.state.reverse_cursor, 2);
});
