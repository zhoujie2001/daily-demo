export const ALISHA_STATE = Object.freeze({
  IDLE: 'idle',
  OBSERVE: 'observe',
  HAPPY: 'happy',
  ANNOYED: 'annoyed',
  SLEEP: 'sleep',
  WAKE: 'wake',
});

export const ALISHA_ACTION = Object.freeze({
  WELCOME: 'welcome',
  HAPPY_HOP: 'happy-hop',
  HEAD_TILT: 'head-tilt',
  PAW: 'paw',
  PETTING: 'petting',
  EAR_LEFT: 'ear-left',
  EAR_RIGHT: 'ear-right',
  TAIL_TOUCHED: 'tail-touched',
  ANNOYED: 'annoyed',
  YAWN: 'yawn',
  GROOM: 'groom',
  DAYDREAM: 'daydream',
  WAKE: 'wake',
  DAILY: 'section-daily',
  PHOTOGRAPHY: 'section-photography',
  TRAVEL: 'section-travel',
  STAR_GIFT: 'star-gift',
});

export const ALISHA_ACTION_PRIORITY = Object.freeze({
  [ALISHA_ACTION.YAWN]: 10,
  [ALISHA_ACTION.GROOM]: 10,
  [ALISHA_ACTION.DAYDREAM]: 10,
  [ALISHA_ACTION.DAILY]: 25,
  [ALISHA_ACTION.PHOTOGRAPHY]: 25,
  [ALISHA_ACTION.TRAVEL]: 25,
  [ALISHA_ACTION.WAKE]: 70,
  [ALISHA_ACTION.WELCOME]: 70,
  [ALISHA_ACTION.STAR_GIFT]: 75,
  [ALISHA_ACTION.HEAD_TILT]: 85,
  [ALISHA_ACTION.PAW]: 85,
  [ALISHA_ACTION.HAPPY_HOP]: 85,
  [ALISHA_ACTION.PETTING]: 90,
  [ALISHA_ACTION.EAR_LEFT]: 90,
  [ALISHA_ACTION.EAR_RIGHT]: 90,
  [ALISHA_ACTION.TAIL_TOUCHED]: 92,
  [ALISHA_ACTION.ANNOYED]: 100,
});

export const SECTION_ACTIONS = Object.freeze({
  daily: ALISHA_ACTION.DAILY,
  photography: ALISHA_ACTION.PHOTOGRAPHY,
  travel: ALISHA_ACTION.TRAVEL,
});

export const DEFAULT_ALISHA_CONFIG = Object.freeze({
  enabled: true,
  name: '阿丽莎',
  position: { right: 24, bottom: 20 },
  size: { desktop: 248, tablet: 184, mobile: 124 },
  behaviors: {
    welcome: true,
    idle: true,
    sleep: true,
    pointerGaze: true,
    clickReaction: true,
    annoyedReaction: true,
    sectionSync: true,
    easterEggs: true,
    autoAvoid: true,
    controls: true,
  },
  timings: {
    welcomeMs: 3200,
    blinkMinMs: 4000,
    blinkMaxMs: 9000,
    earMinMs: 12000,
    earMaxMs: 30000,
    tailMinMs: 9000,
    tailMaxMs: 18000,
    idleMinMs: 30000,
    idleMaxMs: 65000,
    idleSleepMs: 180000,
    complexCooldownMs: 20000,
    rapidClickWindowMs: 3000,
    rapidClickCount: 4,
    annoyedCooldownMs: 8000,
    sectionDwellMs: 850,
    starActiveMs: 300000,
    activeGraceMs: 60000,
    petHoldMs: 500,
  },
  motion: {
    intensity: 'soft',
    mobileMode: 'lite',
    respectReducedMotion: true,
  },
  sound: false,
});

const CLICK_REACTIONS = Object.freeze([
  ALISHA_ACTION.HEAD_TILT,
  ALISHA_ACTION.PAW,
  ALISHA_ACTION.HAPPY_HOP,
]);

const IDLE_ACTIONS = Object.freeze([
  ALISHA_ACTION.YAWN,
  ALISHA_ACTION.GROOM,
  ALISHA_ACTION.DAYDREAM,
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergeAlishaConfig(base, override) {
  if (!isPlainObject(override)) return { ...base };

  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => {
      const nextValue = override[key];
      if (isPlainObject(value)) {
        return [key, mergeAlishaConfig(value, nextValue)];
      }
      return [key, nextValue === undefined ? value : nextValue];
    })
  );
}

export function randomBetween(min, max, random = Math.random) {
  const normalized = Math.min(1, Math.max(0, Number(random()) || 0));
  return min + (max - min) * normalized;
}

export function pickClickReaction(previous, random = Math.random) {
  const candidates = CLICK_REACTIONS.filter((action) => action !== previous);
  const index = Math.min(
    candidates.length - 1,
    Math.floor(randomBetween(0, candidates.length, random))
  );
  return candidates[Math.max(0, index)];
}

export function pickIdleAction(previous, random = Math.random) {
  const candidates = IDLE_ACTIONS.filter((action) => action !== previous);
  const index = Math.min(
    candidates.length - 1,
    Math.floor(randomBetween(0, candidates.length, random))
  );
  return candidates[Math.max(0, index)];
}

export function recordRapidClick(
  previousClicks,
  now,
  { windowMs = 3000, threshold = 4 } = {}
) {
  const recentClicks = [...previousClicks.filter((time) => now - time <= windowMs), now];
  return {
    clicks: recentClicks.length >= threshold ? [] : recentClicks,
    triggered: recentClicks.length >= threshold,
  };
}

export function enqueueAlishaAction(queue, action, maxLength = 5) {
  const normalizedQueue = Array.isArray(queue) ? queue : [];
  if (!action?.name) return normalizedQueue.slice();
  if (normalizedQueue.some((item) => item.name === action.name)) {
    return normalizedQueue.slice();
  }

  return [...normalizedQueue, action]
    .sort((left, right) => (right.priority || 0) - (left.priority || 0))
    .slice(0, Math.max(1, maxLength));
}

export function deriveAlishaState({ sleeping, observing, action }) {
  if (sleeping) return ALISHA_STATE.SLEEP;
  if (action === ALISHA_ACTION.WAKE) return ALISHA_STATE.WAKE;
  if (action === ALISHA_ACTION.ANNOYED) return ALISHA_STATE.ANNOYED;
  if (
    action === ALISHA_ACTION.PETTING ||
    action === ALISHA_ACTION.HAPPY_HOP ||
    action === ALISHA_ACTION.PAW
  ) {
    return ALISHA_STATE.HAPPY;
  }
  if (observing) return ALISHA_STATE.OBSERVE;
  return ALISHA_STATE.IDLE;
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateKeyToUtc(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Date.UTC(year, month - 1, day);
}

export function updateVisitStreak(previous, today = localDateKey()) {
  if (!previous?.lastDate) return { lastDate: today, streak: 1 };
  if (previous.lastDate === today) {
    return {
      lastDate: today,
      streak: Math.max(1, Number(previous.streak) || 1),
    };
  }

  const dayGap = Math.round(
    (dateKeyToUtc(today) - dateKeyToUtc(previous.lastDate)) / 86400000
  );
  return {
    lastDate: today,
    streak: dayGap === 1 ? Math.max(1, Number(previous.streak) || 1) + 1 : 1,
  };
}

export function shouldCountActiveTime({
  visible,
  now,
  lastActivityAt,
  activeGraceMs = 60000,
}) {
  return Boolean(visible) && now - lastActivityAt <= activeGraceMs;
}
