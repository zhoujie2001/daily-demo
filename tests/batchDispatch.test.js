import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LarkApiError } from '../lib/lark/client.js';
import { handleDispatchEvent, batchDispatchFingerprint, redactLarkApiMessage } from '../lib/dispatch/dispatch-service.js';
import { validateBatchDispatchValue } from '../lib/lark/card-actions.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

const silentLogger = { info() {} };

function item(requestId, rowIndex) {
  return {
    schema_version: 1,
    action: 'bess_auto_dispatch',
    request_id: requestId,
    request_name: `需求 ${requestId}`,
    business_type: '千川',
    target_category: 'qianchuan',
    card_title: '批量派单',
    sheet_url: 'https://example.feishu.cn/sheets/token',
    sheet_id: 'sheetA',
    row_index: rowIndex,
    date_field_id: 'H',
    assignee_field_id: 'J',
    project_field_id: 'C',
    project_value: '千川',
  };
}

function batchBody(batchId, items = [item(`${batchId}_1`, 10), item(`${batchId}_2`, 11)]) {
  return {
    header: { event_id: `evt_${batchId}` },
    event: {
      token: `token_${batchId}`,
      operator: { open_id: 'ou_operator' },
      action: {
        tag: 'button',
        value: {
          schema_version: 1,
          action: 'bess_batch_auto_dispatch',
          batch_id: batchId,
          items,
        },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_batch' },
    },
  };
}

function specifyBody(fields, { submit = false, assignee = '周杰' } = {}) {
  return {
    header: { event_id: submit ? `evt_spec_submit_${fields.request_id}` : `evt_spec_open_${fields.request_id}` },
    event: {
      operator: { open_id: 'ou_operator' },
      action: submit
        ? { tag: 'button', value: {}, form_value: { assignee_name: assignee } }
        : { tag: 'button', value: { ...fields, action: 'bess_specify_assignee' } },
      context: {
        open_chat_id: 'oc_allowed',
        open_message_id: submit ? 'om_thread' : 'om_batch',
      },
    },
  };
}

function getStartDispatchButton(card) {
  const btn = card.body.elements
    .find(e => e.tag === 'button' && e.text.content.includes('开始自动派单'));
  return { value: btn.behaviors[0].value };
}

class BatchStore {
  constructor({ now = () => new Date('2026-08-30T11:00:00Z'), batchApi = false } = {}) {
    this.state = { roster: ['张三', '李四'] };
    this.assignments = new Map();
    this.pending = new Map();
    this.assignCalls = 0;
    this.assignBatchCalls = 0;
    this.assignDetails = [];
    this.assignBatchDetails = [];
    this.stateScopeCalls = [];
    this.initializeDetails = [];
    this.cursor = 0;
    this.reverseCursor = 0;
    this.calibrations = [];
    this.initializeCalls = 0;
    this.releaseCalls = 0;
    this.batchStore = createMemoryBatchStore({ now });
    if (!batchApi) this.assignBatch = undefined;
  }

  async claimBatch(args) {
    this.lastClaimArgs = args;
    return this.batchStore.claimBatch(args);
  }
  async saveBatchProgress(args) { return this.batchStore.saveBatchProgress(args); }
  async markBatchFinalization(args) { return this.batchStore.markBatchFinalization(args); }
  async saveBatchResultMessage(args) { return this.batchStore.saveBatchResultMessage(args); }
  async releaseBatchClaim(args) {
    this.releaseCalls += 1;
    return this.batchStore.releaseBatchClaim(args);
  }
  getBatch(chatId, batchId) { return this.batchStore.getBatch(chatId, batchId); }
  async cleanupExpired() {}
  async getDailyState(_dayKey, scope) {
    this.stateScopeCalls.push(scope);
    if (!this.state) return null;
    const adConfirmation = ['ad_review', 'ad_game'].includes(scope)
      ? { roster_revision: 1, status_confirmed: true, confirmed_roster_revision: 1 }
      : {};
    return { ...this.state, ...adConfirmation, forward_cursor: this.cursor, reverse_cursor: this.reverseCursor };
  }
  async initializeRoster({ roster, scope }) {
    this.initializeDetails.push({ roster: [...roster], scope });
    this.initializeCalls += 1;
    if (!this.state) this.state = { roster: [...roster] };
    return this.state;
  }
  async getAssignment(_day, requestId) { return this.assignments.get(requestId) || null; }
  async getDailyAssignments() {
    return [...this.assignments.values()].sort((a, b) => b.id - a.id);
  }
  async calibrateCursor({ dayKey, direction, assignee, roster }) {
    const index = roster.indexOf(assignee);
    if (index < 0) throw new Error('ASSIGNEE_NOT_IN_ROSTER');
    this.calibrations.push({ dayKey, direction, assignee, roster });
    if (direction === 'forward') this.cursor = index + 1;
    else this.reverseCursor = roster.length - index;
  }
  async calibrateAndAssign(args) {
    await this.calibrateCursor(args);
    return this.assign(args);
  }
  async getPendingByRequest(requestId, chatId) {
    return [...this.pending.values()].find((row) => row.request_id === requestId && row.chat_id === chatId && !row.completed_at) || null;
  }
  async savePending(args) { this.pending.set(args.form_message_id, args); return args; }
  async getPending(id) { return this.pending.get(id) || null; }
  async markPendingCompleted(id) {
    if (this.pending.has(id)) this.pending.get(id).completed_at = new Date().toISOString();
  }
  async assignSpecific({ requestId, assignee, context = {} }) {
    if (this.assignments.has(requestId)) return { ...this.assignments.get(requestId), replayed: true };
    const assignment = {
      id: this.assignments.size + 1,
      assignee,
      request_context: context,
    };
    this.assignments.set(requestId, assignment);
    return { ...assignment, replayed: false };
  }
  async assign({ requestId, scope, direction = 'forward', roster, context = {} }) {
    if (roster) this.state = { roster };
    this.assignCalls += 1;
    this.assignDetails.push({ requestId, scope, direction });
    if (this.assignments.has(requestId)) {
      return { ...this.assignments.get(requestId), roster: this.state.roster, replayed: true };
    }
    const anchorIndex = this.state.roster.indexOf(context.anchor_assignee);
    let index;
    if (anchorIndex >= 0) {
      index = direction === 'forward'
        ? (anchorIndex + 1) % this.state.roster.length
        : (anchorIndex - 1 + this.state.roster.length) % this.state.roster.length;
    } else {
      index = direction === 'forward'
        ? this.cursor % this.state.roster.length
        : this.state.roster.length - 1 - (this.reverseCursor % this.state.roster.length);
    }
    const assignment = {
      id: this.assignments.size + 1,
      assignee: this.state.roster[index],
      request_context: context,
    };
    if (direction === 'forward') this.cursor = index + 1;
    else this.reverseCursor = this.state.roster.length - index;
    this.assignments.set(requestId, assignment);
    return { ...assignment, roster: this.state.roster, replayed: false };
  }
  async assignBatch({ requestIds, scope, direction = 'forward', roster, contexts = [] }) {
    if (roster) this.state = { roster };
    this.assignBatchCalls += 1;
    this.assignBatchDetails.push({
      requestIds: [...requestIds], scope, direction, contexts: contexts.map((context) => ({ ...context })),
    });
    const results = [];
    for (const [index, requestId] of requestIds.entries()) {
      const existing = this.assignments.get(requestId);
      if (existing) {
        results.push({
          request_id: requestId, ...existing, roster: this.state.roster, replayed: true,
          version: 1, forward_version: this.cursor + 1, reverse_version: this.reverseCursor + 1,
          assignment_seq: existing.id,
        });
        continue;
      }
      const rosterIndex = direction === 'forward'
        ? this.cursor % this.state.roster.length
        : this.state.roster.length - 1 - (this.reverseCursor % this.state.roster.length);
      const assignment = {
        id: this.assignments.size + 1,
        assignee: this.state.roster[rosterIndex],
        request_context: contexts[index] || {},
      };
      if (direction === 'forward') this.cursor += 1;
      else this.reverseCursor += 1;
      this.assignments.set(requestId, assignment);
      results.push({
        request_id: requestId, ...assignment, roster: this.state.roster, replayed: false,
        version: 1, forward_version: this.cursor + 1, reverse_version: this.reverseCursor + 1,
        assignment_seq: assignment.id,
      });
    }
    return results;
  }
}

class BatchClient {
  constructor({ failRow, failRows = [], failUpdateOnce = false, failReplyOnce = false, onWrite, sheetRows = [], batchApi = false } = {}) {
    this.calls = [];
    this.failRow = failRow;
    this.failRows = new Set(failRows);
    this.failUpdateOnce = failUpdateOnce;
    this.failReplyOnce = failReplyOnce;
    this.onWrite = onWrite;
    this.sheetRows = sheetRows;
    if (!batchApi) {
      this.getSheetValuesBatch = undefined;
      this.writeSheetValuesBatch = undefined;
    }
  }
  async readSheetDispatchRows(args) {
    this.calls.push({ kind: 'read', ...args });
    if (typeof args.selectLatest === 'function') {
      return args.selectLatest(this.sheetRows, 1);
    }
    return this.sheetRows.length > 0 ? this.sheetRows : null;
  }
  async getSheetValues({ range, ...args }) {
    this.calls.push({ kind: 'readCell', range, ...args });
    const match = String(range).match(/!([A-Z]+)(\d+):/);
    const rowIndex = Number(match?.[2] || 0);
    return [[this.sheetRows[rowIndex - 1]?.[1] || '']];
  }
  async resolveSheetColumn({ fieldId }) {
    return fieldId;
  }
  async getSheetValuesBatch({ ranges, ...args }) {
    this.calls.push({ kind: 'batchRead', ranges: [...ranges], ...args });
    return ranges.map((range) => {
      const rowIndex = Number(String(range).match(/![A-Z]+(\d+):/)?.[1] || 0);
      return [[this.sheetRows[rowIndex - 1]?.[1] || '']];
    });
  }
  async writeSheetValuesBatch({ valueRanges, ...args }) {
    this.calls.push({ kind: 'batchWrite', valueRanges, ...args });
    for (const { range, values } of valueRanges) {
      const rowIndex = Number(String(range).match(/![A-Z]+(\d+):/)?.[1] || 0);
      this.sheetRows[rowIndex - 1] ||= ['', '', ''];
      this.sheetRows[rowIndex - 1][1] = values[0][0];
    }
  }
  async readSheetAssignee(fields) {
    const rows = await this.getSheetValues({ sheetUrl: fields.sheetUrl,
      range: `${fields.sheetId}!${fields.assigneeFieldId}${fields.rowIndex}:${fields.assigneeFieldId}${fields.rowIndex}` });
    return String(rows?.[0]?.[0] || '').trim();
  }
  async getMessage() { return null; }
  async writeSheetAssignee(args) {
    if (args.requireEmpty && this.sheetRows[args.rowIndex - 1]?.[1]) {
      if (this.sheetRows[args.rowIndex - 1][1] === args.assignee) return;
      throw new LarkApiError('SHEET_TARGET_CHANGED', 'manual value must not be overwritten');
    }
    this.calls.push({ kind: 'write', ...args });
    this.onWrite?.(args);
    if (args.rowIndex === this.failRow || this.failRows.has(args.rowIndex)) throw new Error('sensitive write error');
    this.sheetRows[args.rowIndex - 1] ||= ['', '', ''];
    this.sheetRows[args.rowIndex - 1][1] = args.assignee;
  }
  async updateMessageCard(messageId, card) {
    this.calls.push({ kind: 'update', messageId, card });
    if (this.failUpdateOnce) { this.failUpdateOnce = false; throw new Error('card update failed'); }
  }
  async replyMessage(args) {
    this.calls.push({ kind: 'reply', ...args });
    if (this.failReplyOnce) { this.failReplyOnce = false; throw new Error('thread reply failed'); }
    return { message_id: 'om_thread' };
  }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    if (this.failReplyOnce) { this.failReplyOnce = false; throw new Error('thread reply failed'); }
    return { message_id: args.uuid?.startsWith('bess-form') ? 'om_form' : 'om_thread' };
  }
}

