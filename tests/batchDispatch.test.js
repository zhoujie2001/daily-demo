import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LarkApiError } from '../lib/lark/client.js';
import { handleDispatchEvent, redactLarkApiMessage } from '../lib/dispatch/dispatch-service.js';
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

class BatchStore {
  constructor({ now = () => new Date('2026-08-30T11:00:00Z') } = {}) {
    this.state = { roster: ['张三', '李四'] };
    this.assignments = new Map();
    this.pending = new Map();
    this.assignCalls = 0;
    this.cursor = 0;
    this.batchStore = createMemoryBatchStore({ now });
  }

  async claimBatch(args) {
    this.lastClaimArgs = args;
    return this.batchStore.claimBatch(args);
  }
  async saveBatchProgress(args) { return this.batchStore.saveBatchProgress(args); }
  async markBatchFinalization(args) { return this.batchStore.markBatchFinalization(args); }
  async releaseBatchClaim(args) { return this.batchStore.releaseBatchClaim(args); }
  getBatch(chatId, batchId) { return this.batchStore.getBatch(chatId, batchId); }
  async cleanupExpired() {}
  async getDailyState() { return this.state; }
  async getAssignment(_day, requestId) { return this.assignments.get(requestId) || null; }
  async calibrateCursor() {}
  async getPendingByRequest(requestId, chatId) {
    return [...this.pending.values()].find((row) => row.request_id === requestId && row.chat_id === chatId && !row.completed_at) || null;
  }
  async savePending(args) { this.pending.set(args.form_message_id, args); return args; }
  async getPending(id) { return this.pending.get(id) || null; }
  async markPendingCompleted(id) {
    if (this.pending.has(id)) this.pending.get(id).completed_at = new Date().toISOString();
  }
  async assign({ requestId, roster }) {
    if (roster) this.state = { roster };
    this.assignCalls += 1;
    if (this.assignments.has(requestId)) {
      return { ...this.assignments.get(requestId), roster: this.state.roster, replayed: true };
    }
    const assignment = { assignee: this.state.roster[this.cursor % this.state.roster.length] };
    this.cursor += 1;
    this.assignments.set(requestId, assignment);
    return { ...assignment, roster: this.state.roster, replayed: false };
  }
}

