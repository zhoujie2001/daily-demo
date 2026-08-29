import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoster, secureShuffle, shanghaiDay, nextShanghaiMidnight, dispatchDirection, RosterValidationError } from '../lib/dispatch/roster.js';
import { buildRosterFormCard, buildDispatchResultCard } from '../lib/lark/card-renderer.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { LarkApiError, LarkClient } from '../lib/lark/client.js';

const fields = {
  requestId: 'p1_1', requestName: 'P1 需求', businessType: '千川', cardTitle: '派单',
  sheetUrl: 'https://example.feishu.cn/sheets/token123', sheetId: 'sheetA', rowIndex: 8,
  assigneeFieldId: 'D', assigneeFieldName: '负责人',
};

function body({ form = false, requestId = 'p1_1', businessType = '千川', messageId = 'om_original' } = {}) {
  return {
    header: { event_id: `evt_${requestId}` },
    event: {
      token: form ? '' : 'update-token', operator: { open_id: 'ou_1' },
      action: form ? {
        tag: 'button', value: { action: 'bess_roster_submit' },
        form_value: { roster_names: '张三、李四；王五' },
      } : {
        tag: 'button', value: {
          schema_version: 1, action: 'bess_auto_dispatch', request_id: requestId,
          request_name: 'P1 需求', business_type: businessType, sheet_url: fields.sheetUrl,
          sheet_id: fields.sheetId, row_index: fields.rowIndex,
          assignee_field_id: fields.assigneeFieldId, assignee_field_name: fields.assigneeFieldName,
        },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: messageId },
    },
  };
}

class FakeStore {
  constructor() { this.state = null; this.pending = new Map(); this.assignments = new Map(); this.forward = 0; this.reverse = 0; this.cleanupCalls = 0; this.assignCalls = 0; }
  async cleanupExpired() { this.cleanupCalls += 1; }
  async getDailyState() { return this.state; }
  async savePending(row) { this.pending.set(row.form_message_id, { ...row, completed_at: null }); return row; }
  async getPending(id, _now, { includeCompleted = false } = {}) {
    const row = this.pending.get(id) || null;
    return !includeCompleted && row?.completed_at ? null : row;
  }
  async markPendingCompleted(id, at) { const row = this.pending.get(id); row.completed_at = at.toISOString(); return row; }
  async assign({ requestId, direction, roster }) {
    this.assignCalls += 1;
    if (this.assignments.has(requestId)) return { ...this.assignments.get(requestId), roster: this.state.roster, replayed: true };
    if (!this.state) this.state = { roster };
    const list = this.state.roster;
    const index = direction === 'forward' ? this.forward++ % list.length : list.length - 1 - (this.reverse++ % list.length);
    const assignment = { assignee: list[index], direction };
    this.assignments.set(requestId, assignment);
    return { ...assignment, roster: list, replayed: false };
  }
}

class FakeClient {
  constructor({ failUpdateOnce = false, failDelay = false } = {}) { this.calls = []; this.failUpdateOnce = failUpdateOnce; this.failDelay = failDelay; }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    return { message_id: args.uuid.startsWith('bess-form') ? 'om_form' : 'om_result' };
  }
  async writeSheetAssignee(args) { this.calls.push({ kind: 'write', ...args }); }
  async getMessage(messageId) { this.calls.push({ kind: 'get', messageId }); return null; }
  async updateMessageCard(messageId, card) {
    this.calls.push({ kind: 'update', messageId, card });
    if (this.failUpdateOnce) { this.failUpdateOnce = false; throw new LarkApiError('LARK_API_TIMEOUT', 'timeout'); }
  }
  async delayUpdateMessageCard(token, card) {
    this.calls.push({ kind: 'delay', token, card });
    if (this.failDelay) throw new LarkApiError('LARK_API_TIMEOUT', 'sensitive upstream detail');
  }
}

const options = (store, client) => ({ store, client, config: { allowedChatIds: 'oc_allowed' }, logger: { info() {} }, now: () => new Date('2026-08-30T01:00:00Z') });

