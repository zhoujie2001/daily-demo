import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VIDEO_PET_ACTIONS,
  chooseVideoPetReaction,
  completeVideoPetAction,
  createVideoPetBehavior,
  createVideoPetController,
  requestVideoPetAction,
  requestVideoPetSleep,
  selectVideoPetAmbient,
} from '../src/components/pet/videoPetRuntime.js';

test('生产动作清单只保留同一形象的十段素材', () => {
  assert.deepEqual(Object.keys(VIDEO_PET_ACTIONS), [
    'blink',
    'look',
    'stretch',
    'lick',
    'tail',
    'happy',
    'annoyed',
    'observe',
    'sleep',
    'wake',
  ]);
  assert.ok(
    Object.values(VIDEO_PET_ACTIONS).every(
      (action) => action.src.startsWith('/videos/alisha/')
    )
  );
});

test('连续点击五次会进入防打扰反馈', () => {
  const state = createVideoPetBehavior({ now: 0, random: () => 0 });
  assert.equal(
    chooseVideoPetReaction({
      event: 'tap',
      count: 5,
      state,
      now: 100,
      random: () => 0,
    }),
    'annoyed'
  );
});

test('睡眠时忽略环境动作，直接互动先唤醒再执行', () => {
  let controller = createVideoPetController();
  let result = requestVideoPetSleep(controller, 100);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.command, {
    type: 'play',
    action: 'sleep',
  });
  controller = result.controller;

  result = requestVideoPetAction(controller, {
    action: 'blink',
    source: 'ambient',
    requestedAt: 200,
  });
  assert.equal(result.accepted, false);

  result = requestVideoPetAction(controller, {
    action: 'happy',
    source: 'direct',
    requestedAt: 300,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.command.action, 'wake');
  controller = result.controller;

  result = completeVideoPetAction(controller);
  assert.equal(result.command.action, 'happy');
});

test('环境选择包含安静概率且尊重最近动作', () => {
  const base = createVideoPetBehavior({ now: 0, random: () => 0 });
  const quiet = selectVideoPetAmbient({
    state: base,
    now: 20_000,
    random: () => 0.999,
  });
  assert.equal(quiet, null);

  const noBlink = selectVideoPetAmbient({
    state: {
      ...base,
      recentActions: ['blink'],
      nextAmbientAt: 0,
    },
    now: 20_000,
    random: () => 0,
  });
  assert.notEqual(noBlink, 'blink');
});