function options(store, client, overrides = {}) {
  return {
    store,
    client,
    config: { allowedChatIds: 'oc_allowed', ...(overrides.config || {}) },
    logger: overrides.logger || silentLogger,
    now: overrides.now || (() => new Date('2026-08-30T11:00:00Z')),
  };
}

test('AD大盘名单未确认也直接进入批量派单，不自动弹状态表单', async () => {
  const store = new BatchStore();
  store.getDailyState = async (dayKey, scope) => ({
    day_key: dayKey,
    scope,
    roster: ['张三', '李四'],
    off_duty: [],
    version: 1,
    forward_cursor: 0,
    forward_version: 1,
    emergency_forward_cursor: 0,
    emergency_forward_version: 1,
    roster_revision: 2,
    status_confirmed: false,
    confirmed_roster_revision: null,
  });
  const client = new BatchClient();
  const adItem = {
    ...item('ad_unconfirmed_1', 10),
    business_type: 'AD',
    target_category: 'ad',
    date_field_id: 'J',
    assignee_field_id: 'B',
    project_field_id: undefined,
    project_value: undefined,
  };

  const result = await handleDispatchEvent(
    batchBody('ad_unconfirmed', [adItem]),
    options(store, client),
  );

  assert.equal(result.errorCode, undefined);
  assert.match(result.body.toast.content, /批量派单请求已受理/);
  assert.equal(client.calls.some((call) => call.kind === 'replyCard' && JSON.stringify(call.card).includes('人员状态调整')), false);
  await result.afterResponse();
  assert.equal(store.assignCalls, 1);
});

test('AD游戏后续批量派单直接执行，不自动弹状态表单', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  const gameItem = {
    ...item('ad_game_direct_1', 10),
    business_type: 'AD', target_category: 'game_agent',
    date_field_id: 'J', assignee_field_id: 'B',
    project_field_id: undefined, project_value: undefined,
  };
  const result = await handleDispatchEvent(
    batchBody('ad_game_direct', [gameItem]), options(store, client),
  );
  assert.match(result.body.toast.content, /批量派单请求已受理/);
  assert.equal(client.calls.some((call) => JSON.stringify(call.card || {}).includes('人员状态调整')), false);
  await result.afterResponse();
  assert.equal(store.assignCalls, 1);
  assert.equal(store.assignDetails[0].scope, 'ad_game');
});

test('批量点击立即禁用按钮，逐项处理后更新原卡并在单一话题卡片中展示结果与人员名单', async () => {
  const store = new BatchStore();
  const client = new BatchClient({ failRow: 11 });
  const result = await handleDispatchEvent(batchBody('batch_partial'), options(store, client));

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.toast.type, 'info');
  assert.equal(result.body.card.data.body.elements.at(-1).disabled, true);
  assert.match(JSON.stringify(result.body.card.data), /PROCESSING/);
  assert.equal(store.assignCalls, 0, '回调响应前不执行慢派单');

  await result.afterResponse();
  assert.equal(store.assignCalls, 2);
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 0);
  assert.equal(client.calls.filter((call) => call.kind === 'update').length, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
  const update = client.calls.find((call) => call.kind === 'update');
  assert.equal(update.messageId, 'om_batch');
  assert.match(JSON.stringify(update.card), /PARTIAL/);
  assert.match(JSON.stringify(update.card), /SUCCESS/);
  assert.match(JSON.stringify(update.card), /FAILED/);
  const reply = client.calls.find((call) => call.kind === 'replyCard');
  assert.equal(reply.replyInThread, true);
  assert.equal(reply.card.schema, '2.0');
  assert.match(JSON.stringify(reply.card), /批次状态：PARTIAL/);
  assert.match(JSON.stringify(reply.card), /派单排序：正序（从上到下）/);
  const resultTable = reply.card.body.elements.find((element) => element.tag === 'table');
  assert.ok(resultTable, '话题卡片必须包含派单名单表格');
  assert.deepEqual(
    resultTable.columns.map((column) => column.display_name),
    ['派单顺序', '需求 ID', '需求名称', '负责人'],
  );
  assert.deepEqual(resultTable.rows, [
    { dispatch_order: '1', request_id: 'batch_partial_1', request_name: '需求 batch_partial_1', assignee: '张三' },
    { dispatch_order: '2', request_id: 'batch_partial_2', request_name: '需求 batch_partial_2', assignee: '-' },
  ]);
  const rosterColumns = reply.card.body.elements.find((element) => element.tag === 'column_set');
  assert.ok(rosterColumns, '话题卡片必须明确展示千川与本地两套名单顺序');
  assert.match(rosterColumns.columns[0].elements[0].content, /千川正序（从上到下）/);
  assert.match(rosterColumns.columns[0].elements[0].content, /2\. 李四 \*\*← 当前人员\*\*/);
  assert.match(rosterColumns.columns[1].elements[0].content, /本地倒序（从下到上）/);
  assert.doesNotMatch(rosterColumns.columns[1].elements[0].content, /当前人员/);
  assert.doesNotMatch(JSON.stringify(reply.card), /本批次负责人/);
  assert.doesNotMatch(JSON.stringify(reply.card), /sensitive write error/);
});

test('后置 daily state 刷新返回 null 时批量仍完成补偿并释放 claim', async () => {
  const store = new BatchStore();
  store.cursor = 1;
  store.reverseCursor = 1;
  const getDailyState = store.getDailyState.bind(store);
  store.getDailyState = async (...args) => (
    store.assignCalls >= 2 ? null : getDailyState(...args)
  );
  const client = new BatchClient();
  const logs = [];

  const result = await handleDispatchEvent(batchBody('batch_refresh_null'), options(store, client, {
    logger: { info(line) { logs.push(JSON.parse(line)); } },
  }));
  await result.afterResponse();

  assert.equal(store.getBatch('oc_allowed', 'batch_refresh_null').status, 'SUCCESS');
  assert.equal(store.releaseCalls, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'update').length, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
  const resultCard = client.calls.find((call) => call.kind === 'replyCard').card;
  const columns = resultCard.body.elements.find((element) => element.tag === 'column_set').columns;
  assert.match(columns[0].elements[0].content, /1\. 张三 \*\*← 当前人员\*\*/);
  assert.match(columns[1].elements[0].content, /1\. 李四 \*\*← 当前人员\*\*/);
  const warning = logs.find((entry) => entry.stage === 'daily_state_refresh_warning');
  assert.equal(warning.severity, 'warn');
  assert.equal(warning.flow, 'batch');
  assert.equal(warning.error_code, 'DAILY_STATE_NOT_FOUND');
});

test('混合方向批量后置刷新失败时按各方向最后成功结果校正双游标', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  store.cursor = 1;
  store.reverseCursor = 2;
  const getDailyState = store.getDailyState.bind(store);
  store.getDailyState = async (...args) => (
    store.assignCalls >= 2 ? null : getDailyState(...args)
  );
  const local = {
    ...item('fallback_mixed_local', 11),
    business_type: '本地推', target_category: 'local_promo', project_value: '本地',
  };
  const client = new BatchClient();

  const result = await handleDispatchEvent(
    batchBody('batch_refresh_mixed', [item('fallback_mixed_qianchuan', 10), local]),
    options(store, client),
  );
  await result.afterResponse();

  assert.equal(store.getBatch('oc_allowed', 'batch_refresh_mixed').status, 'SUCCESS');
  assert.equal(store.releaseCalls, 1);
  const resultCard = client.calls.find((call) => call.kind === 'replyCard').card;
  const columns = resultCard.body.elements.find((element) => element.tag === 'column_set').columns;
  assert.match(columns[0].elements[0].content, /2\. 李四 \*\*← 当前人员\*\*/);
  assert.match(columns[1].elements[0].content, /3\. 张三 \*\*← 当前人员\*\*/);
});

test('同 batch_id 并发重复点击不重复派单，完成后重放也不新增副作用', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  const body = batchBody('batch_idempotent');
  const first = await handleDispatchEvent(body, options(store, client));
  const concurrent = await handleDispatchEvent(body, options(store, client));
  assert.equal(concurrent.errorCode, 'BATCH_IN_FLIGHT');
  assert.equal(concurrent.body.card.data.body.elements.at(-1).disabled, true);
  assert.equal(store.assignCalls, 0);

  await first.afterResponse();
  await first.afterResponse();
  assert.equal(store.assignCalls, 2, '后台任务自身也必须幂等');
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);

  const replay = await handleDispatchEvent(body, options(store, client));
  assert.equal(replay.errorCode, 'BATCH_ALREADY_PROCESSED');
  assert.match(JSON.stringify(replay.updatedCard), /SUCCESS/);
  assert.equal(store.assignCalls, 2);
});

test('同一 batch_id 携带不同 items 时拒绝，避免串用幂等键', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  await handleDispatchEvent(batchBody('batch_conflict'), options(store, client));
  const conflict = await handleDispatchEvent(
    batchBody('batch_conflict', [item('different_item', 20)]),
    options(store, client),
  );
  assert.equal(conflict.errorCode, 'BATCH_ID_CONFLICT');
  assert.equal(conflict.body.toast.type, 'error');
  assert.equal(store.assignCalls, 0);
});


test('原卡更新与批次话题分别记账，重放只补偿失败的收尾副作用', async () => {
  for (const failedEffect of ['card', 'thread']) {
    const batchId = `batch_compensate_${failedEffect}`;
    const store = new BatchStore();
    const client = new BatchClient({
      failUpdateOnce: failedEffect === 'card',
      failReplyOnce: failedEffect === 'thread',
    });
    const body = batchBody(batchId);
    const first = await handleDispatchEvent(body, options(store, client));
    await first.afterResponse();

    const afterFirst = store.getBatch('oc_allowed', batchId);
    assert.equal(afterFirst.card_update_done, failedEffect !== 'card');
    assert.equal(afterFirst.thread_reply_done, true, '话题发送失败应立即补发最终结果卡');
    assert.equal(store.assignCalls, 2);

    const replay = await handleDispatchEvent(body, options(store, client));
    if (replay.afterResponse) await replay.afterResponse();

    const completed = store.getBatch('oc_allowed', batchId);
    assert.equal(completed.card_update_done, true);
    assert.equal(completed.thread_reply_done, true);
    assert.equal(store.assignCalls, 2, '收尾补偿不得重复执行 item 派单');
    assert.equal(
      client.calls.filter((call) => call.kind === 'update').length,
      failedEffect === 'card' ? 2 : 1,
    );
    assert.equal(
      client.calls.filter((call) => call.kind === 'replyCard').length,
      failedEffect === 'thread' ? 2 : 1,
    );
  }
});

