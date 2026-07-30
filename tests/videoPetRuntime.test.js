import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VIDEO_PET_ACTIONS,
  chooseVideoPetReaction,
  completeVideoPetAction,
  createVideoPetBehavior,
  createVideoPetController,
  createVideoPetRuntimeConfig,
  registerVideoPetActivity,
  requestVideoPetAction,
  requestVideoPetSleep,
  recordVideoPetAction,
  resolveVideoPetSpeech,
  selectVideoPetAmbient,
  shouldVideoPetSleep,
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
    canWake: true,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.command.action, 'wake');
  controller = result.controller;

  result = completeVideoPetAction(controller);
  assert.equal(result.command.action, 'happy');
});

test('睡眠只允许明确的桌面靠近或移动端点击互动唤醒', () => {
  let controller = requestVideoPetSleep(
    createVideoPetController(),
    100
  ).controller;

  let result = requestVideoPetAction(controller, {
    action: 'observe',
    source: 'context',
    requestedAt: 200,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.command, null);

  result = requestVideoPetAction(controller, {
    action: 'wake',
    source: 'direct',
    requestedAt: 300,
    canWake: true,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.command.action, 'wake');
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

test('运行时采用三秒动作节拍和三十秒无互动睡眠', () => {
  const config = createVideoPetRuntimeConfig({
    petActionIntervalMs: 3_000,
    sleepAfterMs: 30_000,
  });
  const base = createVideoPetBehavior({
    now: 1_000,
    random: () => 0.5,
    config,
  });

  assert.equal(base.nextAmbientAt, 4_000);
  assert.equal(base.sleepAt, 31_000);
  assert.equal(
    shouldVideoPetSleep({
      state: base,
      now: 31_000,
      currentAction: 'walkLeft',
    }),
    true
  );

  const nearby = registerVideoPetActivity(base, {
    type: 'pointerNearby',
    now: 20_000,
    random: () => 0.5,
    config,
  });
  assert.equal(nearby.sleepAt, 50_000);

  const scrolled = registerVideoPetActivity(nearby, {
    type: 'scrollStop',
    now: 25_000,
    config,
  });
  assert.equal(scrolled.sleepAt, 50_000);
});

test('强制睡眠会停止当前动作并清空等待队列', () => {
  let controller = requestVideoPetAction(
    createVideoPetController(),
    {
      action: 'walkForward',
      source: 'ambient',
      requestedAt: 1_000,
    }
  ).controller;

  const result = requestVideoPetSleep(controller, 31_000, {
    force: true,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.command.action, 'sleep');
  assert.equal(result.controller.current.action, 'sleep');
  assert.deepEqual(result.controller.queue, []);
});

test('环境动作文字限频且低概率，直接互动始终得到简短反馈', () => {
  const config = createVideoPetRuntimeConfig({
    speechCooldownMs: 12_000,
    ambientSpeechChance: 0.14,
    contextSpeechChance: 0.32,
  });

  assert.equal(
    resolveVideoPetSpeech({
      actionKey: 'blink',
      source: 'ambient',
      now: 5_000,
      random: () => 0.9,
      config,
    }),
    null
  );
  assert.equal(
    resolveVideoPetSpeech({
      actionKey: 'look',
      source: 'ambient',
      now: 10_000,
      lastSpokenAt: 5_000,
      random: () => 0,
      config,
    }),
    null
  );

  const direct = resolveVideoPetSpeech({
    actionKey: 'happy',
    source: 'direct',
    now: 10_000,
    lastSpokenAt: 9_900,
    random: () => 0.99,
    config,
  });
  assert.equal(direct.message, '好呀。');
  assert.equal(direct.tone, 'direct');
  assert.equal(
    resolveVideoPetSpeech({
      actionKey: 'sleep',
      source: 'ambient',
      now: 40_000,
      random: () => 0,
      config,
    }),
    null
  );
});
