export const CAT_PET_EVENT = Object.freeze({
  BLINK: 'blink',
  EAR_FLICK: 'ear-flick',
  LOOK_AROUND: 'look-around',
});

export const CAT_PET_REACTION = Object.freeze({
  HEAD_TILT: 'head-tilt',
  PAW: 'paw',
});

const IDLE_EVENT_RULES = Object.freeze({
  [CAT_PET_EVENT.BLINK]: { minDelay: 2800, maxDelay: 6400, duration: 260 },
  [CAT_PET_EVENT.EAR_FLICK]: { minDelay: 7200, maxDelay: 14800, duration: 520 },
  [CAT_PET_EVENT.LOOK_AROUND]: { minDelay: 9800, maxDelay: 18200, duration: 1700 },
});

export function randomBetween(min, max, random = Math.random) {
  const normalized = Math.min(1, Math.max(0, Number(random()) || 0));
  return min + (max - min) * normalized;
}

export function scheduleCatPetEvent(type, now, random = Math.random) {
  const rule = IDLE_EVENT_RULES[type];
  if (!rule) throw new Error(`Unknown cat pet event: ${type}`);

  return {
    type,
    startsAt: now + randomBetween(rule.minDelay, rule.maxDelay, random),
    duration: rule.duration,
  };
}

export function createCatPetSchedule(now = 0, random = Math.random) {
  return Object.fromEntries(
    Object.values(CAT_PET_EVENT).map((type) => [
      type,
      scheduleCatPetEvent(type, now, random),
    ])
  );
}

export function advanceCatPetSchedule(schedule, now, random = Math.random) {
  const next = { ...schedule };
  const active = {};

  Object.values(CAT_PET_EVENT).forEach((type) => {
    const event = next[type];
    const elapsed = now - event.startsAt;
    const progress = elapsed / event.duration;

    if (progress >= 0 && progress <= 1) {
      active[type] = progress;
    } else if (progress > 1) {
      next[type] = scheduleCatPetEvent(type, now, random);
    }
  });

  return { schedule: next, active };
}

export function reactionPose(type, progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  const arc = Math.sin(clamped * Math.PI);

  if (type === CAT_PET_REACTION.PAW) {
    return {
      headTilt: -0.08 * arc,
      pawLift: 0.46 * arc,
      bodyBounce: 0.06 * arc,
    };
  }

  return {
    headTilt: 0.22 * arc,
    pawLift: 0,
    bodyBounce: 0.035 * arc,
  };
}

export function chooseCatPetReaction(previous, random = Math.random) {
  if (previous === CAT_PET_REACTION.PAW) return CAT_PET_REACTION.HEAD_TILT;
  if (previous === CAT_PET_REACTION.HEAD_TILT) return CAT_PET_REACTION.PAW;
  return random() > 0.5 ? CAT_PET_REACTION.PAW : CAT_PET_REACTION.HEAD_TILT;
}

export function blinkAmount(progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.sin(clamped * Math.PI) ** 2;
}

export function easeInOutSine(progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  return -(Math.cos(Math.PI * clamped) - 1) / 2;
}