test('姓名解析支持多种分隔符并拒绝纯数字、工号形态和重复值', () => {
  assert.deepEqual(parseRoster('张三，李四、王五;赵六\nAlice Wu'), ['张三', '李四', '王五', '赵六', 'Alice Wu']);
  assert.throws(() => parseRoster('12345、张三'), RosterValidationError);
  assert.throws(() => parseRoster('A001、张三'), RosterValidationError);
  assert.throws(() => parseRoster('张三、张三'), RosterValidationError);
});

test('Fisher–Yates 使用注入的安全随机源且不修改原名单', () => {
  const source = ['甲甲', '乙乙', '丙丙'];
  const values = [0, 1];
  assert.deepEqual(secureShuffle(source, () => values.shift()), ['丙丙', '乙乙', '甲甲']);
  assert.deepEqual(source, ['甲甲', '乙乙', '丙丙']);
});

test('上海日界线和次日零点正确，业务方向符合规则', () => {
  const now = new Date('2026-08-30T15:59:59Z');
  assert.equal(shanghaiDay(now), '2026-08-30');
  assert.equal(nextShanghaiMidnight(now), '2026-08-30T16:00:00.000Z');
  assert.equal(shanghaiDay(new Date('2026-08-30T16:00:00Z')), '2026-08-31');
  assert.equal(dispatchDirection('千川'), 'forward');
  for (const type of ['本地推', '本地', '存量', '其它', 'EHC']) assert.equal(dispatchDirection(type), 'reverse');
});

test('首次点击无名单：创建话题 Card 2.0 表单并保存 pending 映射，不提前派单', async () => {
  const store = new FakeStore();
  const client = new FakeClient();
  const result = await handleDispatchEvent(body(), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.size, 0);
  assert.equal(store.pending.get('om_form').original_message_id, 'om_original');
  const call = client.calls.find((item) => item.kind === 'replyCard');
  assert.equal(call.replyInThread, true);
  assert.equal(call.card.schema, '2.0');
  const form = call.card.body.elements[1];
  assert.equal(form.tag, 'form');
  assert.equal(form.name, 'dispatch_roster_form');
  const [input, submit] = form.elements;
  assert.deepEqual({ tag: input.tag, name: input.name, inputType: input.input_type }, {
    tag: 'input', name: 'roster_names', inputType: 'multiline_text',
  });
  assert.ok(input.max_length <= 1000);
  assert.equal(submit.tag, 'button');
  assert.equal(submit.name, 'dispatch_roster_submit');
  assert.equal(submit.form_action_type, 'submit');
  assert.notEqual(input.name, submit.name);
});

test('首次表单提交：按 message_id 找回原请求、立即派单、写表、发结果卡并置灰原卡', async () => {
  const store = new FakeStore();
  const client = new FakeClient();
  await handleDispatchEvent(body(), options(store, client));
  const result = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.size, 1);
  assert.equal(client.calls.find((item) => item.kind === 'write').assignee, store.assignments.get('p1_1').assignee);
  const resultCard = client.calls.filter((item) => item.kind === 'replyCard').at(-1).card;
  assert.match(JSON.stringify(resultCard), /正序名单（从上到下）/);
  assert.match(JSON.stringify(resultCard), /倒序名单（从下到上）/);
  const update = client.calls.find((item) => item.kind === 'update');
  assert.equal(update.messageId, 'om_original');
  assert.equal(update.card.body.elements.at(-1).disabled, true);
  assert.ok(store.pending.get('om_form').completed_at, '全部外部副作用成功后才标记 pending 完成');
});

test('外部消息更新失败时保留 pending，重试复用同一 assignment 和原消息关联', async () => {
  const store = new FakeStore();
  const client = new FakeClient({ failUpdateOnce: true });
  await handleDispatchEvent(body(), options(store, client));

  const failed = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(failed.body.toast.type, 'error');
  assert.equal(store.pending.get('om_form').completed_at, null);
  const firstAssignee = store.assignments.get('p1_1').assignee;

  const retried = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(retried.body.toast.type, 'success');
  assert.equal(store.assignments.get('p1_1').assignee, firstAssignee);
  assert.equal(store.assignments.size, 1);
  assert.equal(store.assignCalls, 2, 'RPC 可重试并返回已有 assignment');
  assert.ok(store.pending.get('om_form').completed_at);
  assert.ok(client.calls.filter((item) => item.kind === 'update').every((item) => item.messageId === 'om_original'));
});

