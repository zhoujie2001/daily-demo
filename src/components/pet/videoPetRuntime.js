export const VIDEO_PET_ACTIONS = Object.freeze({
  blink: {
    src: '/videos/alisha/v8_blink_rgb_alpha.webm',
    matteMode: 'packed-horizontal',
    label: '慢慢眨眼',
    speech: '眨眨眼，继续陪你。',
    kind: 'micro',
    weight: 18,
    cooldown: 8_000,
  },
  look: {
    src: '/videos/alisha/v8_look.mp4',
    label: '四处张望',
    speech: '刚才是不是有什么经过？',
    kind: 'micro',
    weight: 14,
    cooldown: 18_000,
  },
  stretch: {
    src: '/videos/alisha/v8_stretch.mp4',
    label: '伸懒腰',
    speech: '坐久了，也要活动一下。',
    kind: 'selfcare',
    weight: 5,
    cooldown: 60_000,
  },
  lick: {
    src: '/videos/alisha/v8_lick.mp4',
    label: '认真舔毛',
    speech: '等我把毛整理好。',
    kind: 'selfcare',
    weight: 6,
    cooldown: 40_000,
  },
  tail: {
    src: '/videos/alisha/v8_tail.mp4',
    label: '轻轻甩尾',
    speech: '尾巴有自己的想法。',
    kind: 'micro',
    weight: 12,
    cooldown: 20_000,
  },
  happy: {
    src: '/videos/alisha/state_happy.mp4',
    label: '被你逗开心',
    speech: '今天也很高兴见到你。',
    kind: 'emotion',
    weight: 0,
    cooldown: 12_000,
  },
  annoyed: {
    src: '/videos/alisha/state_annoyed.mp4',
    label: '假装不耐烦',
    speech: '……不要一直戳我啦。',
    kind: 'emotion',
    weight: 0,
    cooldown: 45_000,
  },
  observe: {
    src: '/videos/alisha/state_observe.mp4',
    label: '认真观察',
    speech: '我在看你做什么。',
    kind: 'emotion',
    weight: 3,
    cooldown: 24_000,
  },
  sleep: {
    src: '/videos/alisha/state_sleep.mp4',
    label: '安静睡着',
    speech: 'Z z z…',
    kind: 'sleep',
    weight: 0,
    cooldown: 0,
    loop: true,
  },
  wake: {
    src: '/videos/alisha/state_wake.mp4',
    label: '慢慢醒来',
    speech: '你回来啦。',
    kind: 'emotion',
    weight: 0,
    cooldown: 0,
  },
  walkLeft: {
    src: '/videos/alisha/walk_left_rgb_alpha.webm',
    matteMode: 'packed-horizontal',
    label: '向左散步',
    speech: '去左边看看。',
    kind: 'movement',
    weight: 2.8,
    cooldown: 45_000,
  },
  walkRight: {
    src: '/videos/alisha/walk_right_rgb_alpha.webm',
    matteMode: 'packed-horizontal',
    label: '向右散步',
    speech: '右边好像有点动静。',
    kind: 'movement',
    weight: 2.8,
    cooldown: 45_000,
  },
  walkForward: {
    src: '/videos/alisha/walk_forward_rgb_alpha.webm',
    matteMode: 'packed-horizontal',
    label: '走近一点',
    speech: '我过来陪你一会儿。',
    kind: 'movement',
    weight: 2.4,
    cooldown: 50_000,
  },
});

export const VIDEO_PET_CONFIG = Object.freeze({
  ambientDelay: { min: 5_000, max: 9_000 },
  sleepDelay: { min: 90_000, max: 150_000 },
  quietWeight: 24,
  mobileQuietWeight: 32,
  recentActionWindow: 2,
  majorActionLimit: 2,
  majorActionWindow: 60_000,
  postAnnoyedQuietTime: 6_000,
});

const AMBIENT_ACTIONS = Object.freeze(
  Object.keys(VIDEO_PET_ACTIONS).filter(
    (key) => VIDEO_PET_ACTIONS[key].weight > 0
  )
);

