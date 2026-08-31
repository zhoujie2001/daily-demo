import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
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
  async assign({ requestId }) {
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
  constructor({ failRow, failUpdateOnce = false, failReplyOnce = false, onWrite } = {}) {
    this.calls = [];
    this.failRow = failRow;
    this.failUpdateOnce = failUpdateOnce;
    this.failReplyOnce = failReplyOnce;
    this.onWrite = onWrite;
  }
  async readSheetDispatchRows(args) { this.calls.push({ kind: 'read', ...args }); return null; }
  async writeSheetAssignee(args) {
    this.calls.push({ kind: 'write', ...args });
    this.onWrite?.(args);
    if (args.rowIndex === this.failRow) throw new Error('sensitive write error');
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
}

function options(store, client, overrides = {}) {
  return {
    store,
    client,
    config: { allowedChatIds: 'oc_allowed', ...(overrides.config || {}) },
    logger: silentLogger,
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


test('Vercel callback 运行上限为 300 秒', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions['api/lark/callback.js'].maxDuration, 300);
});