test('租约过期后从持久化逐项进度恢复，只处理尚未记录的 item', async () => {
  const batchId = 'batch_resume_items';
  const store = new BatchStore();
  const client = new BatchClient();
  const body = batchBody(batchId);
  await handleDispatchEvent(body, options(store, client));

  const claim = store.lastClaimArgs;
  store.assignments.set(`${batchId}_1`, { assignee: '张三' });
  await store.saveBatchProgress({
    chatId: claim.chatId,
    batchId,
    claimToken: claim.claimToken,
    status: 'PROCESSING',
    results: [{ requestId: `${batchId}_1`, requestName: `需求 ${batchId}_1`, status: 'SUCCESS', assignee: '张三' }],
    leaseExpiresAt: '2026-08-30T10:59:00.000Z',
  });
  await store.releaseBatchClaim({
    chatId: claim.chatId,
    batchId,
    claimToken: claim.claimToken,
    releasedAt: new Date('2026-08-30T10:59:00.000Z'),
  });

  const resumed = await handleDispatchEvent(body, options(store, client));
  await resumed.afterResponse();
  assert.equal(store.assignCalls, 1);
  assert.ok(store.assignments.has(`${batchId}_2`));
  assert.equal(store.getBatch('oc_allowed', batchId).results.length, 2);
});

test('缺少持久化 batch store 接口时 fail-closed，不退化为进程内锁', async () => {
  const store = new BatchStore();
  store.claimBatch = undefined;
  const client = new BatchClient();
  const result = await handleDispatchEvent(batchBody('batch_no_lock'), options(store, client));
  assert.equal(result.errorCode, 'PERSISTENT_BATCH_STORE_REQUIRED');
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.length, 0);
});


test('重放只跳过 SUCCESS，FAILED 使用既有 assignment 重试并原位替换结果', async () => {
  const batchId = 'batch_retry_failed';
  const store = new BatchStore();
  const client = new BatchClient({ failRow: 11 });
  const body = batchBody(batchId);

  const first = await handleDispatchEvent(body, options(store, client));
  await first.afterResponse();
  assert.equal(store.getBatch('oc_allowed', batchId).status, 'PARTIAL');
  const partialOriginalCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_batch').at(-1).card;
  assert.equal(partialOriginalCard.body.elements.at(-1).disabled, false);
  assert.equal(partialOriginalCard.body.elements.at(-1).value.batch_id, batchId);
  assert.match(partialOriginalCard.body.elements.at(-1).text.content, /重试失败项/);
  assert.equal(store.assignCalls, 2);

  client.failRow = undefined;
  const replay = await handleDispatchEvent(body, options(store, client));
  await replay.afterResponse();

  const completed = store.getBatch('oc_allowed', batchId);
  assert.equal(completed.status, 'SUCCESS');
  const successOriginalCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_batch').at(-1).card;
  assert.equal(successOriginalCard.body.elements.at(-1).disabled, true);
  assert.match(successOriginalCard.body.elements.at(-1).text.content, /已完成/);
  assert.equal(completed.results.length, 2, '重试结果必须替换旧 FAILED，不得追加重复项');
  assert.equal(completed.results.filter((entry) => entry.requestId === `${batchId}_2`).length, 1);
  assert.equal(completed.results.find((entry) => entry.requestId === `${batchId}_2`).status, 'SUCCESS');
  assert.equal(store.assignCalls, 3, 'SUCCESS 项不重跑，FAILED 项通过 request_id assignment 幂等重放');
  assert.equal(client.calls.filter((call) => call.kind === 'write' && call.rowIndex === 11).length, 2);
});

test('内部截止时间前主动暂停、持久化进度并开放同 batch_id 续跑', async () => {
  const batchId = 'batch_deadline_resume';
  let clock = new Date('2026-08-30T11:00:00Z');
  const now = () => new Date(clock);
  const store = new BatchStore({ now });
  const client = new BatchClient({
    onWrite() { clock = new Date(clock.getTime() + 30_000); },
  });
  const body = batchBody(batchId);

  const first = await handleDispatchEvent(body, options(store, client, {
    now,
    config: { batchExecutionDeadlineMs: 25_000, batchItemStartReserveMs: 1_000 },
  }));
  await first.afterResponse();

  const paused = store.getBatch('oc_allowed', batchId);
  assert.equal(paused.status, 'PROCESSING');
  assert.equal(paused.results.length, 1);
  const pauseUpdate = client.calls.filter((call) => call.kind === 'update').at(-1);
  assert.match(JSON.stringify(pauseUpdate.card), /处理中，可重试继续/);
  assert.equal(pauseUpdate.card.body.elements.at(-1).disabled, false);
  assert.equal(pauseUpdate.card.body.elements.at(-1).value.batch_id, batchId);
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 0, '暂停时不得提前发送最终话题');

  const resumed = await handleDispatchEvent(body, options(store, client, {
    now,
    config: { batchExecutionDeadlineMs: 120_000, batchItemStartReserveMs: 1_000 },
  }));
  await resumed.afterResponse();

  const completed = store.getBatch('oc_allowed', batchId);
  assert.equal(completed.status, 'SUCCESS');
  assert.equal(completed.results.length, 2);
  assert.equal(store.assignCalls, 2, '续跑不得重派已成功项');
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
});


test('批量派单首次点击若名单未初始化，则引导填写表单；提交名单后自动恢复并处理全部需求', async () => {
  const store = new BatchStore();
  store.state = null; // Uninitialized
  const client = new BatchClient();
  const body = batchBody('batch_init');

  // 1. Initial click
  const result = await handleDispatchEvent(body, options(store, client));
  assert.equal(result.httpStatus, 200);
  assert.match(result.body.toast.content, /已创建批量派单话题/);
  assert.equal(client.calls.filter((c) => c.kind === 'replyCard').length, 1);
  assert.equal(store.pending.size, 1);
  assert.equal(store.assignCalls, 0);

  // 2. Submit form
  const formBody = {
    header: { event_id: 'evt_form' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: {
        tag: 'dispatch_roster_submit',
        form_value: { roster_names: '王五, 赵六' },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  };
  const resumeResult = await handleDispatchEvent(formBody, options(store, client));
  assert.equal(resumeResult.httpStatus, 200);
  assert.match(resumeResult.body.toast.content, /名单已保存/);
  await resumeResult.afterResponse();
  assert.equal(store.assignCalls, 0);
  assert.equal(store.state.roster.length, 2);

  // 3. Start Dispatch
  const startBtn = getStartDispatchButton(resumeResult.updatedCard);
  const startResult = await handleDispatchEvent({
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'button', value: startBtn.value },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  await startResult.afterResponse();

  assert.equal(store.assignCalls, 2);
  assert.ok(store.state.roster.includes('王五'));
  assert.ok(store.state.roster.includes('赵六'));

  const update = client.calls.filter((c) => c.kind === 'update' && c.messageId === 'om_form').at(-1);
  assert.match(JSON.stringify(update.card), /SUCCESS/);
  assert.match(JSON.stringify(resumeResult.updatedCard), /名单已保存/);
});


test('首次名单提交遇到人工已派单行时先初始化名单，再校准游标并处理剩余空行', async () => {
  const store = new BatchStore();
  store.state = null;
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[9] = ['2026-08-30', '王五', '千川'];
  const client = new BatchClient({ sheetRows });
  const body = batchBody('batch_manual_first_init');

  await handleDispatchEvent(body, options(store, client));
  const result = await handleDispatchEvent({
    header: { event_id: 'evt_manual_first_init_form' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'dispatch_roster_submit', form_value: { roster_names: '王五, 赵六', shuffle_roster: false } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  assert.match(result.body.toast.content, /名单已保存/);
  await result.afterResponse();
  const startBtn = getStartDispatchButton(result.updatedCard);
  const startResult = await handleDispatchEvent({
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'button', value: startBtn.value },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  await startResult.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_manual_first_init');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(store.initializeCalls, 1, '表单名单必须在人工锚点校准前持久化一次');
  assert.deepEqual(store.state.roster, ['王五', '赵六']);
  assert.equal(store.calibrations.length, 1);
  assert.equal(store.calibrations[0].assignee, '王五');
  assert.equal(store.calibrations[0].direction, 'forward');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'batch_manual_first_init_1').assignee, '王五');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'batch_manual_first_init_1').replayed, true);
  assert.equal(batch.results.find(({ requestId }) => requestId === 'batch_manual_first_init_2').assignee, '赵六');
  const writes = client.calls.filter((call) => call.kind === 'write');
  assert.ok(!writes.some(({ rowIndex }) => rowIndex === 10), '不得覆盖人工负责人');
  assert.ok(writes.some(({ rowIndex, assignee }) => rowIndex === 11 && assignee === '赵六'));
});


test('Vercel callback 运行上限为 300 秒', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions['api/lark/callback.js'].maxDuration, 300);
});


test('重复 roster callback 复用既有 batch pending/form，不重复回复或写状态', async () => {
  const store = new BatchStore();
  store.state = null;
  const client = new BatchClient();
  const body = batchBody('batch_form_reuse');
  const first = await handleDispatchEvent(body, options(store, client));
  const second = await handleDispatchEvent(body, options(store, client));
  assert.match(first.body.toast.content, /已创建/);
  assert.match(second.body.toast.content, /已有待填写/);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
  assert.equal(store.pending.size, 1);
});

test('保存名单后开始派单 PARTIAL 显示橙色真实结果，重试只执行失败项并在 SUCCESS 后更新卡片', async () => {

  const store = new BatchStore();

  store.state = null;

  const client = new BatchClient({ failRow: 11 });

  const body = batchBody('batch_flow_partial');

  await handleDispatchEvent(body, options(store, client));

  const formBody = {

    header: { event_id: 'evt_partial_form' },

    event: {

      operator: { open_id: 'ou_operator' },

      action: { tag: 'dispatch_roster_submit', form_value: { roster_names: '王五, 赵六' } },

      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },

    },

  };

    const first = await handleDispatchEvent(formBody, options(store, client));

    assert.match(first.body.toast.content, /名单已保存/);

    await first.afterResponse();

    assert.ok(store.pending.get('om_form').completed_at, '表单提交后即完成');





  // 开始派单

  const startBtn = getStartDispatchButton(first.updatedCard);

  const startResult = await handleDispatchEvent({

    event: {

      operator: { open_id: 'ou_operator' },

      action: { tag: 'button', value: startBtn.value },

      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },

    },

  }, options(store, client));

  await startResult.afterResponse();



  const partialCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;

  assert.equal(partialCard.header.template, 'orange');

  assert.match(JSON.stringify(partialCard), /PARTIAL/);

  assert.equal(store.assignCalls, 2);



  // 重试失败项
  client.failRow = undefined;
  const retryBtn = partialCard.body.elements.find(e => e.tag === 'button' && e.text.content.includes('重试失败项'));
  const retryResult = await handleDispatchEvent({
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'button', value: retryBtn.value },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));





  await retryResult.afterResponse();



    const successCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;



    assert.equal(successCard.header.template, 'green');



        assert.match(JSON.stringify(successCard), /SUCCESS/);



        assert.equal(store.assignCalls, 3, '重试失败项会增加一次 assignCall');









});



test('保存名单后开始派单 FAILED 显示红色结果，重试更新同一张卡片', async () => {

  const store = new BatchStore();

  store.state = null;

  const client = new BatchClient({ failRows: [10, 11] });

  await handleDispatchEvent(batchBody('batch_flow_failed'), options(store, client));

    const rosterResult = await handleDispatchEvent({

      header: { event_id: 'evt_failed_form' },

      event: {

        operator: { open_id: 'ou_operator' },

        action: { tag: 'dispatch_roster_submit', form_value: { roster_names: '王五, 赵六' } },

        context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },

      },

    }, options(store, client));

    await rosterResult.afterResponse();



    const startBtn = getStartDispatchButton(rosterResult.updatedCard);



  const startResult = await handleDispatchEvent({

    event: {

      operator: { open_id: 'ou_operator' },

      action: { tag: 'button', value: startBtn.value },

      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },

    },

  }, options(store, client));

  await startResult.afterResponse();



    const card = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;



    assert.equal(card.header.template, 'red');



    assert.match(JSON.stringify(card), /FAILED/);



    const retryButton = card.body.elements.find(e => e.tag === 'button' && e.text.content.includes('重试失败项'));



    assert.ok(retryButton);



    assert.equal(retryButton.disabled, false);



    assert.equal(retryButton.value.batch_id, 'batch_flow_failed');



  });









