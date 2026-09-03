import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseRoster, secureShuffle, shanghaiDay, nextShanghaiMidnight, dispatchDirection, RosterValidationError } from '../lib/dispatch/roster.js';
import { buildRosterFormCard, buildRosterProcessingCard, buildRosterCompletedCard, buildRosterRetryCard, buildDispatchResultCard } from '../lib/lark/card-renderer.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { LarkApiError, LarkClient } from '../lib/lark/client.js';
import { latestDailyAnchor, sheetDateDay } from '../lib/dispatch/sheet-anchor.js';
import { validateDispatchValue } from '../lib/lark/card-actions.js';

const fields = {
  requestId: 'p1_1', requestName: 'P1 需求', businessType: '千川', cardTitle: '派单',
  sheetUrl: 'https://example.feishu.cn/sheets/token123', sheetId: 'sheetA', rowIndex: 8,
  dateFieldId: 'B', dateFieldName: '提需时间', assigneeFieldId: 'D', assigneeFieldName: '负责人',
};

function body({
  form = false, requestId = 'p1_1', businessType = '千川', targetCategory = '', messageId = 'om_original',
  projectFieldId = '', projectFieldName = '', projectValue = '',
} = {}) {
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
          request_name: 'P1 需求', business_type: businessType, target_category: targetCategory,
          sheet_url: fields.sheetUrl,
          sheet_id: fields.sheetId, row_index: fields.rowIndex,
          date_field_id: fields.dateFieldId, date_field_name: fields.dateFieldName,
          assignee_field_id: fields.assigneeFieldId, assignee_field_name: fields.assigneeFieldName,
          project_field_id: projectFieldId, project_field_name: projectFieldName, project_value: projectValue,
        },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: messageId },
    },
  };
}

class FakeStore {
  constructor() { this.state = null; this.pending = new Map(); this.assignments = new Map(); this.forward = 0; this.reverse = 0; this.cleanupCalls = 0; this.assignCalls = 0; this.assignmentQueries = 0; this.calibrations = []; }
  async cleanupExpired() { this.cleanupCalls += 1; }
  async getDailyState() { return this.state; }
  async savePending(row) { this.pending.set(row.form_message_id, { ...row, completed_at: null }); return row; }
  async getPending(id, _now, { includeCompleted = false } = {}) {
    const row = this.pending.get(id) || null;
    return !includeCompleted && row?.completed_at ? null : row;
  }
  async markPendingCompleted(id, at) { const row = this.pending.get(id); row.completed_at = at.toISOString(); return row; }
  async getAssignment(_dayKey, requestId) {
    this.assignmentQueries += 1;
    return this.assignments.get(requestId) || null;
  }
  async calibrateCursor({ dayKey, assignee, roster }) {
    const index = roster.indexOf(assignee);
    if (index < 0) throw new Error('ASSIGNEE_NOT_IN_ROSTER');
    this.calibrations.push({ dayKey, assignee, roster });
    this.forward = index + 1;
    this.reverse = roster.length - index;
    return { ...(this.state || {}), forward_cursor: this.forward, reverse_cursor: this.reverse };
  }
  async assign({ requestId, direction, roster, context = {} }) {
    this.assignCalls += 1;
    if (this.assignments.has(requestId)) return { ...this.assignments.get(requestId), roster: this.state.roster, replayed: true };
    if (!this.state) this.state = { roster };
    const list = this.state.roster;
    const anchorIndex = list.indexOf(context.anchor_assignee);
    const index = anchorIndex >= 0
      ? (direction === 'forward' ? (anchorIndex + 1) % list.length : (anchorIndex - 1 + list.length) % list.length)
      : (direction === 'forward' ? this.forward % list.length : list.length - 1 - (this.reverse % list.length));
    if (direction === 'forward') this.forward += 1;
    else this.reverse += 1;
    const assignment = { assignee: list[index], direction };
    this.assignments.set(requestId, assignment);
    return { ...assignment, roster: list, replayed: false };
  }
}