test('同日正序/倒序游标独立，重复 request_id 跨实例语义幂等', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  assert.equal((await store.assign({ requestId: 'a', direction: 'forward' })).assignee, '张三');
  assert.equal((await store.assign({ requestId: 'b', direction: 'reverse' })).assignee, '王五');
  assert.equal((await store.assign({ requestId: 'c', direction: 'forward' })).assignee, '李四');
  const replay = await store.assign({ requestId: 'a', direction: 'reverse' });
  assert.equal(replay.assignee, '张三');
  assert.equal(replay.replayed, true);
});

test('表单卡与结果卡包含黄色正序、蓝色倒序和完整名单', () => {
  const form = buildRosterFormCard(fields);
  assert.match(JSON.stringify(form), /roster_names/);
  const card = buildDispatchResultCard(fields, { assignee: '李四', direction: 'reverse', roster: ['张三', '李四'], dispatchedAt: 't' });
  const text = JSON.stringify(card);
  assert.match(text, /yellow/);
  assert.match(text, /blue/);
  assert.match(text, /张三/);
  assert.match(text, /李四/);
});

test('电子表格按列字母写入后 GET 回读，不一致即失败', async () => {
  let readValue = '张三';
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request });
    if (String(url).includes('tenant_access_token')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }) };
    if (request.method === 'PUT') return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0 }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { valueRange: { values: [[readValue]] } } }) };
  };
  const client = new LarkClient({ appId: 'id', appSecret: 'secret', fetchImpl, baseUrl: 'https://open.feishu.test' });
  await client.writeSheetAssignee({ sheetUrl: fields.sheetUrl, sheetId: 'sheetA', rowIndex: 8, assigneeFieldId: 'D', assignee: '张三' });
  assert.match(calls.find((item) => item.request.method === 'PUT').request.body, /sheetA!D8:D8/);
  readValue = '李四';
  await assert.rejects(() => client.writeSheetAssignee({ sheetUrl: fields.sheetUrl, sheetId: 'sheetA', rowIndex: 8, assigneeFieldId: 'D', assignee: '张三' }), (error) => error instanceof LarkApiError && error.code === 'SHEET_READBACK_MISMATCH');
});

test('P1 延迟卡片更新失败会记录脱敏错误码而不是静默吞错', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四'] };
  const client = new FakeClient({ failDelay: true });
  const logs = [];
  const result = await handleDispatchEvent(body({ requestId: 'delay_1' }), {
    ...options(store, client),
    logger: { info(line) { logs.push(JSON.parse(line)); } },
  });
  assert.equal(result.body.toast.type, 'success');
  await result.afterResponse();
  const failure = logs.find((entry) => entry.stage === 'card_update_failed');
  assert.equal(failure.error_code, 'LARK_API_TIMEOUT');
  assert.ok(!JSON.stringify(failure).includes('sensitive upstream detail'));
});

test('已完成表单重提仅返回友好 Toast，不重复写 Sheet、发结果或更新卡片', async () => {
  const store = new FakeStore();
  const client = new FakeClient();
  await handleDispatchEvent(body(), options(store, client));
  await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  const before = {
    assign: store.assignCalls,
    write: client.calls.filter((item) => item.kind === 'write').length,
    reply: client.calls.filter((item) => item.kind === 'replyCard').length,
    update: client.calls.filter((item) => item.kind === 'update').length,
  };

  const replay = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(replay.errorCode, 'FORM_ALREADY_PROCESSED');
  assert.equal(replay.body.toast.type, 'success');
  assert.match(replay.body.toast.content, /已处理/);
  assert.deepEqual({
    assign: store.assignCalls,
    write: client.calls.filter((item) => item.kind === 'write').length,
    reply: client.calls.filter((item) => item.kind === 'replyCard').length,
    update: client.calls.filter((item) => item.kind === 'update').length,
  }, before);
});
