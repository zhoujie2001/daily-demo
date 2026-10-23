import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ITEMS_PER_CARD,
  aggregateDispatchChunkStatuses,
  buildDispatchCardChunkPlans,
  dispatchChunkBatchId,
  splitDispatchCardChunks,
} from '../lib/dispatch/card-chunks.js';

function fields(count) {
  return Array.from({ length: count }, (_, index) => ({
    requestId: `req_${index + 1}`,
    requestName: `需求 ${index + 1}`,
    businessType: '千川',
    targetCategory: 'qianchuan',
    sheetUrl: 'https://example.com/sheets/test',
    sheetId: 'sheet1',
    rowIndex: index + 2,
    assigneeFieldName: '执行人',
    batchCard: true,
  }));
}

function normalized(count, batchId = 'batch_chunk_test') {
  return {
    chatId: 'oc_test', batchId, fieldsList: fields(count), cardTitle: '批量派单',
    period: {}, cardLayout: null,
  };
}

function plans(count) {
  return buildDispatchCardChunkPlans(normalized(count), {
    source: 'test', expiresAt: '2026-11-01T00:00:00.000Z',
  });
}

test('MAX_ITEMS_PER_CARD=20，20/21/30 条分别规划为 1/2/2 张卡', () => {
  assert.equal(MAX_ITEMS_PER_CARD, 20);
  assert.deepEqual([20, 21, 30].map((count) => splitDispatchCardChunks(normalized(count)).map((chunk) => chunk.items.length)), [
    [20], [20, 1], [20, 10],
  ]);
});

test('分片 operation_id 稳定且片间不同，卡片仅携带本片 callback 数据', () => {
  const first = plans(21);
  const replay = plans(21);
  assert.equal(first[0].operationId, replay[0].operationId);
  assert.equal(first[1].operationId, replay[1].operationId);
  assert.notEqual(first[0].operationId, first[1].operationId);
  assert.match(first[0].card.header.title.content, /第 1\/2 张/);
  assert.match(first[1].card.header.title.content, /第 2\/2 张/);

  const firstAction = first[0].card.body.elements.at(-1).behaviors[0].value;
  const secondAction = first[1].card.body.elements.at(-1).behaviors[0].value;
  assert.equal(firstAction.batch_id, first[0].batchId);
  assert.equal(secondAction.batch_id, first[1].batchId);
  assert.equal(firstAction.items.length, 20);
  assert.equal(secondAction.items.length, 1);
  assert.deepEqual(firstAction.items.map((item) => item.request_id), first[0].requestIds);
});

test('分片状态聚合覆盖部分成功、全部成功和单片失败，并保留旧 message_id 字段', () => {
  const batchId = 'batch_status_chunks';
  const ids = [1, 2].map((index) => dispatchChunkBatchId(batchId, index, 2));
  const row = (index, status, extra = {}) => ({
    found: true, batch_id: ids[index - 1], status, operation_id: `op_${index}`,
    request_ids: [`r${index}`], ...extra,
  });

  const partial = aggregateDispatchChunkStatuses(batchId, [
    row(1, 'SENT', { message_id: 'om_1' }), row(2, 'PROCESSING'),
  ]);
  assert.equal(partial.status, 'SENDING');
  assert.deepEqual(partial.message_ids, ['om_1']);

  const sent = aggregateDispatchChunkStatuses(batchId, [
    row(1, 'SENT', { message_id: 'om_1' }), row(2, 'SENT', { message_id: 'om_2' }),
  ]);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.message_id, 'om_1');
  assert.deepEqual(sent.message_ids, ['om_1', 'om_2']);
  assert.equal(sent.chunks.length, 2);

  const failed = aggregateDispatchChunkStatuses(batchId, [
    row(1, 'SENT', { message_id: 'om_1' }),
    row(2, 'DEAD', { error_code: 'LARK_API_230099', retryable: false }),
  ]);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error_code, 'LARK_API_230099');
  assert.equal(failed.dead_letter, true);
});
