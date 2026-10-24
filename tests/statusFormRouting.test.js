import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

const dayKey = '2026-09-03';
const scopes = ['ad_review', 'ad_game', 'ad_emergency'];
const selections = { ad_review_off_duty: ['乙'], ad_game_off_duty: [], ad_emergency_off_duty: ['甲'] };

async function fixture() {
  const store = createMemoryBatchStore();
  const client = {
    calls: [],
    async replyInteractiveCard(args) { this.calls.push(args); return { message_id: 'om_status' }; },
    async replyMessage(args) { this.calls.push(args); return { message_id: 'om_audit' }; },
    async updateMessageCard() {},
  };
  const options = {
    store, client, config: { allowedChatIds: 'oc_allowed,oc_other' },
    logger: { info() {} }, now: () => new Date('2026-09-03T01:00:00Z'),
  };
  await store.initializeRoster({ dayKey, scope: 'ad_review', roster: ['甲', '乙'], expiresAt: '2026-09-04T00:00:00Z' });
  const states = await Promise.all(scopes.map((scope) => store.getDailyState(dayKey, scope)));
  await store.updateAdRosterStatuses({
    dayKey, confirmationOperationId: 'seed', submissionHash: 'seed', confirmedBy: 'ou_test',
    updates: states.map((state, index) => ({
      scope: state.scope, offDuty: index === 1 ? ['乙'] : ['甲'],
      expectedVersion: state.version, expectedRosterRevision: state.roster_revision,
    })),
  });
  const stats = { attempts: 0, writes: 0, completions: 0 };
  const update = store.updateAdRosterStatuses.bind(store);
  store.updateAdRosterStatuses = async (args) => {
    stats.attempts += 1;
    const result = await update(args);
    if (!result.replayed) stats.writes += 1;
    return result;
  };
  const complete = store.markPendingCompleted.bind(store);
  store.markPendingCompleted = async (...args) => { stats.completions += 1; return complete(...args); };
  await handleDispatchEvent({
    header: { event_id: 'open' },
    event: {
      operator: { open_id: 'ou_test' },
      action: { value: { action: 'bess_adjust_status', day_key: dayKey, business_type: 'AD', target_category: 'qianchuan_ad', dispatch_profile: 'ad' } },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_original' },
    },
  }, options);
  const form = client.calls[0].card.body.elements.find(({ tag }) => tag === 'form');
  const button = form.elements.find(({ name }) => name === 'adjust_status_submit');
  const value = structuredClone(button.value);
  const snapshot = () => Promise.all(scopes.map((scope) => store.getDailyState(dayKey, scope)));
  const getPending = () => store.getPending('om_status', options.now(), { includeCompleted: true });
  const changePending = async (change) => {
    const pending = await getPending();
    change(pending);
    await store.savePending(pending);
  };
  const body = (withValue = true, formValue = selections) => ({
    header: { event_id: 'submit' },
    event: {
      operator: { open_id: 'ou_test' },
      action: { tag: 'button', ...(withValue ? { value: structuredClone(value) } : {}), form_value: structuredClone(formValue) },
      context: { open_chat_id: 'oc_allowed', open_message_id: 'om_status' },
    },
  });
  return { store, client, options, stats, value, snapshot, changePending, getPending, body,
    submit: (payload) => handleDispatchEvent(payload, options) };
}

for (const withValue of [true, false]) {
  const route = withValue ? '真实按钮 value' : '仅 form_value';
  test(`${route}：保存、重复回调不重复增加版本`, async () => {
    const f = await fixture();
    const payload = f.body(withValue);
    const first = await f.submit(payload);
    assert.equal(first.errorCode, undefined);
    const saved = await f.snapshot();
    assert.deepEqual(saved.map((state) => state.off_duty), [['乙'], [], ['甲']]);
    assert.equal((await f.submit(payload)).errorCode, 'FORM_ALREADY_PROCESSED');
    assert.deepEqual(await f.snapshot(), saved);
    assert.equal(f.stats.writes, 1);
  });

  for (const field of Object.keys(selections)) {
    test(`${route}：缺少 ${field} 时零状态写入`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      const payload = f.body(withValue);
      delete payload.event.action.form_value[field];
      assert.equal((await f.submit(payload)).errorCode, 'AD_STATUS_FORM_PROTOCOL_EXPIRED');
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.stats.attempts, 0);
      assert.equal(f.stats.completions, 0);
    });
  }

  for (const invalid of [null, '甲', {}]) {
    test(`${route}：拒绝非数组字段 ${JSON.stringify(invalid)}`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      const payload = f.body(withValue);
      payload.event.action.form_value.ad_game_off_duty = invalid;
      assert.equal((await f.submit(payload)).errorCode, 'AD_STATUS_FORM_PROTOCOL_EXPIRED');
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.stats.attempts, 0);
    });
  }

  test(`${route}：旧协议被拒绝且原离岗人员保留`, async () => {
    const f = await fixture();
    await f.changePending(({ request_context: context }) => {
      delete context.statusFormProtocolVersion;
      delete context.expectedAdStates;
    });
    const before = await f.snapshot();
    assert.equal((await f.submit(f.body(withValue, { range: 'current', target_name: '乙', op_type: 'leave' }))).errorCode,
      'AD_STATUS_FORM_PROTOCOL_EXPIRED');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.stats.attempts, 0);
  });

  test(`${route}：跨群和完成后的跨群回调均拒绝`, async () => {
    const f = await fixture();
    const wrongChat = f.body(withValue);
    wrongChat.event.context.open_chat_id = 'oc_other';
    assert.equal((await f.submit(wrongChat)).errorCode, 'PENDING_CHAT_MISMATCH');
    assert.equal(f.stats.attempts, 0);
    await f.submit(f.body(withValue));
    const saved = await f.snapshot();
    assert.equal((await f.submit(wrongChat)).errorCode, 'PENDING_CHAT_MISMATCH');
    assert.deepEqual(await f.snapshot(), saved);
    assert.equal(f.stats.writes, 1);
  });

  for (const invalidContext of ['day', 'scope', 'expiry']) {
    test(`${route}：拒绝 ${invalidContext} 不匹配的服务端表单`, async () => {
      const f = await fixture();
      await f.changePending((pending) => {
        if (invalidContext === 'day') pending.request_context.dayKey = '2026-09-02';
        if (invalidContext === 'scope') pending.request_context.dispatchScope = 'ad_game';
        if (invalidContext === 'expiry') pending.expires_at = '2026-09-03T00:00:00Z';
      });
      const before = await f.snapshot();
      const result = await f.submit(f.body(withValue));
      assert.ok(['STATUS_FORM_EXPIRED', 'STATUS_FORM_SCOPE_MISMATCH', 'PENDING_FORM_NOT_FOUND'].includes(result.errorCode));
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.stats.attempts, 0);
    });
  }
}