test('飞书错误日志脱敏 Token、Secret、邮箱和手机号', () => {
  const message = 'Bearer abc/DEF+ghi==TAIL token=tok_123 secret:sec_456 user@example.com 13800138000';
  const redacted = redactLarkApiMessage(message);
  assert.equal(redacted.includes('abc/DEF+ghi==TAIL'), false);
  assert.equal(redacted.includes('TAIL'), false);
  assert.equal(redacted.includes('tok_123'), false);
  assert.equal(redacted.includes('sec_456'), false);
  assert.equal(redacted.includes('user@example.com'), false);
  assert.equal(redacted.includes('13800138000'), false);
  assert.match(redacted, /\[REDACTED\]/);
});


test('HTTP 200 飞书业务错误写入准确且脱敏的批次诊断日志', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  client.readSheetDispatchRows = async () => {
    throw new LarkApiError('LARK_API_230001', 'bad request', {
      httpStatus: 200,
      endpoint: '/open-apis/sheets/v3/spreadsheets/token/sheets/query',
      apiCode: 230001,
      apiMessage: 'bad request Bearer abc/DEF+ghi==TAIL user@example.com',
      logId: 'log_business_200',
    });
  };
  const logs = [];
  const result = await handleDispatchEvent(
    batchBody('batch_business_error', [item('business_error_1', 10)]),
    options(store, client, { logger: { info(line) { logs.push(JSON.parse(line)); } } }),
  );
  await result.afterResponse();

  const failure = logs.find((entry) => entry.stage === 'batch_item_failed');
  assert.equal(failure.api_code, 230001);
  assert.equal(failure.http_status, 200);
  assert.equal(failure.endpoint, '/open-apis/sheets/v3/spreadsheets/token/sheets/query');
  assert.equal(failure.lark_log_id, 'log_business_200');
  assert.equal(failure.api_message, 'bad request Bearer [REDACTED] [REDACTED_EMAIL]');
  assert.equal(JSON.stringify(failure).includes('TAIL'), false);
});

test('批量派单回归测试：人工填写行作为锚点推顺序且自身不被覆盖，后续空行正常分配', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[10] = ['2026-08-30', '李四', '千川'];
  const client = new BatchClient({ sheetRows });
  const items = [
    item('req_A', 10),
    item('req_B', 11),
    item('req_C', 12),
  ];
  const result = await handleDispatchEvent(batchBody('batch_regression', items), options(store, client));
  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'batch_regression');
  assert.equal(batch.status, 'SUCCESS');
  const results = batch.results;
  assert.equal(results.find(r => r.requestId === 'req_A').assignee, '张三');
  assert.equal(results.find(r => r.requestId === 'req_B').assignee, '李四');
  assert.equal(results.find(r => r.requestId === 'req_B').replayed, true);
  assert.equal(results.find(r => r.requestId === 'req_C').assignee, '王五');
  const writes = client.calls.filter(c => c.kind === 'write');
  assert.ok(writes.some(w => w.rowIndex === 10 && w.assignee === '张三'));
  assert.ok(!writes.some(w => w.rowIndex === 11), '人工填写行不应触发写入');
  assert.ok(writes.some(w => w.rowIndex === 12 && w.assignee === '王五'));
});

test('千川与本地推混合批次分别沿用各自锚点，并在结果卡同时标记双锚点', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[9] = ['2026-08-30', '李四', '千川'];
  sheetRows[11] = ['2026-08-30', '王五', '本地'];
  const client = new BatchClient({ sheetRows });
  const qianchuan = (requestId, rowIndex) => item(requestId, rowIndex);
  const localPromo = (requestId, rowIndex) => ({
    ...item(requestId, rowIndex),
    business_type: '本地推',
    target_category: 'local_promo',
    project_value: '本地',
  });
  const items = [
    qianchuan('mixed_q_anchor', 10),
    qianchuan('mixed_q_auto', 11),
    localPromo('mixed_l_anchor', 12),
    localPromo('mixed_l_auto', 13),
  ];

  const result = await handleDispatchEvent(batchBody('batch_mixed_direction_anchors', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_mixed_direction_anchors');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_q_anchor').assignee, '李四');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_q_auto').assignee, '王五');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_l_anchor').assignee, '王五');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_l_auto').assignee, '李四');
  assert.equal(store.calibrations.length, 2, '两个方向各自用版本化校准，不得互相覆盖');

  const resultCard = client.calls.find((call) => call.kind === 'replyCard').card;
  const rosterColumns = resultCard.body.elements.find((element) => element.tag === 'column_set');
  assert.match(rosterColumns.columns[0].elements[0].content, /3\. 王五 \*\*← 当前人员\*\*/);
  assert.match(rosterColumns.columns[1].elements[0].content, /2\. 李四 \*\*← 当前人员\*\*/);
});

test('混合批次仅千川有锚点时不污染本地推原有倒序游标', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[9] = ['2026-08-30', '李四', '千川'];
  const client = new BatchClient({ sheetRows });
  const localItem = {
    ...item('mixed_only_q_anchor_local_auto', 12),
    business_type: '本地推',
    target_category: 'local_promo',
    project_value: '本地',
  };
  const items = [
    item('mixed_only_q_anchor', 10),
    item('mixed_only_q_anchor_q_auto', 11),
    localItem,
  ];

  const result = await handleDispatchEvent(batchBody('batch_mixed_only_q_anchor', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_mixed_only_q_anchor');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_only_q_anchor_q_auto').assignee, '王五');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_only_q_anchor_local_auto').assignee, '王五');
  assert.equal(store.calibrations.length, 1);
});

test('混合批次首个锚定分配在持久化前失败时，下一项继续消费该方向锚点', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '王五'] };
  const originalAssign = store.assign.bind(store);
  store.assign = async (args) => {
    if (args.requestId === 'mixed_anchor_fail') throw new Error('temporary store failure');
    return originalAssign(args);
  };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[9] = ['2026-08-30', '李四', '千川'];
  sheetRows[12] = ['2026-08-30', '王五', '本地'];
  const client = new BatchClient({ sheetRows });
  const localPromo = (requestId, rowIndex) => ({
    ...item(requestId, rowIndex),
    business_type: '本地推',
    target_category: 'local_promo',
    project_value: '本地',
  });
  const items = [
    item('mixed_anchor_prefilled', 10),
    item('mixed_anchor_fail', 11),
    item('mixed_anchor_next', 12),
    localPromo('mixed_local_prefilled', 13),
    localPromo('mixed_local_auto', 14),
  ];

  const result = await handleDispatchEvent(batchBody('batch_mixed_anchor_failure', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_mixed_anchor_failure');
  assert.equal(batch.status, 'PARTIAL');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_anchor_fail').status, 'FAILED');
  assert.equal(batch.results.find(({ requestId }) => requestId === 'mixed_anchor_next').assignee, '王五');
});

test('存量 11 条：第 2 条陈冰清固定为批次锚点，自动游标连续得到黄鲜/陈冰清/罗理', async () => {
  const store = new BatchStore();
  store.state = { roster: ['周杰', '马莲', '赵刘霞', '罗世坤', '罗理', '黄鲜', '陈冰清', '陈思宇'] };
  const sheetRows = new Array(30).fill(null).map(() => ['', '']);
  sheetRows[10] = ['2026-08-30', '陈冰清'];
  const client = new BatchClient({ sheetRows });
  const items = Array.from({ length: 11 }, (_, index) => ({
    ...item(`stock_${index + 1}`, 10 + index),
    business_type: '存量',
    target_category: 'stock',
    sheet_id: 'StockSheet',
    project_field_id: '',
    project_value: '',
  }));

        const result = await handleDispatchEvent(batchBody('batch_stock_fixed_anchor', items), options(store, client));

        await result.afterResponse();

        const batch = store.getBatch('oc_allowed', 'batch_stock_fixed_anchor');

        assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.slice(0, 3).map(({ assignee }) => assignee), ['陈思宇', '陈冰清', '黄鲜']);
  assert.equal(batch.results[1].replayed, true);
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['陈冰清']);
  assert.ok(!client.calls.some((call) => call.kind === 'write' && call.rowIndex === 11));
  const resultCard = client.calls.find((call) => call.kind === 'replyCard').card;
  assert.match(JSON.stringify(resultCard), /本批业务：存量（本地倒序）/);
  assert.match(JSON.stringify(resultCard), /千川正序（从上到下）/);
  assert.match(JSON.stringify(resultCard), /本地倒序（从下到上）/);
});


test('存量新批次以表格历史最新负责人校准，不沿用 DB 倒序游标', async () => {
  const store = new BatchStore();
  store.state = { roster: ['周杰', '马莲', '赵刘霞', '罗世坤', '罗理', '黄鲜', '陈冰清', '陈思宇'] };
  // DB cursor currently points after 周杰 in reverse order, which would assign 陈思宇.
  store.reverseCursor = store.state.roster.length;
  // An assignment in another scope must neither suppress the stock sheet scan nor become its anchor.
  store.assignments.set('qianchuan_history', {
    id: 1,
    assignee: '周杰',
    request_context: { sheetId: 'QianchuanSheet', businessType: '千川', rowIndex: 10 },
  });
  const sheetRows = new Array(80).fill(null).map(() => ['', '']);
  sheetRows[67] = ['2026-09-04', '黄鲜'];
  sheetRows[68] = ['2026-09-04', ''];
  const client = new BatchClient({ sheetRows });
  const stockItem = {
    ...item('731816', 69),
    business_type: '存量',
    target_category: 'local_promo',
    sheet_id: 'p7Wqx4',
    project_field_id: '',
    project_value: '',
  };

  const result = await handleDispatchEvent(
    batchBody('batch_731816_stock_sheet_anchor', [stockItem]),
    options(store, client, { now: () => new Date('2026-09-04T07:12:00Z') }),
  );
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_731816_stock_sheet_anchor');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '罗理');
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['黄鲜']);
  assert.ok(client.calls.some(call => call.kind === 'write' && call.rowIndex === 69 && call.assignee === '罗理'));
});


test('本地推首项把人工负责人作为事务锚点并分配下一位，禁止连续同名', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '杨新雨'] };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[9] = ['9.3 13:17', '杨新雨', '本地'];
  const client = new BatchClient({ sheetRows });
  const localItem = { ...item('728665', 11), business_type: '本地推', target_category: 'local_promo', project_value: '本地' };

  const result = await handleDispatchEvent(
    batchBody('batch_manual_anchor_local', [localItem]),
    options(store, client, { now: () => new Date('2026-09-03T08:09:00Z') }),
  );
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_manual_anchor_local');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '李四');
  assert.notEqual(batch.results[0].assignee, '杨新雨');
  assert.ok(client.calls.some(call => call.kind === 'write' && call.assignee === '李四'));
});