class FakeClient {
  constructor({ failUpdateOnce = false, failDelay = false, sheetRows = [] } = {}) { this.calls = []; this.failUpdateOnce = failUpdateOnce; this.failDelay = failDelay; this.sheetRows = sheetRows; }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    return { message_id: args.uuid.startsWith('bess-form') ? 'om_form' : 'om_result' };
  }
  async writeSheetAssignee(args) { this.calls.push({ kind: 'write', ...args }); }
  async readSheetDispatchRows(args) {
    this.calls.push({ kind: 'readRows', ...args });
    if (this.sheetRows.length === 0) return null;
    return typeof args.selectLatest === 'function' ? args.selectLatest(this.sheetRows, 1) : this.sheetRows;
  }
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
  const result = await handleDispatchEvent(body({
    targetCategory: 'qianchuan', projectFieldId: 'C', projectValue: '千川',
  }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.size, 0);
  assert.equal(store.calibrations.length, 0);
  assert.equal(client.calls.filter((item) => item.kind === 'readRows').length, 0, '首次点击不得读取锚点表格');
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

test('名单提交过程卡、完成卡和失败重试卡提供明确状态且不会保留无效按钮', () => {
  const processing = buildRosterProcessingCard();
  assert.match(JSON.stringify(processing), /无需重复点击/);
  assert.doesNotMatch(JSON.stringify(processing), /保存名单并立即派单/);

  const completed = buildRosterCompletedCard(fields, {
    assignee: '周杰', direction: 'forward', dispatchedAt: '2026-08-30 09:00:00',
  });
  assert.match(JSON.stringify(completed), /名单已保存并完成派单/);
  assert.match(JSON.stringify(completed), /周杰/);

  const retry = buildRosterRetryCard('表格写回失败');
  const form = retry.body.elements.find((element) => element.tag === 'form');
  assert.ok(form);
  assert.equal(form.elements.at(-1).form_action_type, 'submit');
  assert.match(JSON.stringify(retry), /重新保存名单并派单/);
});

test('首次表单提交：按 message_id 找回原请求、立即派单、写表、发结果卡并更新原卡与表单卡', async () => {
  const store = new FakeStore();
  const client = new FakeClient();
  await handleDispatchEvent(body(), options(store, client));
  const result = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.size, 1);
  assert.equal(store.calibrations.length, 0);
  assert.equal(client.calls.filter((item) => item.kind === 'readRows').length, 1, '名单提交也应读表保护人工填写的负责人');
  assert.equal(client.calls.find((item) => item.kind === 'write').assignee, store.assignments.get('p1_1').assignee);
  const resultCard = client.calls.filter((item) => item.kind === 'replyCard').at(-1).card;
  assert.match(JSON.stringify(resultCard), /正序名单（从上到下）/);
  assert.match(JSON.stringify(resultCard), /倒序名单（从下到上）/);
  const updates = client.calls.filter((item) => item.kind === 'update');
  const originalUpdate = updates.find((item) => item.messageId === 'om_original');
  const formUpdate = updates.find((item) => item.messageId === 'om_form');
  assert.equal(originalUpdate.card.body.elements.at(-1).disabled, true);
  assert.match(JSON.stringify(formUpdate.card), /名单已保存并完成派单/);
  assert.ok(store.pending.get('om_form').completed_at, '全部外部副作用成功后才标记 pending 完成');
});

test('外部消息更新失败不回滚已完成派单，pending 标记完成且记录失败操作', async () => {
  const store = new FakeStore();
  const client = new FakeClient({ failUpdateOnce: true });
  const logs = [];
  await handleDispatchEvent(body(), options(store, client));

  const result = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), {
    ...options(store, client),
    logger: { info(line) { logs.push(JSON.parse(line)); } },
  });
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.size, 1);
  assert.ok(store.pending.get('om_form').completed_at);
  assert.equal(store.assignCalls, 1);
  const failure = logs.find((entry) => entry.stage === 'ui_update_failed');
  assert.equal(failure.operation, 'update_original_card');
  assert.equal(failure.error_code, 'LARK_API_TIMEOUT');
  const updateIds = client.calls.filter((item) => item.kind === 'update').map((item) => item.messageId);
  assert.ok(updateIds.includes('om_original'));
  assert.ok(updateIds.includes('om_form'));
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