for (const missing of ['snapshot', 'operation']) {
  test(`真实按钮：缺少服务端 ${missing} 不能用公开字段或当前版本替代`, async () => {
    const f = await fixture();
    await f.changePending(({ request_context: context }) => {
      if (missing === 'snapshot') delete context.expectedAdStates.ad_game;
      else delete context.confirmationOperationId;
    });
    const before = await f.snapshot();
    const payload = f.body();
    Object.assign(payload.event.action.value, { expectedAdStates: Object.fromEntries((await f.snapshot()).map((s) => [s.scope, { version: s.version, rosterRevision: s.roster_revision }])), confirmationOperationId: 'forged' });
    assert.equal((await f.submit(payload)).errorCode, 'AD_STATUS_FORM_PROTOCOL_EXPIRED');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.stats.attempts, 0);
  });
}

for (const binding of ['day', 'scope', 'message', 'missingPending']) {
  test(`真实按钮：公开 ${binding} 不能替换实际表单绑定`, async () => {
    const f = await fixture();
    const payload = f.body();
    if (binding === 'day') payload.event.action.value.day_key = '2026-09-02';
    if (binding === 'scope') payload.event.action.value.target_category = 'game_agent';
    if (binding === 'message') {
      const pending = await f.getPending();
      f.store.getPending = async () => ({ ...pending, form_message_id: 'wrong-message' });
    }
    if (binding === 'missingPending') payload.event.context.open_message_id = 'om_unknown';
    const before = await f.snapshot();
    const result = await f.submit(payload);
    assert.ok(['STATUS_FORM_DAY_MISMATCH', 'STATUS_FORM_SCOPE_MISMATCH', 'PENDING_FORM_MISMATCH', 'PENDING_FORM_NOT_FOUND'].includes(result.errorCode));
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.stats.attempts, 0);
  });
}

test('真实按钮：CAS 冲突保留并发更新，公开版本伪造无效', async () => {
  const f = await fixture();
  const states = await f.snapshot();
  await f.store.updateAdRosterStatuses({
    dayKey, confirmationOperationId: 'concurrent', submissionHash: 'concurrent', confirmedBy: 'ou_other',
    updates: states.map((state) => ({ scope: state.scope, offDuty: [], expectedVersion: state.version, expectedRosterRevision: state.roster_revision })),
  });
  const before = await f.snapshot();
  const payload = f.body();
  payload.event.action.value.expectedAdStates = Object.fromEntries(before.map((state) => [state.scope, { version: state.version, rosterRevision: state.roster_revision }]));
  assert.equal((await f.submit(payload)).errorCode, 'STATUS_UPDATE_CONFLICT');
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.stats.writes, 1);
});

test('真实按钮：完成标记丢失后同操作幂等重放，变更载荷被拒绝', async () => {
  const f = await fixture();
  f.store.markPendingCompleted = async () => { throw new Error('injected completion receipt loss'); };
  const payload = f.body();
  assert.equal((await f.submit(payload)).errorCode, undefined);
  const saved = await f.snapshot();
  assert.equal((await f.submit(payload)).errorCode, undefined);
  assert.deepEqual(await f.snapshot(), saved);
  assert.equal(f.stats.writes, 1);
  payload.event.action.form_value.ad_review_off_duty = [];
  assert.equal((await f.submit(payload)).errorCode, 'CONFIRMATION_OPERATION_MISMATCH');
  assert.deepEqual(await f.snapshot(), saved);
});

test('真实按钮：JSON 字符串回调及显式三个空数组均可提交', async () => {
  const f = await fixture();
  const payload = f.body(true, { ad_review_off_duty: [], ad_game_off_duty: [], ad_emergency_off_duty: [] });
  payload.event.action.value = JSON.stringify(payload.event.action.value);
  payload.event.action.form_value = JSON.stringify(payload.event.action.form_value);
  assert.equal((await f.submit(payload)).errorCode, undefined);
  assert.deepEqual((await f.snapshot()).map((state) => state.off_duty), [[], [], []]);
  assert.equal(f.stats.writes, 1);
});