test('batch：目标行已有周杰时不写表并校准，下一需求分配罗世坤', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '周杰', '罗世坤'] };
  const rows = new Array(12).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '周杰', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const result = await handleDispatchEvent(batchBody('batch_manual_zhou', [
    item('manual_zhou', 10), item('after_manual_zhou', 11),
  ]), options(store, client));

  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'batch_manual_zhou');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '周杰');
  assert.equal(batch.results[0].replayed, true);
  assert.equal(batch.results[1].assignee, '罗世坤');
  assert.ok(!client.calls.some((call) => call.kind === 'write' && call.rowIndex === 10));
  assert.ok(client.calls.some((call) => call.kind === 'write' && call.rowIndex === 11 && call.assignee === '罗世坤'));
  assert.equal(store.calibrations[0].assignee, '周杰');
});

test('专项集成：先指定一条再批量派单，剩余需求从指定人员下一位开始', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '周杰', '罗世坤'], off_duty: [] };
  const rows = new Array(12).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '', '千川'];
  rows[10] = ['2026-08-30', '', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const first = item('specified_then_batch', 10);
  const second = item('after_specified', 11);

  const opened = await handleDispatchEvent(specifyBody(first), options(store, client));
  assert.equal(opened.body.toast.type, 'success');
  const specified = await handleDispatchEvent(
    specifyBody(first, { submit: true, assignee: '周杰' }), options(store, client),
  );
  assert.equal(specified.body.toast.type, 'success');

  const batchResult = await handleDispatchEvent(
    batchBody('batch_after_specific_assignment', [first, second]), options(store, client),
  );
  await batchResult.afterResponse();
  const batch = store.getBatch('oc_allowed', 'batch_after_specific_assignment');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '周杰');
  assert.equal(batch.results[0].replayed, true);
  assert.equal(batch.results[1].assignee, '罗世坤');
  assert.ok(client.calls.some((call) => call.kind === 'write' && call.rowIndex === 11 && call.assignee === '罗世坤'));
});

test('专项集成：多条提前指定时沿用最高行最新有效锚点', async () => {
  const store = new BatchStore();
  store.state = { roster: ['张三', '李四', '周杰'], off_duty: [] };
  store.assignments.set('specified_old', {
    id: 1, assignee: '周杰', request_context: { ...item('specified_old', 10), rowIndex: 10 },
  });
  store.assignments.set('specified_latest', {
    id: 2, assignee: '张三', request_context: { ...item('specified_latest', 12), rowIndex: 12 },
  });
  // A completed specified-assignment flow already calibrates its cursor.
  // Reading its ledger later must not calibrate it a second time.
  store.cursor = 1;
  const rows = new Array(14).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '周杰', '千川'];
  rows[11] = ['2026-08-30', '张三', '千川'];
  rows[12] = ['2026-08-30', '', '千川'];
  const client = new BatchClient({ sheetRows: rows });

  const result = await handleDispatchEvent(batchBody('batch_multi_specific_anchor', [
    item('specified_old', 10), item('specified_latest', 12), item('after_latest_specific', 13),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_multi_specific_anchor');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[2].assignee, '李四');
  assert.equal(store.calibrations.length, 0);
});

test('batch：目标行校准失败时该项不得记为成功且不写表', async () => {
  const store = new BatchStore();
  store.state = { roster: ['周杰', '罗世坤'] };
  store.calibrateCursor = async () => { throw new Error('database unavailable'); };
  const rows = new Array(10).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '周杰', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const result = await handleDispatchEvent(
    batchBody('batch_calibration_failed', [item('manual_zhou_failed', 10)]), options(store, client),
  );

  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'batch_calibration_failed');
  assert.equal(batch.status, 'FAILED');
  assert.equal(batch.results[0].status, 'FAILED');
  assert.ok(!client.calls.some((call) => call.kind === 'write'));
});


test('FAILED→SUCCESS 重试原位更新已持久化的话题结果卡且重复重试不新增卡', async () => {
  const batchId = 'batch_failed_to_success_thread';
  const store = new BatchStore();
  const client = new BatchClient({ failRow: 10 });
  const body = batchBody(batchId, [item('729643', 10)]);

  const first = await handleDispatchEvent(body, options(store, client));
  await first.afterResponse();
  assert.equal(store.getBatch('oc_allowed', batchId).result_message_id, 'om_thread');
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);

  client.failRow = undefined;
  const retry = await handleDispatchEvent(body, options(store, client));
  await retry.afterResponse();
  const threadUpdate = client.calls.find((call) => call.kind === 'update' && call.messageId === 'om_thread');
  assert.ok(threadUpdate, '重试应更新同一 message_id');
  assert.match(JSON.stringify(threadUpdate.card), /SUCCESS/);
  assert.match(JSON.stringify(threadUpdate.card), /张三/);
  assert.match(JSON.stringify(threadUpdate.card), /当前人员/);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);

  const duplicate = await handleDispatchEvent(body, options(store, client));
  assert.equal(duplicate.errorCode, 'BATCH_ALREADY_PROCESSED');
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
});

test('PARTIAL→SUCCESS 重试更新同一话题结果卡', async () => {
  const batchId = 'batch_partial_to_success_thread';
  const store = new BatchStore();
  const client = new BatchClient({ failRow: 11 });
  const body = batchBody(batchId);
  const first = await handleDispatchEvent(body, options(store, client));
  await first.afterResponse();

  client.failRow = undefined;
  const retry = await handleDispatchEvent(body, options(store, client));
  await retry.afterResponse();
  assert.equal(store.getBatch('oc_allowed', batchId).result_message_id, 'om_thread');
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 1);
  const updated = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_thread').at(-1);
  assert.match(JSON.stringify(updated.card), /SUCCESS/);
  assert.notEqual(updated.card.body.elements.find((element) => element.tag === 'table').rows[1].assignee, '-');
});

test('旧话题结果卡更新失败时补发最终结果卡并持久化新 message_id', async () => {
  const batchId = 'batch_replace_stale_thread';
  const store = new BatchStore();
  const client = new BatchClient({ failRow: 10 });
  let resultReplyCount = 0;
  client.replyInteractiveCard = async function replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    resultReplyCount += 1;
    return { message_id: resultReplyCount === 1 ? 'om_stale' : 'om_final' };
  };
  const originalUpdate = client.updateMessageCard.bind(client);
  client.updateMessageCard = async (messageId, card) => {
    if (messageId === 'om_stale') {
      client.calls.push({ kind: 'update', messageId, card });
      throw new Error('message not found');
    }
    return originalUpdate(messageId, card);
  };
  const body = batchBody(batchId, [item('729643', 10)]);
  const first = await handleDispatchEvent(body, options(store, client));
  await first.afterResponse();

  client.failRow = undefined;
  const retry = await handleDispatchEvent(body, options(store, client));
  await retry.afterResponse();
  const saved = store.getBatch('oc_allowed', batchId);
  assert.equal(saved.result_message_id, 'om_final');
  assert.equal(saved.thread_reply_done, true);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 2);
  const replacement = client.calls.filter((call) => call.kind === 'replyCard').at(-1).card;
  assert.match(JSON.stringify(replacement), /此前的话题结果卡已失效/);
  assert.match(JSON.stringify(replacement), /SUCCESS/);
});


test('旧 pending 批次表单恢复时逐项规范化 profile：AD 游戏使用 ad_game+forward，千川保持 default+forward', async () => {
  const cases = [
    {
      label: 'AD',
      raw: item('legacy_ad_pending', 10),
      overrides: {
        business_type: 'AD', target_category: 'game_agent', sheet_id: 'adGame',
        date_field_id: 'J', assignee_field_id: 'B',
        project_field_id: undefined, project_value: undefined,
      },
      expectedScope: 'ad_game',
      expectedDirection: 'forward',
    },
    {
      label: '千川',
      raw: item('legacy_qian_pending', 10),
      overrides: {},
      expectedScope: 'default',
      expectedDirection: 'forward',
    },
  ];

  for (const [caseIndex, entry] of cases.entries()) {
    const raw = { ...entry.raw, ...entry.overrides };
    const batchId = `legacy_pending_${caseIndex}`;
    const normalized = validateBatchDispatchValue({
      action: 'bess_batch_auto_dispatch', schema_version: 1,
      batch_id: batchId, items: [raw],
    }).items[0];
    delete normalized.dispatchProfile;
    delete normalized.dispatchScope;
    delete normalized.dispatchDirection;

    const store = new BatchStore();
    store.state = null;
    await store.savePending({
      form_message_id: `om_legacy_${entry.label}`,
      request_id: `batch_legacy_${entry.label}`,
      original_message_id: `om_original_${entry.label}`,
      chat_id: 'oc_allowed',
      request_context: {
        kind: 'batch', batchId, items: [normalized],
      },
    });
    const client = new BatchClient();
    const result = await handleDispatchEvent({
      header: { event_id: `evt_legacy_${entry.label}` },
      event: {
        operator: { open_id: 'ou_operator' },
        action: { tag: 'dispatch_roster_submit', form_value: { roster_names: '王五, 赵六', shuffle_roster: false } },
        context: { open_chat_id: 'oc_allowed', open_message_id: `om_legacy_${entry.label}` },
      },
    }, options(store, client));
    const startBtn = getStartDispatchButton(result.updatedCard);
    const startResult = await handleDispatchEvent({
      event: {
        operator: { open_id: 'ou_operator' },
        action: { tag: 'button', value: startBtn.value },
        context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
      },
    }, options(store, client));
    await startResult.afterResponse();

    assert.equal(store.initializeDetails[0].scope, entry.expectedScope, `${entry.label} 初始化 scope`);
    assert.deepEqual(
      [store.assignDetails[0].scope, store.assignDetails[0].direction],
      [entry.expectedScope, entry.expectedDirection],
      `${entry.label} 派单 profile`,
    );
  }
});

test('派生 profile 字段不改变旧批次 fingerprint，PROCESSING/PARTIAL/FAILED 重试沿用原指纹', () => {
  const normalizedItems = validateBatchDispatchValue({
    action: 'bess_batch_auto_dispatch', schema_version: 1,
    batch_id: 'legacy_fingerprint', items: [item('legacy_fingerprint_1', 10)],
  }).items;
  const legacyItems = normalizedItems.map((entry) => {
    const legacy = { ...entry };
    delete legacy.dispatchProfile;
    delete legacy.dispatchScope;
    delete legacy.dispatchDirection;
    return legacy;
  });
  const oldFingerprint = createHash('sha256').update(JSON.stringify(legacyItems)).digest('hex');

  assert.equal(batchDispatchFingerprint(normalizedItems), oldFingerprint);
  assert.equal(batchDispatchFingerprint(legacyItems), oldFingerprint);
  for (const status of ['PROCESSING', 'PARTIAL', 'FAILED']) {
    assert.equal(
      batchDispatchFingerprint(normalizedItems),
      oldFingerprint,
      `${status} 重试不得因派生 profile 字段产生指纹冲突`,
    );
  }
});


test('跨批次锚点扫描较旧时以更新的持久派单为准，F 到 G 不重复负责人', async () => {
  const store = new BatchStore();
  store.state = { roster: ['邱胤超', '张梦慧', '冯俊杰', '王晓凤', '吴红'] };
  store.cursor = 4;
  store.assignments.set('f_segment', {
    id: 100,
    assignee: '王晓凤',
    request_context: {
      sheetId: 'sheetA', businessType: 'AD', targetCategory: 'ad', rowIndex: 30,
    },
  });
  const sheetRows = new Array(33).fill(null).map(() => ['', '', '']);
  sheetRows[12] = ['2026-08-30', '冯俊杰', ''];
  const client = new BatchClient({ sheetRows });
  const gItem = {
    ...item('g_first', 33),
    business_type: 'AD', target_category: 'ad', date_field_id: 'J', assignee_field_id: 'B',
    project_field_id: undefined, project_value: undefined,
  };
  const result = await handleDispatchEvent(batchBody('ad_g_cross_batch', [gItem]), options(store, client));
  await result.afterResponse();
  const write = client.calls.find((call) => call.kind === 'write' && call.rowIndex === 33);
  assert.equal(write?.assignee, '吴红');
  assert.equal(store.calibrations.length, 0, '已消费的持久派单不再次校准');
});