test('后续派单从最新有效人工锚点轮转，并跳过空值、非当天和名单外姓名', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const client = new FakeClient({ sheetRows: [
    ['2026-08-29 23:00:00', '王五'],
    ['2026-08-30', '张三'],
    ['2026-08-30 11:30:00', '名单外人员'],
    ['8.30', '李四'],
    ['08.30', ''],
  ] });
  const result = await handleDispatchEvent(body({ requestId: 'anchor_forward' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.get('anchor_forward').assignee, '王五');
  assert.deepEqual(store.calibrations, []);
  assert.equal(store.assignmentQueries, 1);
  assert.equal(client.calls.filter((item) => item.kind === 'readRows').length, 1);
});

test('千川锚点忽略当天更新的本地行', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const client = new FakeClient({ sheetRows: [
    ['2026-08-30', '张三', 'CMS千川'],
    ['2026-08-30', '李四', '本地推'],
  ] });
  await handleDispatchEvent(body({
    requestId: 'project_qianchuan', targetCategory: 'qianchuan', projectFieldId: 'C',
  }), options(store, client));
  assert.equal(store.assignments.get('project_qianchuan').assignee, '李四');
  const read = client.calls.find((item) => item.kind === 'readRows');
  assert.equal(read.projectFieldId, 'C');
});

test('本地推锚点忽略当天更新的千川行', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const client = new FakeClient({ sheetRows: [
    ['2026-08-30', '张三', '本地直播'],
    ['2026-08-30', '李四', '千川投放'],
  ] });
  await handleDispatchEvent(body({
    requestId: 'project_local', businessType: '本地推', targetCategory: 'local_promo', projectFieldId: 'C',
  }), options(store, client));
  assert.equal(store.assignments.get('project_local').assignee, '王五');
});

test('项目字段支持多选和分隔文本，空负责人及名单外人员仍跳过', () => {
  const rows = [
    ['2026-08-30', '张三', ['千川', '本地']],
    ['2026-08-30', '李四', '千川+本地'],
    ['2026-08-30', '名单外', ['本地']],
    ['2026-08-30', '', '本地'],
  ];
  assert.equal(latestDailyAnchor(rows, {
    targetDay: '2026-08-30', roster: ['张三', '李四'], projectValue: '千川',
  }), '李四');
  assert.equal(latestDailyAnchor(rows, {
    targetDay: '2026-08-30', roster: ['张三', '李四'], projectValue: '本地',
  }), '李四', '名单外负责人应被忽略并继续寻找更旧的有效锚点');
});

test('后续倒序派单选择锚点上一位并循环轮转', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const client = new FakeClient({ sheetRows: [['2026-08-30 09:00:00', '张三']] });
  await handleDispatchEvent(body({ requestId: 'anchor_reverse', businessType: '本地推' }), options(store, client));
  assert.equal(store.assignments.get('anchor_reverse').assignee, '王五');
  assert.deepEqual(store.calibrations, []);
});

test('无有效锚点时忽略名单外负责人并沿用持久化游标', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  store.forward = 1;
  const client = new FakeClient({ sheetRows: [['2026-08-30', '名单外'], ['2026-08-29', '王五']] });
  const result = await handleDispatchEvent(body({ requestId: 'fallback_cursor' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.get('fallback_cursor').assignee, '李四');
  assert.equal(store.forward, 2);
  assert.equal(store.calibrations.length, 0);
  assert.equal(store.assignmentQueries, 1);
});

test('同 request_id 重放返回原负责人且不再次校准或推进游标', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const client = new FakeClient({ sheetRows: [['2026-08-30', '张三']] });
  await handleDispatchEvent(body({ requestId: 'rpc_replay' }), options(store, client));
  const cursorAfterFirst = store.forward;
  const replay = await handleDispatchEvent(body({ requestId: 'rpc_replay' }), options(store, client));
  assert.match(replay.body.toast.content, /李四/);
  assert.equal(store.forward, cursorAfterFirst);
  assert.equal(store.assignments.size, 1);
  assert.equal(store.assignmentQueries, 2);
  assert.equal(store.calibrations.length, 0);
});

