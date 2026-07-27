import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALISHA_ACTION,
  ALISHA_STATE,
  DEFAULT_ALISHA_CONFIG,
  deriveAlishaState,
  enqueueAlishaAction,
  mergeAlishaConfig,
  pickClickReaction,
  pickIdleAction,
  recordRapidClick,
  shouldCountActiveTime,
  updateVisitStreak,
} from '../src/utils/alishaBehavior.js';

test('运行时配置只覆盖给定字段，其余安全回退到默认值', () => {
  const merged = mergeAlishaConfig(DEFAULT_ALISHA_CONFIG, {
    position: { right: 44 },
    behaviors: { idle: false },
  });

  assert.equal(merged.position.right, 44);
  assert.equal(merged.position.bottom, 20);
  assert.equal(merged.behaviors.idle, false);
  assert.equal(merged.behaviors.pointerGaze, true);
  assert.equal(merged.timings.idleSleepMs, 180000);
});

test('点击反应不会连续重复', () => {
  assert.notEqual(
    pickClickReaction(ALISHA_ACTION.HAPPY_HOP, () => 0),
    ALISHA_ACTION.HAPPY_HOP
  );
  assert.notEqual(
    pickClickReaction(ALISHA_ACTION.PAW, () => 0.99),
    ALISHA_ACTION.PAW
  );
});

test('主体动作按优先级排队且同一动作不会重复入队', () => {
  const queue = enqueueAlishaAction(
    [{ name: ALISHA_ACTION.YAWN, priority: 10 }],
    { name: ALISHA_ACTION.ANNOYED, priority: 100 }
  );
  const deduplicated = enqueueAlishaAction(
    queue,
    { name: ALISHA_ACTION.YAWN, priority: 10 }
  );

  assert.deepEqual(
    queue.map((item) => item.name),
    [ALISHA_ACTION.ANNOYED, ALISHA_ACTION.YAWN]
  );
  assert.equal(deduplicated.length, 2);
});

test('状态由睡眠、主体动作与观察关系稳定推导', () => {
  assert.equal(
    deriveAlishaState({ sleeping: true, observing: true, action: null }),
    ALISHA_STATE.SLEEP
  );
  assert.equal(
    deriveAlishaState({
      sleeping: false,
      observing: false,
      action: ALISHA_ACTION.ANNOYED,
    }),
    ALISHA_STATE.ANNOYED
  );
  assert.equal(
    deriveAlishaState({ sleeping: false, observing: true, action: null }),
    ALISHA_STATE.OBSERVE
  );
});

test('连续四次点击在窗口内触发生气，过期点击会被丢弃', () => {
  let state = recordRapidClick([], 1000, { windowMs: 2500, threshold: 4 });
  state = recordRapidClick(state.clicks, 1500, { windowMs: 2500, threshold: 4 });
  state = recordRapidClick(state.clicks, 2000, { windowMs: 2500, threshold: 4 });
  state = recordRapidClick(state.clicks, 2500, { windowMs: 2500, threshold: 4 });
  assert.equal(state.triggered, true);
  assert.deepEqual(state.clicks, []);

  const expired = recordRapidClick([1000, 1200], 5000, {
    windowMs: 2500,
    threshold: 4,
  });
  assert.deepEqual(expired.clicks, [5000]);
  assert.equal(expired.triggered, false);
});

test('待机动作避免连续重复', () => {
  assert.notEqual(
    pickIdleAction(ALISHA_ACTION.YAWN, () => 0),
    ALISHA_ACTION.YAWN
  );
  assert.notEqual(
    pickIdleAction(ALISHA_ACTION.DAYDREAM, () => 0.99),
    ALISHA_ACTION.DAYDREAM
  );
});

test('连续访问按本地日期累加，断签后重新从一天开始', () => {
  assert.deepEqual(updateVisitStreak(null, '2026-07-20'), {
    lastDate: '2026-07-20',
    streak: 1,
  });
  assert.deepEqual(
    updateVisitStreak({ lastDate: '2026-07-20', streak: 6 }, '2026-07-21'),
    { lastDate: '2026-07-21', streak: 7 }
  );
  assert.deepEqual(
    updateVisitStreak({ lastDate: '2026-07-20', streak: 6 }, '2026-07-23'),
    { lastDate: '2026-07-23', streak: 1 }
  );
});

test('五分钟彩蛋只累计可见且仍在活跃窗口内的时间', () => {
  assert.equal(
    shouldCountActiveTime({
      visible: true,
      now: 50000,
      lastActivityAt: 10000,
      activeGraceMs: 60000,
    }),
    true
  );
  assert.equal(
    shouldCountActiveTime({
      visible: false,
      now: 50000,
      lastActivityAt: 10000,
      activeGraceMs: 60000,
    }),
    false
  );
  assert.equal(
    shouldCountActiveTime({
      visible: true,
      now: 80000,
      lastActivityAt: 10000,
      activeGraceMs: 60000,
    }),
    false
  );
});
