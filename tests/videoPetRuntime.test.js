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
  recordVideoPetAction,
  selectVideoPetAmbient,
} from '../src/components/pet/videoPetRuntime.js';

test('生产动作清单包含原有动作和三段行走素材', () => {
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
    'walkLeft',
    'walkRight',
    'walkForward',
  ]);
  assert.ok(
    Object.values(VIDEO_PET_ACTIONS).every(
      (action) => action.src.startsWith('/videos/alisha/')
    )
  );
  for (const actionKey of ['walkLeft', 'walkRight', 'walkForward']) {
    assert.equal(VIDEO_PET_ACTIONS[actionKey].kind, 'movement');
    assert.equal(
      VIDEO_PET_ACTIONS[actionKey].matteMode,
      'packed-horizontal'
    );
  }
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

test('移动动作会消耗精力并受每分钟主要动作上限保护', () => {
  const now = 80_000;
  const base = createVideoPetBehavior({ now: 0, random: () => 0 });
  const afterWalk = recordVideoPetAction(base, 'walkLeft', now);

  assert.equal(afterWalk.energy, 72);
  assert.equal(afterWalk.curiosity, 41);
  assert.deepEqual(afterWalk.majorActions, [now]);

  const cooling = Object.fromEntries(
    Object.keys(VIDEO_PET_ACTIONS)
      .filter(
        (key) =>
          VIDEO_PET_ACTIONS[key].weight > 0 &&
          VIDEO_PET_ACTIONS[key].kind !== 'movement'
      )
      .map((key) => [key, now])
  );
  const majorLimited = {
    ...base,
    lastPlayed: cooling,
    majorActions: [now - 2_000, now - 1_000],
  };

  assert.equal(
    selectVideoPetAmbient({
      state: majorLimited,
      now,
      context: 'travel',
      random: () => 0,
    }),
    null
  );
});
