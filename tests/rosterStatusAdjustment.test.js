import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

class FakeClient {
  constructor() {
    this.calls = [];
  }
  async replyInteractiveCard(args) {
    this.calls.push({ kind: 'replyCard', ...args });
    return { message_id: 'om_form' };
  }
  async replyMessage(args) {
    this.calls.push({ kind: 'replyMessage', ...args });
    return { message_id: 'om_audit' };
  }
  async updateMessageCard(id, card) {
    this.calls.push({ kind: 'update', id, card });
  }
  async writeSheetAssignee(args) {
    this.calls.push({ kind: 'write', ...args });
  }
  async getMessage() { return null; }
  async readSheetDispatchRows(args) {
    return args.selectLatest([], 1);
  }
}

const options = (store, client) => ({
  store,
  client,
  config: { allowedChatIds: 'oc_allowed', featureEnabled: 'true' },
  logger: { info() {} },
  now: () => new Date('2026-09-03T01:00:00Z'),
});

test('人员状态调整：展示调整表单卡片', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.assign({
    dayKey,
    requestId: 'init',
    direction: 'forward',
    roster: ['张三', '李四'],
    expiresAt: '2026-09-04T00:00:00Z',
    context: {},
  });

  const event = {
    header: { event_id: 'evt_1' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        value: { action: 'bess_adjust_status', day_key: dayKey, business_type: '千川' },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };

  const result = await handleDispatchEvent(event, options(store, client));
  assert.equal(result.httpStatus, 200);
  assert.match(result.body.toast.content, /表单已发送到当前话题/);
  const reply = client.calls.find(call => call.kind === 'replyCard');
  assert.ok(reply);
  assert.equal(reply.messageId, 'om_original');
  assert.equal(reply.replyInThread, true);
  const card = reply.card;
  assert.equal(card.header.title.tag, 'plain_text');
  assert.match(card.header.title.content, /人员状态调整/);
  const form = card.body.elements.find(el => el.tag === 'form');
  assert.equal(form.name, 'adjust_status_form');
  assert.equal(form.elements.some(el => el.tag === 'radio'), false);
  assert.equal(form.elements.find(el => el.name === 'target_name')?.tag, 'select_static');
  assert.equal(form.elements.find(el => el.name === 'op_type')?.tag, 'select_static');
  assert.equal(form.elements.find(el => el.name === 'reason')?.input_type, 'text');
  const submit = form.elements.find(el => el.tag === 'button');
  assert.equal(submit.name, 'adjust_status_submit');
  assert.equal(submit.value.expected_version, 1);
});

test('人员状态调整：提交离岗申请、更新状态并留痕', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.assign({
    dayKey,
    requestId: 'init',
    direction: 'forward',
    roster: ['张三', '李四'],
    expiresAt: '2026-09-04T00:00:00Z',
    context: {},
  });

  const event = {
    header: { event_id: 'evt_2' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        value: { action: 'bess_adjust_status_submit', day_key: dayKey, business_type: '千川', expected_version: 1 },
        form_value: { target_name: '张三', op_type: 'leave', reason: '临时开会' },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };

  const result = await handleDispatchEvent(event, options(store, client));
  assert.equal(result.httpStatus, 200);
  assert.match(result.body.toast.content, /张三/);
  assert.match(result.body.toast.content, /离岗/);

  const state = await store.getDailyState(dayKey);
  assert.deepEqual(state.off_duty, ['张三']);
  assert.equal(state.version, 2);

  const audit = client.calls.find(c => c.kind === 'replyMessage');
  assert.match(audit.content.text, /人员状态调整/);
  assert.match(audit.content.text, /张三/);
  assert.match(audit.content.text, /临时离岗/);
});

test('离岗后派单：跳过离岗人员，若全员离岗则失败并禁用按钮', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.assign({
    dayKey,
    requestId: 'init',
    direction: 'forward',
    roster: ['张三', '李四'],
    expiresAt: '2026-09-04T00:00:00Z',
    context: {},
  });

  // 张三离岗
  await store.updateRosterStatus({ dayKey, offDuty: ['张三'], expectedVersion: 1 });

  const dispatchEvent = {
    header: { event_id: 'evt_3' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        value: {
          action: 'bess_auto_dispatch', request_id: 'req_1', request_name: '需求1',
          business_type: '千川', sheet_url: 'u', sheet_id: 's', row_index: 10,
          date_field_id: 'H', assignee_field_id: 'J'
        },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  };

  const result1 = await handleDispatchEvent(dispatchEvent, options(store, client));
  assert.equal(result1.httpStatus, 200);
  assert.match(result1.body.toast.content, /李四/);

  // 李四也离岗
  await store.updateRosterStatus({ dayKey, offDuty: ['张三', '李四'], expectedVersion: 2 });

  const dispatchEvent2 = { ...dispatchEvent, header: { event_id: 'evt_4' } };
  dispatchEvent2.event.action.value.request_id = 'req_2';

  const result2 = await handleDispatchEvent(dispatchEvent2, options(store, client));
  assert.equal(result2.errorCode, 'ALL_OFF_DUTY');
  assert.match(result2.body.toast.content, /所有人员均已离岗/);
  assert.equal(result2.body.card.data.body.elements.find(el => el.tag === 'button').disabled, true);
});


test('人员状态 RPC：使用空 search_path 且仅允许 service_role 执行', () => {
  const migration = readFileSync(new URL('../db/bess-dispatch.sql', import.meta.url), 'utf8');
  const verification = readFileSync(new URL('../db/bess-dispatch-verify.sql', import.meta.url), 'utf8');

  assert.match(
    migration,
    /create or replace function public\.bess_update_roster_status[\s\S]*?security definer\s+set search_path = ''/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.bess_update_roster_status\(date, jsonb, bigint\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.bess_update_roster_status\(date, jsonb, bigint\)\s+to service_role;/i,
  );
  assert.match(verification, /acl\.grantee = 0[\s\S]*?acl\.privilege_type = 'EXECUTE'/i);
  assert.match(verification, /anon 仍可执行 bess_update_roster_status/);
  assert.match(verification, /authenticated 仍可执行 bess_update_roster_status/);
  assert.match(verification, /service_role 缺少 bess_update_roster_status EXECUTE/);
});
