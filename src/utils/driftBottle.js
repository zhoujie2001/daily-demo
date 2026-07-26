export const DRIFT_BOTTLE_PHASES = Object.freeze({
  CLOSED: 'closed',
  SEA: 'sea',
  APPROACHING: 'approaching',
  UNCORKING: 'uncorking',
  EXTRACTING: 'extracting',
  UNFOLDING: 'unfolding',
  READING: 'reading',
  FOLDING: 'folding',
  INSERTING: 'inserting',
  CORKING: 'corking',
  THROWING: 'throwing',
  SPLASHING: 'splashing',
});

export const DRIFT_BOTTLE_ACTIONS = Object.freeze({
  OPEN: 'open',
  SELECT: 'select',
  APPROACH_COMPLETE: 'approach-complete',
  UNCORK_COMPLETE: 'uncork-complete',
  EXTRACT_COMPLETE: 'extract-complete',
  UNFOLD_COMPLETE: 'unfold-complete',
  RETURN: 'return',
  FOLD_COMPLETE: 'fold-complete',
  INSERT_COMPLETE: 'insert-complete',
  CORK_COMPLETE: 'cork-complete',
  THROW_COMPLETE: 'throw-complete',
  SPLASH_COMPLETE: 'splash-complete',
  CLOSE: 'close',
});

export const DRIFT_BOTTLE_SLOTS = Object.freeze([
  { id: 'bottle-1', x: 13, y: 67, scale: 0.94, rotate: -7, drift: 11, delay: 0.1, depth: 'mid' },
  { id: 'bottle-2', x: 31, y: 77, scale: 1.08, rotate: 6, drift: 15, delay: 0.65, depth: 'near' },
  { id: 'bottle-3', x: 50, y: 62, scale: 0.9, rotate: -3, drift: 10, delay: 0.35, depth: 'far' },
  { id: 'bottle-4', x: 70, y: 74, scale: 1.04, rotate: 8, drift: 14, delay: 0.9, depth: 'near' },
  { id: 'bottle-5', x: 88, y: 65, scale: 0.96, rotate: -6, drift: 12, delay: 0.5, depth: 'mid' },
]);

const SLOT_INDEXES_BY_COUNT = Object.freeze({
  0: [],
  1: [2],
  2: [1, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
});

function toId(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizePosts(posts) {
  const unique = new Map();

  (Array.isArray(posts) ? posts : []).forEach((post) => {
    const id = toId(post?.id);
    if (!id || unique.has(id)) return;
    unique.set(id, post);
  });

  return Array.from(unique.values());
}

function shuffled(items, random) {
  const result = items.slice();

  for (let index = result.length - 1; index > 0; index -= 1) {
    const raw = Number(random());
    const normalized = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0;
    const swapIndex = Math.floor(normalized * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

/**
 * 从完整 Daily 中抽取漂流瓶内容。
 * 未看过的内容始终优先；只有未读池不足时才会回收本次会话已经看过的内容。
 */
export function chooseDriftBottlePosts(posts, options = {}) {
  const {
    count = 5,
    currentId = null,
    seenIds = [],
    excludeIds = [],
    random = Math.random,
  } = options;

  const desiredCount = Math.max(0, Math.min(5, Math.floor(Number(count) || 0)));
  if (!desiredCount) return [];

  const blocked = new Set([toId(currentId), ...Array.from(excludeIds, toId)].filter(Boolean));
  const seen = new Set(Array.from(seenIds, toId).filter(Boolean));
  const eligible = normalizePosts(posts).filter((post) => !blocked.has(toId(post.id)));
  const unseen = shuffled(eligible.filter((post) => !seen.has(toId(post.id))), random);
  const recycled = shuffled(eligible.filter((post) => seen.has(toId(post.id))), random);

  return unseen.concat(recycled).slice(0, desiredCount);
}

export function assignDriftBottleSlots(posts) {
  const items = Array.isArray(posts) ? posts.slice(0, DRIFT_BOTTLE_SLOTS.length) : [];
  const slotIndexes = SLOT_INDEXES_BY_COUNT[items.length] || SLOT_INDEXES_BY_COUNT[5];

  return items.map((post, index) => ({
    ...DRIFT_BOTTLE_SLOTS[slotIndexes[index]],
    post,
  }));
}

export function createDriftBottleState(open = false) {
  return {
    phase: open ? DRIFT_BOTTLE_PHASES.SEA : DRIFT_BOTTLE_PHASES.CLOSED,
    selectedBottleId: null,
    selectedPost: null,
    lastReturnedBottleId: null,
  };
}

export function driftBottleReducer(state, action) {
  switch (action.type) {
    case DRIFT_BOTTLE_ACTIONS.OPEN:
      if (state.phase !== DRIFT_BOTTLE_PHASES.CLOSED) return state;
      return createDriftBottleState(true);

    case DRIFT_BOTTLE_ACTIONS.SELECT:
      if (
        state.phase !== DRIFT_BOTTLE_PHASES.SEA
        || !action.bottleId
        || !action.post
      ) {
        return state;
      }
      return {
        ...state,
        phase: DRIFT_BOTTLE_PHASES.APPROACHING,
        selectedBottleId: action.bottleId,
        selectedPost: action.post,
        lastReturnedBottleId: null,
      };

    case DRIFT_BOTTLE_ACTIONS.APPROACH_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.APPROACHING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.UNCORKING };

    case DRIFT_BOTTLE_ACTIONS.UNCORK_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.UNCORKING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.EXTRACTING };

    case DRIFT_BOTTLE_ACTIONS.EXTRACT_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.EXTRACTING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.UNFOLDING };

    case DRIFT_BOTTLE_ACTIONS.UNFOLD_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.UNFOLDING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.READING };

    case DRIFT_BOTTLE_ACTIONS.RETURN:
      if (state.phase !== DRIFT_BOTTLE_PHASES.READING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.FOLDING };

    case DRIFT_BOTTLE_ACTIONS.FOLD_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.FOLDING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.INSERTING };

    case DRIFT_BOTTLE_ACTIONS.INSERT_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.INSERTING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.CORKING };

    case DRIFT_BOTTLE_ACTIONS.CORK_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.CORKING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.THROWING };

    case DRIFT_BOTTLE_ACTIONS.THROW_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.THROWING) return state;
      return { ...state, phase: DRIFT_BOTTLE_PHASES.SPLASHING };

    case DRIFT_BOTTLE_ACTIONS.SPLASH_COMPLETE:
      if (state.phase !== DRIFT_BOTTLE_PHASES.SPLASHING) return state;
      return {
        phase: DRIFT_BOTTLE_PHASES.SEA,
        selectedBottleId: null,
        selectedPost: null,
        lastReturnedBottleId: state.selectedBottleId,
      };

    case DRIFT_BOTTLE_ACTIONS.CLOSE:
      return createDriftBottleState(false);

    default:
      return state;
  }
}

export function isDriftBottleBusy(phase) {
  return ![
    DRIFT_BOTTLE_PHASES.CLOSED,
    DRIFT_BOTTLE_PHASES.SEA,
    DRIFT_BOTTLE_PHASES.READING,
  ].includes(phase);
}