test('锚点日期解析覆盖完整日期、短日期和飞书数值日期', () => {
  const excelDate = (Date.UTC(2026, 7, 30) - Date.UTC(1899, 11, 30)) / 86400000;
  for (const value of ['2026-08-30 12:34:56', '2026-08-30', '8.30', '08.30', excelDate]) {
    assert.equal(sheetDateDay(value, '2026-08-30'), '2026-08-30');
  }
  assert.equal(latestDailyAnchor([
    ['2026-08-30', '张三'], ['08.30', '李四'], ['2026-08-30', '名单外'],
  ], { targetDay: '2026-08-30', roster: ['张三', '李四'] }), '李四');
});

test('旧卡按固定 sheet_id 补齐日期列和负责人列，新字段保持兼容', () => {
  const base = {
    schema_version: 1, action: 'bess_auto_dispatch', request_id: 'legacy_1', request_name: '旧卡',
    business_type: '千川', sheet_url: fields.sheetUrl, row_index: 3,
  };
  const qianchuan = validateDispatchValue({ ...base, sheet_id: 'TQuzLA', target_category: 'qianchuan' });
  assert.deepEqual(
    [
      qianchuan.dateFieldId, qianchuan.dateFieldName,
      qianchuan.assigneeFieldId, qianchuan.assigneeFieldName,
      qianchuan.projectFieldId, qianchuan.projectFieldName, qianchuan.projectValue,
    ],
    ['H', '提需时间', 'J', '执行人', 'C', '项目', '千川'],
  );
  const stock = validateDispatchValue({ ...base, sheet_id: 'p7Wqx4', assignee_field_id: 'F' });
  assert.deepEqual([stock.dateFieldId, stock.dateFieldName, stock.assigneeFieldId], ['D', '创建时间', 'F']);
});

test('后续读表失败时 fail-closed，不调用事务派单和写表', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四'] };
  const client = new FakeClient();
  client.readSheetDispatchRows = async () => { throw new LarkApiError('LARK_API_TIMEOUT', 'timeout'); };
  const result = await handleDispatchEvent(body({ requestId: 'read_failed' }), options(store, client));
  assert.equal(result.errorCode, 'LARK_API_TIMEOUT');
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter((item) => item.kind === 'write').length, 0);
});

test('表单卡与结果卡包含黄色正序、蓝色倒序 and 完整名单', () => {
  const form = buildRosterFormCard(fields);
  assert.match(JSON.stringify(form), /roster_names/);
  const card = buildDispatchResultCard(fields, { assignee: '李四', direction: 'reverse', roster: ['张三', '李四'], dispatchedAt: 't' });
  const text = JSON.stringify(card);
  assert.match(text, /🟡/);
  assert.match(text, /🔵/);
  assert.doesNotMatch(text, /text_color/, 'Card 2.0 markdown 不应携带不受支持的 text_color 字段');
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

test('知识库表格链接先解析为真实 spreadsheet token，再写入并回读', async () => {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request });
    const parsed = new URL(String(url));
    if (parsed.pathname.includes('tenant_access_token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }) };
    }
    if (parsed.pathname.endsWith('/wiki/v2/spaces/get_node')) {
      assert.equal(parsed.searchParams.get('token'), 'wikiNodeToken');
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'spreadsheetToken' } } }) };
    }
    if (request.method === 'PUT') return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0 }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { valueRange: { values: [[' 张三 ']] } } }) };
  };
  const client = new LarkClient({ appId: 'id', appSecret: 'secret', fetchImpl, baseUrl: 'https://open.feishu.test' });
  await client.writeSheetAssignee({
    sheetUrl: 'https://example.feishu.cn/wiki/wikiNodeToken?sheet=sheetA',
    sheetId: 'sheetA', rowIndex: 8, assigneeFieldId: 'D', assignee: '张三',
  });
  assert.equal(calls.filter((item) => item.url.includes('/wiki/v2/spaces/get_node')).length, 1);
  assert.ok(calls.some((item) => item.url.includes('/spreadsheets/spreadsheetToken/values')));
});