test('跨批次首条若游标异常返回上一负责人则 fail-closed 且不写表', async () => {
  const store = new BatchStore();
  store.state = { roster: ['邱胤超', '张梦慧', '冯俊杰', '王晓凤', '吴红'] };
  store.calibrateCursor = async ({ dayKey, direction, assignee, roster }) => {
    store.calibrations.push({ dayKey, direction, assignee, roster });
    store.cursor = roster.indexOf(assignee);
  };
  const sheetRows = new Array(33).fill(null).map(() => ['', '', '']);
  sheetRows[29] = ['2026-08-30', '王晓凤', ''];
  const client = new BatchClient({ sheetRows });
  const gItem = {
    ...item('g_duplicate', 33),
    business_type: 'AD', target_category: 'ad', date_field_id: 'J', assignee_field_id: 'B',
    project_field_id: undefined, project_value: undefined,
  };
  const result = await handleDispatchEvent(batchBody('ad_g_duplicate_guard', [gItem]), options(store, client));
  await result.afterResponse();
  assert.equal(client.calls.some((call) => call.kind === 'write' && call.rowIndex === 33), false);
  const completed = store.getBatch('oc_allowed', 'ad_g_duplicate_guard');
  assert.equal(completed.status, 'FAILED');
  assert.match(completed.results[0].message, /重复/);
});


test('CAS 故障注入：冲突后重读 sheet/durable anchor，另一批已派乙则当前派丙', async () => {
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙'] };
  const sheetRows = new Array(20).fill(null).map(() => ['', '', '']);
  sheetRows[8] = ['2026-08-30', '甲', '千川'];
  const client = new BatchClient({ sheetRows });
  const originalAssign = store.assign.bind(store);
  let injected = false;
  store.assign = async (args) => {
    if (!injected) {
      injected = true;
      // 模拟另一批次在当前 CAS 快照后提交“乙”。
      store.cursor = 2;
      sheetRows[8][1] = '乙';
      store.assignments.set('other_batch', {
        id: 99, assignee: '乙', direction: 'forward',
        request_context: { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 9 },
      });
      const error = new Error('injected CAS conflict');
      error.code = 'ASSIGNMENT_CONFLICT';
      throw error;
    }
    return originalAssign(args);
  };

  const result = await handleDispatchEvent(
    batchBody('batch_cas_anchor_refresh', [item('cas_retry_current', 10)]),
    options(store, client),
  );
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'batch_cas_anchor_refresh');
  assert.equal(batch.results[0].status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '丙');
  assert.ok(client.calls.filter((call) => call.kind === 'read').length >= 2,
    '冲突重试必须重新读取 sheet 与 durable anchor');
});

test('预校准 CAS 冲突重读完整锚点，已派乙后应派丙而不是重派乙', async () => {
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙'], version: 1, forward_version: 1 };
  store.cursor = 1;
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[8] = ['2026-08-30', '甲', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  let injected = false;
  store.calibrateCursor = async ({ assignee, roster, direction, expectedVersion, expectedCursorVersion }) => {
    store.calibrations.push({ assignee, direction, expectedVersion, expectedCursorVersion });
    if (!injected) {
      injected = true;
      store.cursor = 2;
      store.state.forward_version = 2;
      rows[8][1] = '乙';
      store.assignments.set('concurrent_other', { id: 99, assignee: '乙', direction: 'forward',
        request_context: { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 9 } });
      const error = new Error('CAS_FORWARD_CURSOR_MISMATCH');
      error.code = 'CURSOR_CALIBRATION_CONFLICT';
      throw error;
    }
    const residue = (roster.indexOf(assignee) + 1) % roster.length;
    store.cursor += (residue - store.cursor % roster.length + roster.length) % roster.length;
    store.state.forward_version += 1;
    return store.getDailyState();
  };
  const result = await handleDispatchEvent(
    batchBody('calibration_refresh', [item('current_after_conflict', 10)]), options(store, client),
  );
  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'calibration_refresh');
  assert.equal(batch.results[0].status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, '丙');
  assert.equal(store.calibrations.filter(({ assignee }) => assignee === '甲').length, 1);
  assert.equal(store.calibrations[0].expectedVersion, 1);
  assert.equal(store.calibrations[0].expectedCursorVersion, 1);
});

for (const direction of ['forward', 'reverse']) {
  test(`${direction} 整圈边界：已消费的自动锚点不能再次推动 cursor`, async () => {
    const store = new BatchStore();
    store.state = { roster: ['A', 'B', 'C'], version: 1, forward_version: 4, reverse_version: 4 };
    store.cursor = 3;
    store.reverseCursor = 3;
    const previous = direction === 'forward' ? 'A' : 'C';
    const businessType = direction === 'forward' ? '千川' : '本地推';
    const old = { id: 1, assignee: previous, direction,
      request_context: { sheetId: 'sheetA', businessType, projectValue: businessType, rowIndex: 7 } };
    store.assignments.set('old', old);
    const rows = new Array(20).fill(null).map(() => ['', '', '']);
    rows[6] = ['2026-08-30', previous, businessType];
    const client = new BatchClient({ sheetRows: rows });
    const single = batchBody(`boundary_${direction}`);
    single.event.action.value = { ...item(`next_${direction}`, 12), business_type: businessType,
      target_category: direction === 'forward' ? 'qianchuan' : 'local_promo', project_value: businessType };
    // Only the automatic anchor is stale; the durable cursor is authoritative.
    // It must not be treated as a fresh manual edit or drive duplicate guards.
    const result = await handleDispatchEvent(single, options(store, client));
    if (result.afterResponse) await result.afterResponse();
    assert.equal(result.body.toast.type, 'success');
    assert.equal(store.assignments.get(`next_${direction}`)?.assignee, direction === 'forward' ? 'A' : 'C');
    assert.equal(store.calibrations.length, 0);
  });
}

for (const direction of ['forward', 'reverse']) {
  test(`${direction}: RPC 已提交后人工填写时写前保护拒绝覆盖，重试不得伪报成功`, async () => {
    const store = new BatchStore();
    store.state = { roster: ['甲', '乙', '丙'] };
    const businessType = direction === 'forward' ? '千川' : '本地推';
    const fieldsFor = (id, row) => ({ ...item(id, row), business_type: businessType,
      target_category: direction === 'forward' ? 'qianchuan' : 'local_promo', project_value: businessType });
    const rows = new Array(20).fill(null).map(() => ['', '', '']);
    const client = new BatchClient({ sheetRows: rows });
    const assign = store.assign.bind(store);
    store.assign = async (args) => {
      const assigned = await assign(args);
      if (args.requestId === 'late_manual_edit') rows[9] = ['2026-08-30', '人工已填', businessType];
      return assigned;
    };
    const batchId = `late_guard_${direction}`;
    const request = batchBody(batchId, [fieldsFor('late_manual_edit', 10), fieldsFor('after_late_edit', 11)]);
    const first = await handleDispatchEvent(request, options(store, client));
    await first.afterResponse();
    const committed = store.assignments.get('late_manual_edit');
    assert.ok(committed, '保留真实已提交账本，不倒退或删除');
    assert.equal(rows[9][1], '人工已填');
    assert.equal(client.calls.filter(({ kind, rowIndex }) => kind === 'write' && rowIndex === 10).length, 0);
    assert.equal(store.getBatch('oc_allowed', batchId).results[0].errorCode, 'SHEET_TARGET_CHANGED');
    assert.equal(store.getBatch('oc_allowed', batchId).status, 'PARTIAL');
    assert.match(store.getBatch('oc_allowed', batchId).results[0].message, /人工核对/);

    const retry = await handleDispatchEvent(request, options(store, client));
    await retry.afterResponse();
    assert.equal(rows[9][1], '人工已填');
    assert.equal(store.assignments.get('late_manual_edit'), committed);
    assert.equal(store.getBatch('oc_allowed', batchId).results[0].errorCode, 'SHEET_ASSIGNMENT_MISMATCH');
    assert.equal(store.getBatch('oc_allowed', batchId).status, 'PARTIAL');
    assert.equal(client.calls.filter(({ kind, rowIndex }) => kind === 'write' && rowIndex === 10).length, 0);
  });
}

test('目标行实时读取失败时不能把失败解释为空行，不抢占、不写表', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  client.readSheetAssignee = async () => { throw new LarkApiError('LARK_API_TIMEOUT', 'timeout'); };
  const result = await handleDispatchEvent(batchBody('target_read_timeout', [item('must_not_assign', 10)]), options(store, client));
  await result.afterResponse();
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
  assert.equal(store.getBatch('oc_allowed', 'target_read_timeout').results[0].errorCode, 'LARK_API_TIMEOUT');
});

test('目标行反复变化导致实时单元格与重读快照不一致时拒绝继续派单', async () => {
  const store = new BatchStore();
  const client = new BatchClient();
  const values = ['第一次人工填写', '第二次人工填写'];
  client.readSheetAssignee = async () => values.shift();
  const result = await handleDispatchEvent(batchBody('unstable_target', [item('must_not_assign', 10)]), options(store, client));
  await result.afterResponse();
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
  assert.equal(store.getBatch('oc_allowed', 'unstable_target').results[0].errorCode, 'SHEET_TARGET_CHANGED');
});

