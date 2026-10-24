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

test('真实新版按钮 value 与 form_value 同时提交使用服务端 pending 快照', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({ dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z' });
  await handleDispatchEvent({
    header: { event_id: 'evt_audit_real_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD', target_category: 'qianchuan_ad', dispatch_profile: 'ad' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  }, options(store, client));
  const formCard = client.calls.find(({ kind }) => kind === 'replyCard').card;
  const form = formCard.body.elements.find(({ tag }) => tag === 'form');
  const button = form.elements.find(({ name }) => name === 'adjust_status_submit');
  const result = await handleDispatchEvent({
    header: { event_id: 'evt_audit_real_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        tag: 'button', value: structuredClone(button.value),
        form_value: { ad_review_off_duty: ['张三'], ad_game_off_duty: ['李四'], ad_emergency_off_duty: [] },
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  const after = await Promise.all(['ad_review', 'ad_game', 'ad_emergency'].map(async (scope) => ({ scope, offDuty: (await store.getDailyState(dayKey, scope)).off_duty })));
  assert.equal(result.errorCode, undefined, '真实按钮提交不得丢弃服务端保存的协议及 CAS 快照');
  assert.deepEqual(after.map(({ offDuty }) => offDuty), [['张三'], ['李四'], []]);
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
  assert.match(reply.uuid, /evt_1/);
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

  await handleDispatchEvent({
    header: { event_id: 'evt_2_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { action: 'bess_adjust_status', day_key: dayKey, business_type: '千川' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  }, options(store, client));

  const event = {
    header: { event_id: 'evt_2' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { target_name: '张三', op_type: 'leave', reason: '临时开会' },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
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
  assert.equal(audit.replyInThread, false);
  assert.match(result.body.card.data.header.title.content, /调整成功/);
  await result.afterResponse();
  const update = client.calls.find(c => c.kind === 'update');
  assert.match(update.card.header.title.content, /调整成功/);
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
  assert.equal(result2.errorCode, 'WAITING_NO_AVAILABLE_ASSIGNEE');
  assert.match(result2.body.toast.content, /所有人员均已离岗/);
  const buttons = result2.body.card.data.body.elements.filter(el => el.tag === 'button');
  assert.equal(buttons.find(button => JSON.stringify(button).includes('bess_auto_dispatch'))?.disabled, true);
  assert.ok(buttons.find(button => JSON.stringify(button).includes('bess_adjust_status')));
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
  assert.match(verification, /'public\.bess_update_roster_status\(date,text,jsonb,bigint\)'/i);
  assert.match(verification, /未授权角色仍可执行 RPC %s/);
  assert.match(verification, /service_role 缺少 RPC %s EXECUTE/);
});


test('人员状态调整重试：目标状态已生效时幂等成功，审计回复失败不回滚业务结果', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  client.replyMessage = async () => {
    const error = new Error('nested thread rejected');
    error.code = 'LARK_API_230099';
    error.httpStatus = 400;
    error.endpoint = '/reply';
    throw error;
  };
  const dayKey = '2026-09-04';
  const replayOptions = { ...options(store, client), now: () => new Date('2026-09-04T01:00:00Z') };
  await store.assign({
    dayKey,
    requestId: 'init-replay',
    direction: 'forward',
    roster: ['张三', '李四'],
    expiresAt: '2026-09-05T00:00:00Z',
    context: {},
  });
  // Real submit buttons are always bound to a previously opened server form.
  // Keep the original stale-version/already-applied scenario, without inventing
  // a submit that never had a pending record.
  await handleDispatchEvent({
    header: { event_id: 'evt_replay_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { action: 'bess_adjust_status', day_key: dayKey, business_type: '千川' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  }, replayOptions);
  await store.updateRosterStatus({ dayKey, offDuty: ['张三'], expectedVersion: 1 });

  const event = {
    header: { event_id: 'evt_replay' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        value: { action: 'bess_adjust_status_submit', day_key: dayKey, business_type: '千川', expected_version: 1 },
        form_value: { target_name: '张三', op_type: 'leave', reason: '重试' },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  };

  const result = await handleDispatchEvent(event, replayOptions);
  assert.equal(result.httpStatus, 200);
  assert.match(result.body.toast.content, /状态已更新为 离岗/);
  const state = await store.getDailyState(dayKey);
  assert.deepEqual(state.off_duty, ['张三']);
  assert.equal(state.version, 2);
});


test('AD 首次名单保存卡入口打开统一三名单表单并独立提交离岗状态', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({
    dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z',
  });
  await handleDispatchEvent({
    header: { event_id: 'evt_ad_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: {
        action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD',
        target_category: 'qianchuan_ad', dispatch_profile: 'ad',
      } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_saved_roster' },
    },
  }, options(store, client));

  const formCard = client.calls.find((call) => call.kind === 'replyCard')?.card;
  assert.ok(formCard);
  const text = JSON.stringify(formCard);
  assert.match(text, /AD大盘名单/);
  assert.match(text, /AD游戏名单/);
  assert.match(text, /应急需求名单/);
  assert.doesNotMatch(text, /仅当前范围|仅另一范围|两个范围/);
  const pending = await store.getPending('om_form', new Date('2026-09-03T01:00:00Z'));
  assert.equal(pending.request_context.statusFormProtocolVersion, 2);
  assert.deepEqual(Object.keys(pending.request_context.expectedAdStates).sort(), [
    'ad_emergency', 'ad_game', 'ad_review',
  ]);

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_ad_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: {
          ad_review_off_duty: ['张三'],
          ad_game_off_duty: ['李四'],
          ad_emergency_off_duty: [],
          reason: '统一调整',
        },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));
  assert.match(result.body.toast.content, /三份名单状态已保存/);
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_review')).off_duty, ['张三']);
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_game')).off_duty, ['李四']);
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_emergency')).off_duty, []);
});


test('AD 旧版状态表单零写入拒绝，不清空三份离岗状态', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({
    dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z',
  });
  const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
  const states = await Promise.all(scopes.map((scope) => store.getDailyState(dayKey, scope)));
  await store.updateAdRosterStatuses({
    dayKey,
    confirmationOperationId: 'seed-legacy-status',
    submissionHash: 'seed-legacy-status',
    confirmedBy: 'ou_seed',
    updates: states.map((state, index) => ({
      scope: state.scope,
      offDuty: index === 1 ? ['李四'] : ['张三'],
      expectedVersion: state.version,
      expectedRosterRevision: state.roster_revision,
    })),
  });
  await store.savePending({
    form_message_id: 'om_legacy_form',
    request_id: 'legacy-status-form',
    original_message_id: 'om_original',
    chat_id: 'oc_allowed',
    request_context: {
      kind: 'adjust_status', dayKey, businessType: 'AD', targetCategory: 'qianchuan_ad',
      dispatchProfile: 'ad', dispatchScope: 'ad_review', expectedVersion: 1,
    },
    expires_at: '2026-09-04T00:00:00Z',
  });

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_legacy_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { range: 'current', target_name: '李四', op_type: 'leave' },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_legacy_form' },
    },
  }, options(store, client));

  assert.equal(result.errorCode, 'AD_STATUS_FORM_PROTOCOL_EXPIRED');
  assert.match(result.body.toast.content, /未修改任何名单/);
  assert.deepEqual(
    await Promise.all(scopes.map(async (scope) => (await store.getDailyState(dayKey, scope)).off_duty)),
    [['张三'], ['李四'], ['张三']],
  );
});

test('AD 新版状态表单缺少任一名单字段时拒绝且不写入', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({
    dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z',
  });
  await handleDispatchEvent({
    header: { event_id: 'evt_missing_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: {
        action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD',
        target_category: 'qianchuan_ad', dispatch_profile: 'ad',
      } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_saved_roster' },
    },
  }, options(store, client));

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_missing_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: { ad_review_off_duty: ['张三'], ad_game_off_duty: [] },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.equal(result.errorCode, 'AD_STATUS_FORM_PROTOCOL_EXPIRED');
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_review')).off_duty, []);
});

test('AD 新版状态表单使用打开时版本做 CAS，并发更新后拒绝覆盖', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({
    dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z',
  });
  await handleDispatchEvent({
    header: { event_id: 'evt_cas_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: {
        action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD',
        target_category: 'qianchuan_ad', dispatch_profile: 'ad',
      } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_saved_roster' },
    },
  }, options(store, client));
  const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
  const openedStates = await Promise.all(scopes.map((scope) => store.getDailyState(dayKey, scope)));
  await store.updateAdRosterStatuses({
    dayKey,
    confirmationOperationId: 'concurrent-status-update',
    submissionHash: 'concurrent-status-update',
    confirmedBy: 'ou_other',
    updates: openedStates.map((state) => ({
      scope: state.scope,
      offDuty: state.scope === 'ad_review' ? ['张三'] : [],
      expectedVersion: state.version,
      expectedRosterRevision: state.roster_revision,
    })),
  });

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_cas_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: {
          ad_review_off_duty: [], ad_game_off_duty: ['李四'], ad_emergency_off_duty: [],
        },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.equal(result.errorCode, 'STATUS_UPDATE_CONFLICT');
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_review')).off_duty, ['张三']);
  assert.deepEqual((await store.getDailyState(dayKey, 'ad_game')).off_duty, []);
});

test('AD 新版状态表单允许用显式空数组主动清空三份离岗状态', async () => {
  const store = createMemoryBatchStore();
  const client = new FakeClient();
  const dayKey = '2026-09-03';
  await store.initializeRoster({
    dayKey, scope: 'ad_review', roster: ['张三', '李四'], expiresAt: '2026-09-04T00:00:00Z',
  });
  const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
  const initial = await Promise.all(scopes.map((scope) => store.getDailyState(dayKey, scope)));
  await store.updateAdRosterStatuses({
    dayKey,
    confirmationOperationId: 'seed-clear-status',
    submissionHash: 'seed-clear-status',
    confirmedBy: 'ou_seed',
    updates: initial.map((state) => ({
      scope: state.scope,
      offDuty: ['张三'],
      expectedVersion: state.version,
      expectedRosterRevision: state.roster_revision,
    })),
  });
  await handleDispatchEvent({
    header: { event_id: 'evt_clear_open' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: {
        action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD',
        target_category: 'qianchuan_ad', dispatch_profile: 'ad',
      } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_saved_roster' },
    },
  }, options(store, client));

  const result = await handleDispatchEvent({
    header: { event_id: 'evt_clear_submit' },
    event: {
      operator: { open_id: 'ou_1' },
      action: {
        form_value: {
          ad_review_off_duty: [], ad_game_off_duty: [], ad_emergency_off_duty: [],
        },
        tag: 'adjust_status_form',
      },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_form' },
    },
  }, options(store, client));

  assert.match(result.body.toast.content, /三份名单状态已保存/);
  assert.deepEqual(
    await Promise.all(scopes.map(async (scope) => (await store.getDailyState(dayKey, scope)).off_duty)),
    [[], [], []],
  );
});
