import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceCatPetSchedule,
  blinkAmount,
  CAT_PET_EVENT,
  CAT_PET_REACTION,
  chooseCatPetReaction,
  createCatPetSchedule,
  reactionPose,
  scheduleCatPetEvent,
} from '../src/utils/catPetBehavior.js';

test('随机待机事件始终安排在克制的时间范围内', () => {
  const earlyBlink = scheduleCatPetEvent(CAT_PET_EVENT.BLINK, 1000, () => 0);
  const lateBlink = scheduleCatPetEvent(CAT_PET_EVENT.BLINK, 1000, () => 1);
  const earlyEar = scheduleCatPetEvent(CAT_PET_EVENT.EAR_FLICK, 1000, () => 0);

  assert.equal(earlyBlink.startsAt, 3800);
  assert.equal(lateBlink.startsAt, 7400);
  assert.equal(earlyEar.startsAt, 8200);
});

test('事件进入持续时间后被激活，结束后自动安排下一次', () => {
  const schedule = createCatPetSchedule(0, () => 0);
  const blinking = advanceCatPetSchedule(schedule, 2900, () => 0.5);

  assert.ok(blinking.active[CAT_PET_EVENT.BLINK] > 0);
  assert.ok(blinking.active[CAT_PET_EVENT.BLINK] < 1);

  const rescheduled = advanceCatPetSchedule(blinking.schedule, 3200, () => 0);
  assert.equal(rescheduled.active[CAT_PET_EVENT.BLINK], undefined);
  assert.ok(rescheduled.schedule[CAT_PET_EVENT.BLINK].startsAt > 3200);
});

test('点击反应在歪头和抬爪之间轮换，避免连续重复', () => {
  assert.equal(
    chooseCatPetReaction(CAT_PET_REACTION.PAW),
    CAT_PET_REACTION.HEAD_TILT
  );
  assert.equal(
    chooseCatPetReaction(CAT_PET_REACTION.HEAD_TILT),
    CAT_PET_REACTION.PAW
  );
});

test('眨眼和点击姿态在动作中段达到峰值并平滑回到待机', () => {
  assert.equal(blinkAmount(0), 0);
  assert.equal(blinkAmount(0.5), 1);
  assert.ok(blinkAmount(1) < 1e-20);

  const pawMiddle = reactionPose(CAT_PET_REACTION.PAW, 0.5);
  const pawEnd = reactionPose(CAT_PET_REACTION.PAW, 1);
  assert.ok(pawMiddle.pawLift > 0.4);
  assert.ok(Math.abs(pawEnd.pawLift) < 1e-10);
});