test('锚点与 state 读取期间并发提交 B/C，单条派单不得跳过下一圈 A', async () => {
  const store = new BatchStore();
  store.state = { roster: ['A', 'B', 'C'], version: 1, forward_version: 2 };
  store.cursor = 1;
  const oldA = { id: 1, assignee: 'A', direction: 'forward',
    request_context: { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 7 } };
  store.assignments.set('already_A', oldA);
  let raced = false;
  store.getDailyAssignments = async () => {
    const snapshot = [...store.assignments.values()].sort((a, b) => b.id - a.id);
    if (!raced) {
      raced = true;
      store.assignments.set('already_B', { ...oldA, id: 2, assignee: 'B', request_context: { ...oldA.request_context, rowIndex: 8 } });
      store.assignments.set('already_C', { ...oldA, id: 3, assignee: 'C', request_context: { ...oldA.request_context, rowIndex: 9 } });
      store.cursor = 3;
      store.state.forward_version = 4;
    }
    return snapshot;
  };
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[6] = ['2026-08-30', 'A', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const single = batchBody('mixed_snapshot');
  single.event.action.value = item('next_after_C', 12);
  const result = await handleDispatchEvent(single, options(store, client));
  if (result.afterResponse) await result.afterResponse();
  assert.equal(store.assignments.get('next_after_C')?.assignee, 'A');
  assert.equal(store.calibrations.length, 0);
});

test('单条已填目标校准冲突后重读新负责人，不重用旧名字或覆盖表格', async () => {
  const store = new BatchStore();
  store.state = { roster: ['A', 'B', 'C'], version: 1, forward_version: 1 };
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[11] = ['2026-08-30', 'A', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  store.calibrateCursor = async ({ assignee }) => {
    store.calibrations.push({ assignee });
    rows[11][1] = 'B';
    store.cursor = 2;
    store.state.forward_version = 2;
    store.assignments.set('filled_during_conflict', { id: 1, assignee: 'B', direction: 'forward',
      request_context: { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 12 } });
    const error = new Error('calibration conflict');
    error.code = 'CURSOR_CALIBRATION_CONFLICT';
    throw error;
  };
  const single = batchBody('filled_conflict');
  single.event.action.value = item('filled_during_conflict', 12);
  const result = await handleDispatchEvent(single, options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.match(result.body.toast.content, /B/);
  assert.equal(store.calibrations.length, 1);
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
});

test('单条空目标派单冲突后变为已填写，只回读结果而不继续派单或写表', async () => {
  const store = new BatchStore();
  store.state = { roster: ['A', 'B', 'C'], version: 1, forward_version: 1 };
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows });
  let attempts = 0;
  store.assign = async () => {
    attempts += 1;
    rows[11] = ['2026-08-30', 'B', '千川'];
    store.cursor = 2;
    store.state.forward_version = 2;
    store.assignments.set('filled_while_assigning', { id: 1, assignee: 'B', direction: 'forward',
      request_context: { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 12 } });
    const error = new Error('assignment conflict');
    error.code = 'ASSIGNMENT_CONFLICT';
    throw error;
  };
  const single = batchBody('target_changed');
  single.event.action.value = item('filled_while_assigning', 12);
  const result = await handleDispatchEvent(single, options(store, client));
  assert.equal(result.body.toast.type, 'success');
  assert.match(result.body.toast.content, /B/);
  assert.equal(attempts, 1);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
});

test('同一表格行多个账本记录以最新值识别自动锚点，不误判为人工校准', async () => {
  const store = new BatchStore();
  store.state = { roster: ['A', 'B', 'C'] };
  store.cursor = 2;
  const context = { sheetId: 'sheetA', businessType: '千川', projectValue: '千川', rowIndex: 9 };
  store.assignments.set('old_row_value', { id: 1, assignee: 'A', request_context: context });
  store.assignments.set('new_row_value', { id: 2, assignee: 'B', request_context: context });
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[8] = ['2026-08-30', 'B', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const result = await handleDispatchEvent(batchBody('newest_row_ledger', [item('next_after_newest', 12)]), options(store, client));
  await result.afterResponse();
  assert.equal(store.getBatch('oc_allowed', 'newest_row_ledger').results[0].assignee, 'C');
  assert.equal(store.calibrations.length, 0);
});

test('预校准持续冲突时有限重试并阻止整个方向派单，不让其他空行绕过门禁', async () => {
  const store = new BatchStore();
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[8] = ['2026-08-30', '张三', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  store.calibrateCursor = async ({ assignee }) => {
    store.calibrations.push({ assignee });
    const error = new Error('concurrent cursor update');
    error.code = 'CURSOR_CALIBRATION_CONFLICT';
    throw error;
  };
  const result = await handleDispatchEvent(
    batchBody('persistent_calibration_conflict', [item('blocked_first', 10), item('blocked_second', 11)]),
    options(store, client),
  );
  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'persistent_calibration_conflict');
  assert.equal(batch.status, 'FAILED');
  assert.ok(batch.results.every(({ errorCode }) => errorCode === 'CURSOR_CALIBRATION_CONFLICT'));
  assert.equal(store.calibrations.length, 2);
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
});

test('混合方向校准冲突使用新名单及新锚点，不能把旧锚点配上新版本', async () => {
  const store = new BatchStore();
  store.state = { roster: ['A', 'B', 'C'], version: 1, forward_version: 1, reverse_version: 1 };
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[8] = ['2026-08-30', 'A', '千川'];
  const client = new BatchClient({ sheetRows: rows });
  const originalCalibrate = store.calibrateCursor.bind(store);
  let changed = false;
  store.calibrateCursor = async (args) => {
    if (!changed) {
      changed = true;
      store.calibrations.push(args);
      store.state = { roster: ['X', 'Y', 'Z'], version: 2, forward_version: 2, reverse_version: 1 };
      rows[8][1] = 'Y';
      const error = new Error('roster changed');
      error.code = 'CURSOR_CALIBRATION_CONFLICT';
      throw error;
    }
    assert.deepEqual(args.roster, ['X', 'Y', 'Z']);
    assert.equal(args.assignee, 'Y');
    assert.equal(args.expectedVersion, 2);
    return originalCalibrate(args);
  };
  const local = { ...item('mixed_reverse_after_change', 12), business_type: '本地推',
    target_category: 'local_promo', project_value: '本地推' };
  const result = await handleDispatchEvent(
    batchBody('mixed_roster_conflict', [item('mixed_forward_after_change', 10), local]), options(store, client),
  );
  await result.afterResponse();
  const batch = store.getBatch('oc_allowed', 'mixed_roster_conflict');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(batch.results[0].assignee, 'Z');
  assert.equal(batch.results[1].assignee, 'Z');
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['A', 'Y']);
});

for (const direction of ['forward', 'reverse']) {
  for (const injection of ['assignment_conflict', 'first_write']) {
    for (const manualValue of ['人工已填', '乙']) {
      test(`${direction}/${injection}/${manualValue}: 后续行的旧空快照不能覆盖新人工值`, async () => {
        const store = new BatchStore();
        store.state = { roster: ['甲', '乙', '丙', '人工已填'] };
        const businessType = direction === 'forward' ? '千川' : '本地推';
        const fieldsFor = (id, row) => ({ ...item(id, row), business_type: businessType,
          target_category: direction === 'forward' ? 'qianchuan' : 'local_promo', project_value: businessType });
        const rows = new Array(20).fill(null).map(() => ['', '', '']);
        const fillSecond = () => { rows[10] = ['2026-08-30', manualValue, businessType]; };
        const client = new BatchClient({ sheetRows: rows,
          onWrite: injection === 'first_write' ? ({ rowIndex }) => { if (rowIndex === 10) fillSecond(); } : undefined });
        const assign = store.assign.bind(store);
        let raced = false;
        store.assign = async (args) => {
          if (injection === 'assignment_conflict' && !raced) {
            raced = true;
            fillSecond();
            const error = new Error('first row CAS conflict');
            error.code = 'ASSIGNMENT_CONFLICT';
            throw error;
          }
          return assign(args);
        };
        const batchId = `later_target_${direction}_${injection}_${manualValue === '乙' ? 'roster' : 'external'}`;
        const result = await handleDispatchEvent(batchBody(batchId, [
          fieldsFor('first_racing_target', 10), fieldsFor('later_manual_target', 11),
        ]), options(store, client));
        assert.equal(typeof result.afterResponse, 'function', JSON.stringify(result.body));
        await result.afterResponse();
        const batch = store.getBatch('oc_allowed', batchId);
        assert.equal(client.calls.filter(({ kind, rowIndex }) => kind === 'write' && rowIndex === 11).length, 0);
        assert.equal(rows[10][1], manualValue);
        assert.equal(store.assignments.has('later_manual_target'), false, '不得为已填后续行新建自动派单');
        assert.equal(batch.status, 'SUCCESS');
        assert.equal(batch.results[1].assignee, manualValue);
        assert.equal(batch.results[1].replayed, true);
      });
    }
  }
}


test('原子批量：全空批次单次 batch read、assignBatch 与 batch write，且不走逐条派单写入', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const client = new BatchClient({ sheetRows: rows, batchApi: true });
  const items = [item('atomic_empty_1', 10), item('atomic_empty_2', 11), item('atomic_empty_3', 12)];

  const result = await handleDispatchEvent(batchBody('atomic_all_empty', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'atomic_all_empty');
  assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.map(({ requestId, assignee }) => [requestId, assignee]), [
    ['atomic_empty_1', '甲'], ['atomic_empty_2', '乙'], ['atomic_empty_3', '丙'],
  ]);
  assert.deepEqual(rows.slice(9, 12).map((row) => row[1]), ['甲', '乙', '丙']);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchRead').length, 1);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchWrite').length, 1);
  assert.equal(client.calls.filter(({ kind }) => kind === 'readCell').length, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
  assert.equal(store.assignBatchCalls, 1);
  assert.equal(store.assignCalls, 0);
  assert.deepEqual(store.assignBatchDetails[0].requestIds, items.map(({ request_id }) => request_id));
  assert.equal(store.cursor, 3);
  assert.equal(store.calibrations.length, 0);
});

test('原子批量：前序人工锚点只校准一次，随后一次 assignBatch 与 batch write', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[8] = ['2026-08-30', '乙', '千川'];
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const client = new BatchClient({ sheetRows: rows, batchApi: true });
  const items = [item('atomic_anchor_1', 10), item('atomic_anchor_2', 11), item('atomic_anchor_3', 12)];

  const result = await handleDispatchEvent(batchBody('atomic_after_manual_anchor', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'atomic_after_manual_anchor');
  assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.map(({ requestId, assignee }) => [requestId, assignee]), [
    ['atomic_anchor_1', '丙'], ['atomic_anchor_2', '甲'], ['atomic_anchor_3', '乙'],
  ]);
  assert.deepEqual(rows.slice(9, 12).map((row) => row[1]), ['丙', '甲', '乙']);
  assert.deepEqual(store.calibrations.map(({ direction, assignee }) => [direction, assignee]), [['forward', '乙']]);
  assert.equal(store.assignBatchCalls, 1);
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchRead').length, 1);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchWrite').length, 1);
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
});

test('原子批量：目标行存在人工负责人时安全降级，禁止批量覆盖', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[10] = ['2026-08-30', '乙', '千川'];
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const client = new BatchClient({ sheetRows: rows, batchApi: true });

  const result = await handleDispatchEvent(batchBody('atomic_target_conflict', [
    item('target_conflict_empty', 10), item('target_conflict_manual', 11), item('target_conflict_after', 12),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'atomic_target_conflict');
  assert.equal(batch.status, 'SUCCESS');
  assert.equal(rows[10][1], '乙');
  assert.equal(store.assignBatchCalls, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchWrite').length, 0);
  assert.equal(client.calls.filter(({ kind, rowIndex }) => kind === 'write' && rowIndex === 11).length, 0);
});

test('人工锚点在首条：跳过人工行，校准后续空行且仅逐条写入空目标', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '乙', '千川'];
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙', '丁'] };
  const client = new BatchClient({ sheetRows: rows });

  const result = await handleDispatchEvent(batchBody('manual_at_first', [
    item('first_manual', 10), item('first_empty_1', 11), item('first_empty_2', 12),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'manual_at_first');
  assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.map(({ assignee }) => assignee), ['乙', '丙', '丁']);
  assert.deepEqual(client.calls.filter(({ kind }) => kind === 'write').map(({ rowIndex, assignee }) => [rowIndex, assignee]), [
    [11, '丙'], [12, '丁'],
  ]);
  assert.equal(store.assignCalls, 2);
  assert.equal(store.assignBatchCalls, 0);
  assert.deepEqual(store.calibrations.map(({ direction, assignee }) => [direction, assignee]), [['forward', '乙']]);
  assert.equal(store.cursor, 4);
});

test('人工锚点在中间：前序沿用旧游标，人工行校准，后序从下一人继续', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[10] = ['2026-08-30', '丙', '千川'];
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙', '丁'] };
  store.cursor = 1;
  const client = new BatchClient({ sheetRows: rows });

  const result = await handleDispatchEvent(batchBody('manual_in_middle', [
    item('middle_before', 10), item('middle_manual', 11), item('middle_after', 12),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'manual_in_middle');
  assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.map(({ assignee }) => assignee), ['乙', '丙', '丁']);
  assert.deepEqual(client.calls.filter(({ kind }) => kind === 'write').map(({ rowIndex, assignee }) => [rowIndex, assignee]), [
    [10, '乙'], [12, '丁'],
  ]);
  assert.equal(store.assignCalls, 2);
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['丙']);
  assert.equal(store.cursor, 4);
});

