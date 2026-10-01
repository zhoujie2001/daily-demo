import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBatchDispatchResultCard, buildDispatchResultCard } from '../lib/lark/card-renderer.js';

const qianchuan = {
  requestId: 'q_1', requestName: '千川需求', businessType: '千川',
};

function rosterColumns(card) {
  return card.body.elements.find((element) => element.tag === 'column_set').columns;
}

test('单条结果卡从持久化双游标分别展示千川与本地历史当前人员', () => {
  const card = buildDispatchResultCard(qianchuan, {
    assignee: '李四', direction: 'forward', roster: ['张三', '李四', '王五'],
    forwardCursor: 2, reverseCursor: 1, dispatchedAt: '2026-09-30 16:00:00',
  });
  const [forward, reverse] = rosterColumns(card).map((column) => column.elements[0].content);
  assert.match(forward, /千川正序名单/);
  assert.match(forward, /2\. 李四 \*\*← 当前人员\*\*/);
  assert.match(reverse, /本地倒序名单/);
  assert.match(reverse, /1\. 王五 \*\*← 当前人员\*\*/);
});

test('批量仅派一个方向时仍按持久化游标展示另一方向真实历史当前人员', () => {
  const card = buildBatchDispatchResultCard([qianchuan], {
    batchId: 'batch_cursor_state', status: 'SUCCESS',
    results: [{ requestId: 'q_1', status: 'SUCCESS', assignee: '李四' }],
    roster: ['张三', '李四', '王五'], direction: 'forward',
    forwardCursor: 2, reverseCursor: 2, dispatchedAt: '2026-09-30 16:00:00',
  });
  const [forward, reverse] = rosterColumns(card).map((column) => column.elements[0].content);
  assert.match(forward, /2\. 李四 \*\*← 当前人员\*\*/);
  assert.match(reverse, /2\. 李四 \*\*← 当前人员\*\*/);
});

test('游标为 0 时对应方向不标记当前人员', () => {
  const card = buildDispatchResultCard(qianchuan, {
    assignee: '张三', direction: 'forward', roster: ['张三', '李四'],
    forwardCursor: 0, reverseCursor: 1, dispatchedAt: '2026-09-30 16:00:00',
  });
  const [forward, reverse] = rosterColumns(card).map((column) => column.elements[0].content);
  assert.doesNotMatch(forward, /当前人员/);
  assert.match(reverse, /当前人员/);
});

test('AD 正序结果卡保持单名单并从 forward 持久化游标标记人员', () => {
  const card = buildDispatchResultCard({ ...qianchuan, businessType: 'AD', dispatchProfile: 'ad' }, {
    assignee: '李四', direction: 'forward', roster: ['张三', '李四', '王五'],
    forwardCursor: 2, reverseCursor: 1, dispatchedAt: '2026-09-30 16:00:00',
  });
  const text = JSON.stringify(card);
  assert.match(text, /AD正序名单（从上到下）/);
  assert.match(text, /李四 \*\*← 当前人员\*\*/);
  assert.doesNotMatch(text, /千川正序|本地倒序|column_set/);
});
