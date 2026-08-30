import assert from 'node:assert/strict';
import test from 'node:test';
import {
  patchCardForDispatched,
  buildDispatchedCard,
  buildDispatchThreadText,
  buildBatchDispatchCard,
  formatDispatchTime,
  DISPATCH_DONE_PREFIX,
} from '../lib/lark/card-renderer.js';

function cardWithButton({ elementId = 'dsp_706001', valueRequestId = '706001' } = {}) {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '【千川/本地推】新增回扫需求' } },
    body: {
      elements: [
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [
                { tag: 'markdown', content: '**需求 706001｜测试需求**\n- 业务类型：千川\n- 已分配给：-' },
              ],
            },
            {
              tag: 'column',
              elements: [
                {
                  tag: 'button',
                  element_id: elementId,
                  text: { tag: 'plain_text', content: '自动派单' },
                  type: 'primary_filled',
                  behaviors: [
                    { type: 'callback', value: { action: 'bess_auto_dispatch', request_id: valueRequestId } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

test('按 element_id 定位按钮并置灰、清空 behaviors、追加结果备注', () => {
  const result = patchCardForDispatched(cardWithButton(), {
    requestId: '706001',
    threadMessageId: 'om_reply_1',
    dispatchedAt: '2026-08-29 19:40:00',
  });

  assert.equal(result.patched, true);
  const card = result.card;
  const button = card.body.elements[0].columns[1].elements[0];
  assert.equal(button.disabled, true);
  assert.equal(button.type, 'default');
  assert.equal(button.text.content, '✅ 已派单');
  assert.deepEqual(button.behaviors, []);
  assert.match(card.body.elements[0].columns[0].elements[0].content, /已分配给：✅ 派单话题已创建/);
  const note = card.body.elements[1];
  assert.match(note.content, /✅ \*\*已派单\*\*｜需求 706001/);
  assert.match(note.content, /2026-08-29 19:40:00/);
});

test('按 callback value.request_id 定位按钮（element_id 缺失时）', () => {
  const card = cardWithButton();
  delete card.body.elements[0].columns[1].elements[0].element_id;
  const result = patchCardForDispatched(card, { requestId: '706001', dispatchedAt: 't' });

  assert.equal(result.patched, true);
  assert.equal(result.card.body.elements[0].columns[1].elements[0].disabled, true);
});

test('找不到对应按钮时返回 patched=false 且不抛异常', () => {
  const result = patchCardForDispatched(cardWithButton({ elementId: 'dsp_999', valueRequestId: '999' }), {
    requestId: '706001',
    dispatchedAt: 't',
  });
  assert.equal(result.patched, false);
});

test('非 2.0 卡片或缺 body 时安全降级', () => {
  assert.equal(patchCardForDispatched(null, { requestId: '1' }).patched, false);
  assert.equal(patchCardForDispatched({ schema: '1.0' }, { requestId: '1' }).patched, false);
  assert.equal(patchCardForDispatched({ schema: '2.0' }, { requestId: '1' }).patched, false);
});

test('重复回写幂等：结果备注只追加一次', () => {
  const once = patchCardForDispatched(cardWithButton(), { requestId: '706001', dispatchedAt: 't' });
  assert.equal(once.patched, true);
  const twice = patchCardForDispatched(once.card, { requestId: '706001', dispatchedAt: 't' });
  assert.equal(twice.patched, true);
  const notes = twice.card.body.elements.filter(
    (element) => element.tag === 'markdown' && element.content.includes(`${DISPATCH_DONE_PREFIX} 706001`),
  );
  assert.equal(notes.length, 1);
});

test('compact 原卡不可用时可生成包含置灰按钮的替代卡片', () => {
  const card = buildDispatchedCard({
    requestId: '706001',
    requestName: '千川测试需求',
    businessType: '千川',
    rowIndex: 32,
    cardTitle: '【千川/本地推】新增回扫需求',
  }, { dispatchedAt: '2026-08-29 20:29:04' });

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, '【千川/本地推】新增回扫需求');
  assert.match(card.body.elements[0].content, /千川测试需求/);
  assert.match(card.body.elements[0].content, /第 32 行/);
  const button = card.body.elements[2];
  assert.equal(button.disabled, true);
  assert.equal(button.type, 'default');
  assert.equal(button.text.content, '✅ 已派单');
  assert.deepEqual(button.behaviors, []);
});

test('话题消息包含需求基本信息', () => {
  const text = buildDispatchThreadText(
    { requestId: '706001', requestName: '千川测试需求', businessType: '千川', rowIndex: 32, cardTitle: '【千川/本地推】新增回扫需求' },
    { dispatchedAt: '2026-08-29 19:40:00' },
  );
  assert.match(text, /自动派单话题已创建/);
  assert.match(text, /需求 ID：706001/);
  assert.match(text, /需求名称：千川测试需求/);
  assert.match(text, /业务类型：千川/);
  assert.match(text, /台账行号：第 32 行/);
  assert.match(text, /来源卡片：【千川\/本地推】新增回扫需求/);
  assert.match(text, /2026-08-29 19:40:00/);
});

test('话题消息在无行号/无卡片标题时省略对应行', () => {
  const text = buildDispatchThreadText(
    { requestId: '706002', requestName: 'EHC 需求', businessType: 'EHC-应急蓝军', rowIndex: null, cardTitle: '' },
    { dispatchedAt: 't' },
  );
  assert.ok(!text.includes('台账行号'));
  assert.ok(!text.includes('来源卡片'));
});

test('formatDispatchTime 输出上海时区 yyyy-MM-dd HH:mm:ss', () => {
  const formatted = formatDispatchTime(new Date('2026-08-29T11:40:05Z')); // 19:40:05 +08:00
  assert.match(formatted, /^2026-08-29 19:40:05$/);
});


test('patchCardForDispatched updates only the matching item in a batch card', () => {
  const fields = [
    { requestId: '715430', requestName: '需求一', businessType: '本地推', rowIndex: 89 },
    { requestId: '715431', requestName: '需求二', businessType: '本地推', rowIndex: 90 },
  ];
  const values = fields.map((item) => ({ request_id: item.requestId }));
  const card = buildBatchDispatchCard(fields, values, { cardTitle: 'E 段' });
  const result = patchCardForDispatched(card, {
    requestId: '715431',
    dispatchedAt: '2026-08-30 18:30',
    assignee: '测试同学',
  });
  assert.equal(result.patched, true);
  const serialized = JSON.stringify(result.card);
  assert.match(serialized, /需求一/);
  assert.match(serialized, /需求二/);
  assert.match(serialized, /需求一[^]*已分配给：-/);
  assert.match(serialized, /需求二[^]*已分配给：✅ 测试同学/);
});