test('知识库链接指向非电子表格时拒绝写入', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('tenant_access_token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'docToken' } } }) };
  };
  const client = new LarkClient({ appId: 'id', appSecret: 'secret', fetchImpl, baseUrl: 'https://open.feishu.test' });
  await assert.rejects(() => client.writeSheetAssignee({
    sheetUrl: 'https://example.feishu.cn/wiki/wikiNodeToken',
    sheetId: 'sheetA', rowIndex: 8, assigneeFieldId: 'D', assignee: '张三',
  }), (error) => error instanceof LarkApiError && error.code === 'WIKI_NODE_NOT_SHEET');
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

test('已完成表单重提仅返回友好 Toast，不重复写 Sheet、发结果 or 更新卡片', async () => {
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

test('当前行已有人工负责人时跳过写入且不消耗游标', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const sheetRows = new Array(8).fill(null).map(() => []);
  sheetRows[7] = ['2026-08-30', '李四'];
  const client = new FakeClient({ sheetRows });
  const result = await handleDispatchEvent(body({ requestId: 'manual_row_filled' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.equal(client.calls.filter(c => c.kind === 'write').length, 0, '应该跳过写入');
  assert.equal(store.assignCalls, 0, '不应该推进游标');
  assert.match(result.body.toast.content, /李四/);
});

test('在飞书 API 截断 chunk 尾部空行时依然能通过 startRow 正确匹配 rowIndex', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const targetRowIndex = 5005;
  const client = new FakeClient();
  client.readSheetDispatchRows = async (args) => {
    client.calls.push({ kind: 'read', ...args });
    const chunk1 = new Array(5000).fill(null).map(() => []);
    const candidate1 = args.selectLatest(chunk1, 1);
    const chunk2 = new Array(10).fill(null).map(() => []);
    chunk2[4] = ['2026-08-30', '王五'];
    const candidate2 = args.selectLatest(chunk2, 5001);
    return candidate2 || candidate1;
  };
  const customBody = body({ requestId: 'truncated_chunk' });
  customBody.event.action.value.row_index = targetRowIndex;
  const result = await handleDispatchEvent(customBody, options(store, client));
  assert.equal(client.calls.filter(c => c.kind === 'write').length, 0, '识别到非空行，应该跳过写入');
  assert.match(result.body.toast.content, /王五/);
});

test('名单表单提交时，若目标行已被人工填写，应保护不覆盖', async () => {
  const store = new FakeStore();
  const client = new FakeClient();
  await handleDispatchEvent(body(), options(store, client));
  client.sheetRows = new Array(8).fill(null).map(() => []);
  client.sheetRows[7] = ['2026-08-30', '王五'];
  const result = await handleDispatchEvent(body({ form: true, messageId: 'om_form' }), options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.match(result.body.toast.content, /王五/);
  assert.equal(client.calls.filter(c => c.kind === 'write').length, 0, '表单提交也不应覆盖人工填写行');
});

test('已有 assignment 但与表格人工填写的不同时，以表格为准且跳过写入', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '李四'] };
  store.assignments.set('p1_1', { assignee: '张三', replayed: false });
  const sheetRows = new Array(8).fill(null).map(() => []);
  sheetRows[7] = ['2026-08-30', '李四'];
  const client = new FakeClient({ sheetRows });
  const result = await handleDispatchEvent(body({ requestId: 'p1_1' }), options(store, client));
  assert.match(result.body.toast.content, /李四/);
  assert.equal(client.calls.filter(c => c.kind === 'write').length, 0);
  assert.equal(store.assignCalls, 0);
});


test('短日期带时间仍可识别为当天', () => {
  assert.equal(sheetDateDay('9.3 13:17', '2026-09-03'), '2026-09-03');
  assert.equal(sheetDateDay(' 9.3 13:17:05 ', '2026-09-03'), '2026-09-03');
});


test('回归：728748 人工改为周杰后，729449 从实际上一负责人继续为罗世坤', async () => {
  const store = new FakeStore();
  store.state = { roster: ['周杰', '罗世坤'] };
  const sheetRows = new Array(8).fill(null).map(() => []);
  sheetRows[6] = ['2026-08-30', '周杰', ''];
  const client = new FakeClient({ sheetRows });
  const request = body({
    requestId: '729449', businessType: '本地推', targetCategory: 'local_promo',
    projectFieldId: 'C', projectValue: '本地推',
  });

  const result = await handleDispatchEvent(request, options(store, client));

  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.get('729449').assignee, '罗世坤');
  assert.ok(client.calls.some((call) => call.kind === 'write' && call.assignee === '罗世坤'));
  assert.ok(!client.calls.some((call) => call.kind === 'write' && call.assignee === '周杰'));
});

test('专用业务表接受项目空值和本地变体，共享千川本地表不接受空值', async () => {
  const dedicatedStore = new FakeStore();
  dedicatedStore.state = { roster: ['周杰', '罗世坤'] };
  const rows = new Array(8).fill(null).map(() => []);
  rows[6] = ['2026-08-30', '周杰', null];
  const dedicatedClient = new FakeClient({ sheetRows: rows });
  const dedicatedRequest = body({
    requestId: 'dedicated_blank', businessType: '本地', targetCategory: 'local_promo',
    projectFieldId: 'C', projectValue: '本地推',
  });
  await handleDispatchEvent(dedicatedRequest, options(dedicatedStore, dedicatedClient));
  assert.equal(dedicatedStore.assignments.get('dedicated_blank').assignee, '罗世坤');

  const sharedStore = new FakeStore();
  sharedStore.state = { roster: ['周杰', '罗世坤'] };
  sharedStore.reverse = 1;
  const sharedClient = new FakeClient({ sheetRows: rows });
  const sharedRequest = body({
    requestId: 'shared_blank', businessType: '本地推', targetCategory: 'local_promo',
    projectFieldId: 'C', projectValue: '本地',
  });
  sharedRequest.event.action.value.sheet_id = 'TQuzLA';
  await handleDispatchEvent(sharedRequest, options(sharedStore, sharedClient));
  assert.equal(sharedStore.assignments.get('shared_blank').assignee, '周杰');

  assert.equal(latestDailyAnchor([
    ['2026-08-30', '周杰', [{ text: '千川' }, { text: '本地推' }]],
  ], {
    targetDay: '2026-08-30', roster: ['周杰', '罗世坤'], projectValue: '本地',
  }), '周杰');
});

test('多块扫描跳过较新块名单外负责人并保留旧块有效锚点', async () => {
  const store = new FakeStore();
  store.state = { roster: ['周杰', '罗世坤'] };
  const client = new FakeClient();
  client.readSheetDispatchRows = async (args) => {
    const oldChunk = new Array(5000).fill(null).map(() => []);
    oldChunk[4999] = ['2026-08-30', '周杰'];
    args.selectLatest(oldChunk, 1);
    const newerChunk = new Array(5).fill(null).map(() => []);
    newerChunk[3] = ['2026-08-30', '已离职人员'];
    return args.selectLatest(newerChunk, 5001);
  };
  const request = body({ requestId: 'newer_invalid_chunk' });
  request.event.action.value.row_index = 5005;

  const result = await handleDispatchEvent(request, options(store, client));

  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.get('newer_invalid_chunk').assignee, '罗世坤');
  assert.ok(client.calls.some((call) => call.kind === 'write' && call.assignee === '罗世坤'));
});