test('人工锚点在末条：前序正常派单，末条不覆盖并成为最终游标锚点', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[11] = ['2026-08-30', '丁', '千川'];
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙', '丁'] };
  const client = new BatchClient({ sheetRows: rows });

  const result = await handleDispatchEvent(batchBody('manual_at_last', [
    item('last_before_1', 10), item('last_before_2', 11), item('last_manual', 12),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'manual_at_last');
  assert.equal(batch.status, 'SUCCESS');
  assert.deepEqual(batch.results.map(({ assignee }) => assignee), ['甲', '乙', '丁']);
  assert.deepEqual(client.calls.filter(({ kind }) => kind === 'write').map(({ rowIndex, assignee }) => [rowIndex, assignee]), [
    [10, '甲'], [11, '乙'],
  ]);
  assert.equal(store.assignCalls, 2);
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['丁']);
  assert.equal(store.cursor, 4);
});

test('多个人工锚点：按行序消费全部空行并以最高行人工值作为最终锚点', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[10] = ['2026-08-30', '乙', '千川'];
  rows[12] = ['2026-08-30', '丁', '千川'];
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙', '丁'] };
  const client = new BatchClient({ sheetRows: rows });
  const items = [
    item('multi_empty_1', 10), item('multi_manual_1', 11), item('multi_empty_2', 12),
    item('multi_manual_latest', 13), item('multi_empty_3', 14),
  ];

  const result = await handleDispatchEvent(batchBody('multiple_manual_anchors', items), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'multiple_manual_anchors');
  assert.equal(batch.status, 'SUCCESS', JSON.stringify(batch.results));
  assert.deepEqual(batch.results.map(({ assignee }) => assignee), ['甲', '乙', '丙', '丁', '甲']);
  assert.deepEqual(client.calls.filter(({ kind }) => kind === 'write').map(({ rowIndex, assignee }) => [rowIndex, assignee]), [
    [10, '甲'], [12, '丙'], [14, '甲'],
  ]);
  assert.equal(store.assignCalls, 3);
  assert.deepEqual(store.calibrations.map(({ assignee }) => assignee), ['乙', '丁']);
  assert.equal(store.calibrations.at(-1).assignee, '丁');
  assert.equal(store.cursor, 1, '最高行锚点丁之后派甲，下一游标应落到乙');
});

test('人工值不在 roster：整条正序方向 fail-closed，不覆盖且不推进游标', async () => {
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  rows[9] = ['2026-08-30', '外援', '千川'];
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙'] };
  store.cursor = 1;
  const client = new BatchClient({ sheetRows: rows });

  const result = await handleDispatchEvent(batchBody('manual_outside_roster', [
    item('outside_manual', 10), item('outside_blocked_empty', 11),
  ]), options(store, client));
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'manual_outside_roster');
  assert.equal(batch.status, 'FAILED');
  assert.deepEqual(batch.results.map(({ status, errorCode }) => [status, errorCode]), [
    ['FAILED', 'ASSIGNEE_NOT_IN_ROSTER'], ['FAILED', 'ASSIGNEE_NOT_IN_ROSTER'],
  ]);
  assert.equal(rows[9][1], '外援');
  assert.equal(rows[10][1], '');
  assert.equal(client.calls.filter(({ kind }) => kind === 'write').length, 0);
  assert.equal(client.calls.filter(({ kind }) => kind === 'batchWrite').length, 0);
  assert.equal(store.assignCalls, 0);
  assert.equal(store.assignBatchCalls, 0);
  assert.equal(store.calibrations.length, 0);
  assert.equal(store.cursor, 1);
});


test('request_id 重定位不修改批次 identity：旧行号→部分失败→同 batchId 重试不冲突且写入新行', async () => {
  const store = new BatchStore();
  store.state = { roster: ['甲', '乙', '丙'] };
  const originalItems = [item('relocate_retry_1', 10), item('relocate_retry_2', 11)];
  const request = batchBody('relocate_partial_retry', originalItems);
  const rows = new Array(30).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows, failRows: [21] });
  const resolvedRows = new Map([['relocate_retry_1', 20], ['relocate_retry_2', 21]]);
  client.locateSheetRequestRow = async ({ requestId }) => ({
    rowIndex: resolvedRows.get(requestId), scanComplete: true,
  });

  const first = await handleDispatchEvent(request, options(store, client));
  await first.afterResponse();
  assert.equal(store.getBatch('oc_allowed', 'relocate_partial_retry').status, 'PARTIAL');
  assert.deepEqual(originalItems.map(({ row_index: row }) => row), [10, 11],
    '运行时重定位不得改写 action.items');
  assert.ok(client.calls.some(({ kind, rowIndex }) => kind === 'write' && rowIndex === 20));
  assert.ok(client.calls.some(({ kind, rowIndex }) => kind === 'write' && rowIndex === 21));
  assert.equal(client.calls.some(({ kind, rowIndex }) => kind === 'write' && [10, 11].includes(rowIndex)), false);

  client.failRows.delete(21);
  const retry = await handleDispatchEvent(request, options(store, client));
  await retry.afterResponse();
  assert.notEqual(retry.errorCode, 'BATCH_ID_CONFLICT');
  assert.equal(store.getBatch('oc_allowed', 'relocate_partial_retry').status, 'SUCCESS');
  assert.deepEqual(originalItems.map(({ row_index: row }) => row), [10, 11]);
  assert.equal(rows[20][1], '乙', '失败项重试必须继续写 request_id 重定位后的第 21 行');
});


test('原子批量按 request_id 重定位：空/过期行号使用 resolvedRowIndex 读写并持久化上下文', async () => {
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const originalItems = [item('fast_relocate_null', null), item('fast_relocate_stale', 11)];
  const rows = new Array(30).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows, batchApi: true });
  const resolvedRows = new Map([['fast_relocate_null', 20], ['fast_relocate_stale', 21]]);
  client.locateSheetRequestRow = async ({ requestId }) => ({
    rowIndex: resolvedRows.get(requestId), scanComplete: true,
  });

  const result = await handleDispatchEvent(
    batchBody('atomic_resolved_rows', originalItems), options(store, client),
  );
  await result.afterResponse();

  assert.equal(store.getBatch('oc_allowed', 'atomic_resolved_rows').status, 'SUCCESS');
  assert.deepEqual(originalItems.map(({ row_index: row }) => row), [null, 11],
    '运行时重定位不得改写 action.items 或批次 fingerprint');
  assert.deepEqual(client.calls.find(({ kind }) => kind === 'batchRead').ranges, [
    'sheetA!J20:J20', 'sheetA!J21:J21',
  ]);
  assert.deepEqual(client.calls.find(({ kind }) => kind === 'batchWrite').valueRanges.map(({ range }) => range), [
    'sheetA!J20:J20', 'sheetA!J21:J21',
  ]);
  assert.deepEqual(store.assignBatchDetails[0].contexts.map(({ rowIndex }) => rowIndex), [20, 21]);
  assert.deepEqual(rows.slice(19, 21).map((row) => row[1]), ['甲', '乙']);
  assert.equal(rows[10][1], '', '过期的原始第 11 行不得被写入');
});

test('原子批量写失败后逐条补偿继续使用 request_id 重定位行，原始空行号不阻断', async () => {
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const originalItems = [item('fast_fallback_null', null), item('fast_fallback_stale', 11)];
  const rows = new Array(30).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows, batchApi: true });
  const resolvedRows = new Map([['fast_fallback_null', 20], ['fast_fallback_stale', 21]]);
  client.locateSheetRequestRow = async ({ requestId }) => ({
    rowIndex: resolvedRows.get(requestId), scanComplete: true,
  });
  const writeSheetValuesBatch = client.writeSheetValuesBatch.bind(client);
  let failBatchWrite = true;
  client.writeSheetValuesBatch = async (args) => {
    if (failBatchWrite) {
      failBatchWrite = false;
      const error = new LarkApiError('LARK_API_90202', 'WrongRange');
      throw error;
    }
    return writeSheetValuesBatch(args);
  };

  const result = await handleDispatchEvent(
    batchBody('atomic_resolved_fallback', originalItems), options(store, client),
  );
  await result.afterResponse();

  assert.equal(store.getBatch('oc_allowed', 'atomic_resolved_fallback').status, 'SUCCESS');
  assert.equal(store.assignBatchCalls, 1, '批量账本提交不得重复');
  assert.equal(store.assignCalls, 2, '逐条补偿应重放已提交分配');
  assert.deepEqual(client.calls.filter(({ kind }) => kind === 'write').map(({ rowIndex }) => rowIndex), [20, 21]);
  assert.deepEqual(rows.slice(19, 21).map((row) => row[1]), ['甲', '乙']);
  assert.deepEqual(originalItems.map(({ row_index: row }) => row), [null, 11]);
});

test('request_id 重定位扫描不完整时 fail-closed，不进入批量或逐条写入', async () => {
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙'] };
  const rows = new Array(20).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows, batchApi: true });
  client.locateSheetRequestRow = async () => ({ rowIndex: 20, scanComplete: false });

  const result = await handleDispatchEvent(
    batchBody('relocate_scan_incomplete', [item('scan_incomplete', null)]), options(store, client),
  );
  await result.afterResponse();

  const batch = store.getBatch('oc_allowed', 'relocate_scan_incomplete');
  assert.equal(batch.status, 'FAILED');
  assert.equal(batch.results[0].errorCode, 'SCAN_INCOMPLETE');
  assert.equal(store.assignBatchCalls, 0);
  assert.equal(store.assignCalls, 0);
  assert.equal(client.calls.some(({ kind }) => kind === 'batchWrite' || kind === 'write'), false);
});


test('批量写失败且逐条补偿再次失败时日志保留 request_id 重定位后的真实行号', async () => {
  const store = new BatchStore({ batchApi: true });
  store.state = { roster: ['甲', '乙', '丙'] };
  const originalItems = [item('fast_log_null', null), item('fast_log_stale', 11)];
  const rows = new Array(30).fill(null).map(() => ['', '', '']);
  const client = new BatchClient({ sheetRows: rows, batchApi: true, failRows: [20, 21] });
  const resolvedRows = new Map([['fast_log_null', 20], ['fast_log_stale', 21]]);
  client.locateSheetRequestRow = async ({ requestId }) => ({
    rowIndex: resolvedRows.get(requestId), scanComplete: true,
  });
  client.writeSheetValuesBatch = async () => {
    throw new LarkApiError('LARK_API_90202', 'WrongRange');
  };
  const logs = [];

  const result = await handleDispatchEvent(
    batchBody('atomic_resolved_failure_logs', originalItems),
    options(store, client, { logger: { info(line) { logs.push(JSON.parse(line)); } } }),
  );
  await result.afterResponse();

  assert.equal(store.getBatch('oc_allowed', 'atomic_resolved_failure_logs').status, 'FAILED');
  assert.equal(store.assignBatchCalls, 1);
  assert.equal(store.assignCalls, 2);
  assert.deepEqual(logs.filter(({ stage }) => stage === 'batch_item_failed').map(({ range }) => range), [
    'sheetA!row:20', 'sheetA!row:21',
  ]);
  assert.equal(logs.some(({ range }) => range === 'sheetA!row:11' || range === ''), false);
  assert.equal(client.calls.some(({ kind, rowIndex }) => kind === 'write' && [10, 11].includes(rowIndex)), false);
});
