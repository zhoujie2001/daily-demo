export const ALISHA_ACTION = Object.freeze({
  WELCOME: 'welcome',
  HAPPY_HOP: 'happy-hop',
  SPIN: 'spin',
  TAIL_SHAKE: 'tail-shake',
  ANNOYED: 'annoyed',
  YAWN: 'yawn',
  GROOM: 'groom',
  DAYDREAM: 'daydream',
  DAILY: 'section-daily',
  PHOTOGRAPHY: 'section-photography',
  TRAVEL: 'section-travel',
  STAR_GIFT: 'star-gift',
});

export const ALISHA_ACTION_PRIORITY = Object.freeze({
  [ALISHA_ACTION.YAWN]: 10,
  [ALISHA_ACTION.GROOM]: 10,
  [ALISHA_ACTION.DAYDREAM]: 10,
  [ALISHA_ACTION.DAILY]: 30,
  [ALISHA_ACTION.PHOTOGRAPHY]: 30,
  [ALISHA_ACTION.TRAVEL]: 30,
  [ALISHA_ACTION.STAR_GIFT]: 55,
  [ALISHA_ACTION.WELCOME]: 70,
  [ALISHA_ACTION.HAPPY_HOP]: 90,
  [ALISHA_ACTION.SPIN]: 90,
  [ALISHA_ACTION.TAIL_SHAKE]: 90,
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
  position: { right: 32, bottom: 32 },
  size: { desktop: 96, tablet: 84, mobile: 72 },
  behaviors: {
    welcome: true,
    idle: true,
    pointerGaze: true,
    clickReaction: true,
    annoyedReaction: true,
    sectionSync: true,
    easterEggs: true,
    autoAvoid: true,
  },
  timings: {
    welcomeMs: 4200,
    idleMinMs: 45000,
    idleMaxMs: 90000,
    rapidClickWindowMs: 2500,
    rapidClickCount: 4,
    annoyedCooldownMs: 300000,
    sectionDwellMs: 700,
    starActiveMs: 300000,
    activeGraceMs: 60000,
  },
  motion: {
    intensity: 'soft',
    mobileMode: 'lite',
    respectReducedMotion: true,
  },
  render: {
    chromaTolerance: 20,
  },
  sound: false,
});

const CLICK_REACTIONS = Object.freeze([
  ALISHA_ACTION.HAPPY_HOP,
  ALISHA_ACTION.SPIN,
  ALISHA_ACTION.TAIL_SHAKE,
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
  { windowMs = 2500, threshold = 4 } = {}
) {
  const recentClicks = [...previousClicks.filter((time) => now - time <= windowMs), now];
  return {
    clicks: recentClicks.length >= threshold ? [] : recentClicks,
    triggered: recentClicks.length >= threshold,
  };
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