test('SQL：锚点原子同步双向游标、btrim 名单名称且先执行 request_id 重放', () => {
  const sql = readFileSync(new URL('../db/bess-dispatch.sql', import.meta.url), 'utf8');
  const replayAt = sql.indexOf('if found then');
  const anchorAt = sql.indexOf('select item.ordinality - 1');
  assert.ok(replayAt > 0 && replayAt < anchorAt, 'request_id 重放必须在锚点和游标变更前返回');
  assert.match(sql, /where btrim\(item\.value\) = nullif\(btrim\(p_context ->> 'anchor_assignee'\), ''\)/);
  assert.match(sql, /if v_anchor_index is not null then\s+update[\s\S]*set forward_cursor = v_index \+ 1,\s+reverse_cursor = v_count - v_index/);
  assert.match(sql, /assignee := btrim\(v_state\.roster ->> v_index::integer\)/);
});


test('P1：目标行已有周杰时不写表，等待双向游标校准后下一需求分配罗世坤', async () => {
  const store = new FakeStore();
  store.state = { roster: ['张三', '周杰', '罗世坤'] };
  const rows = new Array(9).fill(null).map(() => []);
  rows[7] = ['2026-08-30', '周杰'];
  const client = new FakeClient({ sheetRows: rows });

  const filled = await handleDispatchEvent(body({ requestId: 'manual_zhou' }), options(store, client));
  assert.equal(filled.body.toast.type, 'success');
  assert.equal(client.calls.filter((call) => call.kind === 'write').length, 0);
  assert.deepEqual(store.calibrations[0], {
    dayKey: '2026-08-30', assignee: '周杰', roster: ['张三', '周杰', '罗世坤'],
  });
  assert.equal(store.forward, 2);
  assert.equal(store.reverse, 2);

  rows[8] = ['2026-08-30', ''];
  const nextRequest = body({ requestId: 'after_manual_zhou' });
  nextRequest.event.action.value.row_index = 9;
  await handleDispatchEvent(nextRequest, options(store, client));
  assert.equal(store.assignments.get('after_manual_zhou').assignee, '罗世坤');
});