class BatchClient {
  constructor({ failRow, failRows = [], failUpdateOnce = false, failReplyOnce = false, onWrite } = {}) {
    this.calls = [];
    this.failRow = failRow;
    this.failRows = new Set(failRows);
    this.failUpdateOnce = failUpdateOnce;
    this.failReplyOnce = failReplyOnce;
    this.onWrite = onWrite;
  }
  async readSheetDispatchRows(args) { this.calls.push({ kind: 'read', ...args }); return null; }
  async writeSheetAssignee(args) {
    this.calls.push({ kind: 'write', ...args });
    this.onWrite?.(args);
    if (args.rowIndex === this.failRow || this.failRows.has(args.rowIndex)) throw new Error('sensitive write error');
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
    return { message_id: 'om_form' };
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

test('批量点击立即禁用按钮，逐项处理后只更新原卡并在单一话题文本中汇总', async () => {
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
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'update').length, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'replyCard').length, 0);
  const update = client.calls.find((call) => call.kind === 'update');
  assert.equal(update.messageId, 'om_batch');
  assert.match(JSON.stringify(update.card), /PARTIAL/);
  assert.match(JSON.stringify(update.card), /SUCCESS/);
  assert.match(JSON.stringify(update.card), /FAILED/);
  const retryButton = update.card.body.elements.at(-1);
  assert.equal(retryButton.disabled, false, '部分失败时原卡必须允许重试失败项');
  assert.equal(retryButton.value.batch_id, 'batch_partial');
  const reply = client.calls.find((call) => call.kind === 'reply');
  assert.equal(reply.replyInThread, true);
  assert.equal(reply.msgType, 'text');
  assert.match(reply.content.text, /批量自动派单结果/);
  assert.doesNotMatch(reply.content.text, /sensitive write error/);
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
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 1);

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
    assert.equal(afterFirst.thread_reply_done, failedEffect !== 'thread');
    assert.equal(store.assignCalls, 2);

    const replay = await handleDispatchEvent(body, options(store, client));
    assert.match(replay.body.toast.content, /恢复|受理/);
    await replay.afterResponse();

    const completed = store.getBatch('oc_allowed', batchId);
    assert.equal(completed.card_update_done, true);
    assert.equal(completed.thread_reply_done, true);
    assert.equal(store.assignCalls, 2, '收尾补偿不得重复执行 item 派单');
    assert.equal(
      client.calls.filter((call) => call.kind === 'update').length,
      failedEffect === 'card' ? 2 : 1,
    );
    assert.equal(
      client.calls.filter((call) => call.kind === 'reply').length,
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
  assert.equal(store.assignCalls, 2);

  client.failRow = undefined;
  const replay = await handleDispatchEvent(body, options(store, client));
  await replay.afterResponse();

  const completed = store.getBatch('oc_allowed', batchId);
  assert.equal(completed.status, 'SUCCESS');
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
  assert.equal(client.calls.filter((call) => call.kind === 'reply').length, 1);
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
  assert.match(resumeResult.body.toast.content, /受理/);

  await resumeResult.afterResponse();
  assert.equal(store.assignCalls, 2);
  assert.equal(store.state.roster.length, 2);
  assert.ok(store.state.roster.includes('王五'));
  assert.ok(store.state.roster.includes('赵六'));

  const update = client.calls.find((c) => c.kind === 'update' && c.messageId === 'om_batch');
  assert.match(JSON.stringify(update.card), /SUCCESS/);
  const formUpdate = client.calls.find((c) => c.kind === 'update' && c.messageId === 'om_form');
  assert.match(JSON.stringify(formUpdate.card), /名单已保存并完成派单/);
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

test('名单表单 PARTIAL 显示橙色真实结果且保持 pending，重试只执行失败项并在 SUCCESS 后完成', async () => {
  const store = new BatchStore();
  store.state = null;
  const client = new BatchClient({ failRow: 11 });
  const body = batchBody('batch_form_partial');
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
  await first.afterResponse();
  const partialCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;
  assert.equal(partialCard.header.template, 'orange');
  assert.match(JSON.stringify(partialCard), /PARTIAL/);
  assert.doesNotMatch(JSON.stringify(partialCard), /派单结果已写回台账|批量处理完成/);
  assert.equal(store.pending.get('om_form').completed_at, undefined);
  assert.equal(store.assignCalls, 2);

  client.failRow = undefined;
  const retry = await handleDispatchEvent(formBody, options(store, client));
  await retry.afterResponse();
  const successCard = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;
  assert.equal(successCard.header.template, 'green');
  assert.match(JSON.stringify(successCard), /派单结果已写回台账/);
  assert.ok(store.pending.get('om_form').completed_at);
  assert.equal(store.assignCalls, 3);
});


test('名单表单 FAILED 显示红色结果且不完成 pending', async () => {
  const store = new BatchStore();
  store.state = null;
  const client = new BatchClient({ failRows: [10, 11] });
  await handleDispatchEvent(batchBody('batch_form_failed'), options(store, client));
  const result = await handleDispatchEvent({
    header: { event_id: 'evt_failed_form' },
    event: {
      operator: { open_id: 'ou_operator' },
      action: { tag: 'dispatch_roster_submit', form_value: { roster_names: '王五, 赵六' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  await result.afterResponse();
  const card = client.calls.filter((call) => call.kind === 'update' && call.messageId === 'om_form').at(-1).card;
  assert.equal(card.header.template, 'red');
  assert.match(JSON.stringify(card), /FAILED/);
  assert.doesNotMatch(JSON.stringify(card), /派单结果已写回台账|批量处理完成/);
  assert.equal(store.pending.get('om_form').completed_at, undefined);
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