const CONTEXT_MULTIPLIERS = Object.freeze({
  about: {
    look: 1.25,
    observe: 1.2,
    walkLeft: 0.8,
    walkRight: 0.8,
    walkForward: 1.15,
  },
  daily: {
    look: 1.45,
    lick: 1.1,
    stretch: 0.7,
    walkLeft: 0.55,
    walkRight: 0.55,
    walkForward: 0.4,
  },
  reading: {
    blink: 1.65,
    look: 1.15,
    tail: 0.55,
    stretch: 0.55,
    walkLeft: 0.25,
    walkRight: 0.25,
    walkForward: 0.18,
  },
  travel: {
    look: 1.55,
    tail: 1.75,
    stretch: 1.2,
    observe: 1.25,
    walkLeft: 2.8,
    walkRight: 2.8,
    walkForward: 2.3,
  },
  photography: {
    look: 1.55,
    observe: 2.25,
    walkLeft: 0.45,
    walkRight: 0.45,
    walkForward: 0.55,
  },
  song: {
    tail: 2.4,
    blink: 1.15,
    walkLeft: 0.65,
    walkRight: 0.65,
    walkForward: 0.45,
  },
});

export const VIDEO_PET_PRIORITY = Object.freeze({
  ambient: 10,
  context: 20,
  direct: 50,
  urgent: 90,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function randomBetween(minimum, maximum, random = Math.random) {
  return minimum + (maximum - minimum) * random();
}

function weightedPick(entries, random = Math.random) {
  const usable = entries.filter((entry) => Number(entry.weight) > 0);
  const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
  if (!usable.length || total <= 0) return null;
  let cursor = random() * total;
  for (const entry of usable) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.value;
  }
  return usable.at(-1).value;
}

export function createVideoPetBehavior({
  now = 0,
  random = Math.random,
  affinity = 0,
  config = VIDEO_PET_CONFIG,
} = {}) {
  return {
    energy: 82,
    curiosity: 45,
    affinity: clamp(Number(affinity) || 0, 0, 100),
    annoyance: 0,
    lastDirectAt: now,
    sleepAt:
      now +
      randomBetween(config.sleepDelay.min, config.sleepDelay.max, random),
    nextAmbientAt:
      now +
      randomBetween(config.ambientDelay.min, config.ambientDelay.max, random),
    quietUntil: 0,
    lastPlayed: {},
    recentActions: [],
    majorActions: [],
  };
}

export function scheduleVideoPetAmbient(
  state,
  now,
  random = Math.random,
  config = VIDEO_PET_CONFIG
) {
  return {
    ...state,
    nextAmbientAt:
      now +
      randomBetween(config.ambientDelay.min, config.ambientDelay.max, random),
  };
}

export function registerVideoPetActivity(
  state,
  { type, now, random = Math.random, config = VIDEO_PET_CONFIG }
) {
  const direct = new Set(['tap', 'longpress', 'drop', 'keyboard']);
  const next = {
    ...state,
    curiosity: clamp(
      state.curiosity +
        (type === 'pointerNearby' ? 5 : type === 'scrollStop' ? 3 : 2),
      0,
      100
    ),
  };
  if (!direct.has(type)) return next;
  return {
    ...next,
    lastDirectAt: now,
    sleepAt:
      now +
      randomBetween(config.sleepDelay.min, config.sleepDelay.max, random),
  };
}

export function decayVideoPetBehavior(state, elapsedMs) {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  return {
    ...state,
    energy: clamp(state.energy - seconds * 0.012, 0, 100),
    curiosity: clamp(state.curiosity - seconds * 0.035, 20, 100),
    annoyance: clamp(state.annoyance - seconds * 3.5, 0, 100),
  };
}

function isCoolingDown(state, actionKey, now) {
  const last = state.lastPlayed[actionKey];
  if (last === undefined) return false;
  return now - last < (VIDEO_PET_ACTIONS[actionKey]?.cooldown ?? 0);
}

function reachedMajorLimit(state, now, config) {
  return (
    state.majorActions.filter(
      (timestamp) => now - timestamp <= config.majorActionWindow
    ).length >= config.majorActionLimit
  );
}

export function selectVideoPetAmbient({
  state,
  now,
  context = 'about',
  isMobile = false,
  hour = 12,
  random = Math.random,
  config = VIDEO_PET_CONFIG,
}) {
  if (now < state.quietUntil) return null;
  const recent = new Set(
    state.recentActions.slice(-config.recentActionWindow)
  );
  const majorLimited = reachedMajorLimit(state, now, config);
  const multipliers = CONTEXT_MULTIPLIERS[context] ?? {};
  const entries = AMBIENT_ACTIONS.flatMap((actionKey) => {
    const action = VIDEO_PET_ACTIONS[actionKey];
    if (
      recent.has(actionKey) ||
      isCoolingDown(state, actionKey, now) ||
      (majorLimited &&
        ['selfcare', 'movement'].includes(action.kind))
    ) {
      return [];
    }
    let weight = action.weight * (multipliers[actionKey] ?? 1);
    if (isMobile && action.kind === 'selfcare') weight *= 0.45;
    if (isMobile && action.kind === 'movement') weight *= 0.45;
    if ((hour >= 23 || hour < 7) && actionKey === 'blink') weight *= 1.35;
    if (
      (hour >= 23 || hour < 7) &&
      action.kind === 'movement'
    ) {
      weight *= 0.35;
    }
    if (state.energy < 35 && action.kind === 'selfcare') weight *= 0.6;
    if (state.energy < 35 && action.kind === 'movement') weight *= 0.25;
    return [{ value: actionKey, weight }];
  });
  entries.push({
    value: null,
    weight: isMobile ? config.mobileQuietWeight : config.quietWeight,
  });
  return weightedPick(entries, random);
}

function reactionPick(entries, state, now, random) {
  return weightedPick(
    entries.filter(
      ({ value }) =>
        value === null || !isCoolingDown(state, value, now)
    ),
    random
  );
}

export function chooseVideoPetReaction({
  event,
  state,
  now,
  count = 1,
  random = Math.random,
}) {
  if (event === 'tap') {
    if (count >= 5) {
      return reactionPick(
        [
          { value: 'annoyed', weight: 88 },
          { value: 'observe', weight: 12 },
        ],
        state,
        now,
        random
      );
    }
    if (count >= 2) {
      return reactionPick(
        [
          { value: 'happy', weight: 52 },
          { value: 'observe', weight: 28 },
          { value: 'tail', weight: 20 },
        ],
        state,
        now,
        random
      );
    }
    return reactionPick(
      [
        { value: 'happy', weight: 52 },
        { value: 'lick', weight: 20 },
        { value: 'observe', weight: 18 },
        { value: 'tail', weight: 10 },
      ],
      state,
      now,
      random
    );
  }
  if (event === 'proximity') {
    return reactionPick(
      [
        { value: 'observe', weight: 38 },
        { value: 'happy', weight: 14 },
        { value: null, weight: 48 },
      ],
      state,
      now,
      random
    );
  }
  if (event === 'longpress') {
    return reactionPick(
      [
        { value: 'happy', weight: 58 },
        { value: 'lick', weight: 30 },
        { value: 'tail', weight: 12 },
      ],
      state,
      now,
      random
    );
  }
  if (event === 'drop') {
    return reactionPick(
      [
        { value: 'look', weight: 48 },
        { value: 'tail', weight: 32 },
        { value: 'happy', weight: 20 },
      ],
      state,
      now,
      random
    );
  }
  if (event === 'scrollStop') {
    return reactionPick(
      [
        { value: null, weight: 78 },
        { value: 'look', weight: 14 },
        { value: 'observe', weight: 8 },
      ],
      state,
      now,
      random
    );
  }
  return null;
}

export function recordVideoPetAction(
  state,
  actionKey,
  now,
  config = VIDEO_PET_CONFIG
) {
  const action = VIDEO_PET_ACTIONS[actionKey];
  if (!action) return state;
  const recentActions = [...state.recentActions, actionKey].slice(-4);
  const majorActions = state.majorActions
    .filter((timestamp) => now - timestamp <= config.majorActionWindow)
    .concat(
      ['selfcare', 'movement'].includes(action.kind) ? now : []
    )
    .slice(-config.majorActionLimit);
  let energy = state.energy;
  let curiosity = state.curiosity;
  let affinity = state.affinity;
  let annoyance = state.annoyance;
  if (action.kind === 'selfcare') energy += 4;
  if (action.kind === 'movement') {
    energy -= 10;
    curiosity -= 4;
  }
  if (actionKey === 'happy') affinity += 1;
  if (actionKey === 'observe' || actionKey === 'look') curiosity -= 8;
  if (actionKey === 'annoyed') annoyance = 100;
  return {
    ...state,
    energy: clamp(energy, 0, 100),
    curiosity: clamp(curiosity, 0, 100),
    affinity: clamp(affinity, 0, 100),
    annoyance: clamp(annoyance, 0, 100),
    quietUntil:
      actionKey === 'annoyed'
        ? now + config.postAnnoyedQuietTime
        : state.quietUntil,
    lastPlayed: { ...state.lastPlayed, [actionKey]: now },
    recentActions,
    majorActions,
  };
}

export function shouldVideoPetSleep({ state, now, currentAction }) {
  return (
    now >= state.sleepAt &&
    !currentAction &&
    now >= state.quietUntil
  );
}

function normalizeRequest(request) {
  return {
    action: request.action,
    source: request.source ?? 'ambient',
    priority:
      request.priority ??
      VIDEO_PET_PRIORITY[request.source] ??
      VIDEO_PET_PRIORITY.ambient,
    requestedAt: request.requestedAt ?? 0,
  };
}

function dedupeQueue(queue, request) {
  return [
    ...queue.filter((item) => item.action !== request.action),
    request,
  ].sort((left, right) => right.priority - left.priority);
}

export function createVideoPetController() {
  return { current: null, queue: [] };
}

export function requestVideoPetAction(controller, rawRequest) {
  const request = normalizeRequest(rawRequest);
  if (!VIDEO_PET_ACTIONS[request.action]) {
    return { controller, command: null, accepted: false };
  }
  if (controller.current?.action === 'sleep') {
    if (request.action === 'sleep' || request.source === 'ambient') {
      return { controller, command: null, accepted: false };
    }
    const wake = normalizeRequest({
      action: 'wake',
      source: 'urgent',
      requestedAt: request.requestedAt,
    });
    return {
      controller: {
        current: wake,
        queue:
          request.action === 'wake'
            ? controller.queue
            : dedupeQueue(
                controller.queue.filter((item) => item.source !== 'ambient'),
                request
              ).slice(0, 3),
      },
      command: { type: 'play', action: 'wake' },
      accepted: true,
    };
  }
  if (!controller.current) {
    return {
      controller: { current: request, queue: controller.queue },
      command: { type: 'play', action: request.action },
      accepted: true,
    };
  }
  if (request.source === 'ambient') {
    return { controller, command: null, accepted: false };
  }
  let queue = controller.queue.filter((item) => item.source !== 'ambient');
  if (request.action === 'annoyed') queue = [];
  queue = dedupeQueue(queue, request).slice(0, 3);
  return {
    controller: { ...controller, queue },
    command: null,
    accepted: true,
  };
}

export function completeVideoPetAction(controller) {
  if (!controller.current) {
    return { controller, command: { type: 'base' } };
  }
  if (controller.current.action === 'sleep') {
    return { controller, command: null };
  }
  const [next, ...queue] = controller.queue;
  if (!next) {
    return {
      controller: { current: null, queue: [] },
      command: { type: 'base' },
    };
  }
  return {
    controller: { current: next, queue },
    command: { type: 'play', action: next.action },
  };
}

export function requestVideoPetSleep(controller, requestedAt) {
  if (controller.current || controller.queue.length) {
    return { controller, command: null, accepted: false };
  }
  const request = normalizeRequest({
    action: 'sleep',
    source: 'ambient',
    requestedAt,
  });
  return {
    controller: { current: request, queue: [] },
    command: { type: 'play', action: 'sleep' },
    accepted: true,
  };
}