test('P1：目标行游标校准失败时 fail-closed，不返回成功且不写表', async () => {
  const store = new FakeStore();
  store.state = { roster: ['周杰', '罗世坤'] };
  store.calibrateCursor = async () => { throw new Error('database unavailable'); };
  const rows = new Array(8).fill(null).map(() => []);
  rows[7] = ['2026-08-30', '周杰'];
  const client = new FakeClient({ sheetRows: rows });

  const result = await handleDispatchEvent(body({ requestId: 'calibration_failed' }), options(store, client));
  assert.equal(result.body.toast.type, 'error');
  assert.equal(client.calls.filter((call) => call.kind === 'write').length, 0);
  assert.equal(store.assignCalls, 0);
});


test('回归：729643 最近负责人赵刘霞不在 roster 时继续沿用更早有效锚点', async () => {
  const store = new FakeStore();
  store.state = { roster: ['周杰', '罗世坤', '杨新雨'] };
  const rows = new Array(9).fill(null).map(() => []);
  rows[5] = ['2026-08-30', '周杰'];
  rows[6] = ['2026-08-30', '赵刘霞'];
  const client = new FakeClient({ sheetRows: rows });
  const request = body({ requestId: '729643' });
  request.event.action.value.row_index = 8;

  const result = await handleDispatchEvent(request, options(store, client));

  assert.equal(result.body.toast.type, 'success');
  assert.equal(store.assignments.get('729643').assignee, '罗世坤');
  assert.ok(client.calls.some((call) => call.kind === 'write' && call.assignee === '罗世坤'));
});

test('目标行名单外负责人不覆盖也不持久化，下一条按上一有效锚点续派', async () => {
  const store = new FakeStore();
  store.state = { roster: ['周杰', '罗世坤', '杨新雨'] };
  const rows = new Array(9).fill(null).map(() => []);
  rows[6] = ['2026-08-30', '周杰'];
  rows[7] = ['2026-08-30', '赵刘霞'];
  const client = new FakeClient({ sheetRows: rows });

  const filledRequest = body({ requestId: '729643' });
  filledRequest.event.action.value.row_index = 8;
  const filled = await handleDispatchEvent(filledRequest, options(store, client));
  assert.match(filled.body.toast.content, /赵刘霞/);
  assert.equal(store.assignCalls, 0);
  assert.equal(store.calibrations.length, 0);
  assert.ok(!store.assignments.has('729643'));
  assert.ok(!client.calls.some((call) => call.kind === 'write' && call.rowIndex === 8));

  const nextRequest = body({ requestId: '729644' });
  nextRequest.event.action.value.row_index = 9;
  await handleDispatchEvent(nextRequest, options(store, client));
  assert.equal(store.assignments.get('729644').assignee, '罗世坤');
});
