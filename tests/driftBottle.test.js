import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignDriftBottleSlots,
  chooseDriftBottlePosts,
  createDriftBottleState,
  DRIFT_BOTTLE_ACTIONS,
  DRIFT_BOTTLE_PHASES,
  driftBottleReducer,
  isDriftBottleBusy,
} from '../src/utils/driftBottle.js';

const posts = Array.from({ length: 8 }, (_, index) => ({
  id: `post-${index + 1}`,
  date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  text: `第 ${index + 1} 天`,
}));

function zeroRandom() {
  return 0;
}

test('抽取五篇互不重复的 Daily，并排除当前内容', () => {
  const selected = chooseDriftBottlePosts(posts, {
    count: 5,
    currentId: 'post-3',
    random: zeroRandom,
  });

  assert.equal(selected.length, 5);
  assert.equal(new Set(selected.map((post) => post.id)).size, 5);
  assert.equal(selected.some((post) => post.id === 'post-3'), false);
});

test('优先使用会话中尚未看过的 Daily，未读池不足时才回收', () => {
  const fresh = chooseDriftBottlePosts(posts, {
    count: 2,
    seenIds: ['post-1', 'post-2', 'post-3', 'post-4', 'post-5', 'post-6'],
    random: zeroRandom,
  });
  assert.deepEqual(
    new Set(fresh.map((post) => post.id)),
    new Set(['post-7', 'post-8'])
  );

  const recycled = chooseDriftBottlePosts(posts.slice(0, 3), {
    count: 3,
    seenIds: posts.slice(0, 3).map((post) => post.id),
    random: zeroRandom,
  });
  assert.equal(recycled.length, 3);
  assert.equal(new Set(recycled.map((post) => post.id)).size, 3);
});

test('补充单个瓶子时可以排除海面上其他瓶子的内容', () => {
  const selected = chooseDriftBottlePosts(posts, {
    count: 1,
    excludeIds: ['post-1', 'post-2', 'post-3', 'post-4'],
    random: zeroRandom,
  });

  assert.equal(selected.length, 1);
  assert.equal(['post-1', 'post-2', 'post-3', 'post-4'].includes(selected[0].id), false);
});

test('不足五篇时按实际数量居中分配海面位置', () => {
  const oneBottle = assignDriftBottleSlots(posts.slice(0, 1));
  const threeBottles = assignDriftBottleSlots(posts.slice(0, 3));

  assert.equal(oneBottle[0].x, 50);
  assert.deepEqual(threeBottles.map((bottle) => bottle.x), [13, 50, 88]);
});

test('动画状态机严格按取信、阅读、扔回顺序推进', () => {
  let state = createDriftBottleState(true);
  state = driftBottleReducer(state, {
    type: DRIFT_BOTTLE_ACTIONS.SELECT,
    bottleId: 'bottle-1',
    post: posts[0],
  });
  assert.equal(state.phase, DRIFT_BOTTLE_PHASES.APPROACHING);

  const actions = [
    DRIFT_BOTTLE_ACTIONS.APPROACH_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.UNCORK_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.EXTRACT_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.UNFOLD_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.RETURN,
    DRIFT_BOTTLE_ACTIONS.FOLD_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.INSERT_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.CORK_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.THROW_COMPLETE,
    DRIFT_BOTTLE_ACTIONS.SPLASH_COMPLETE,
  ];
  const expectedPhases = [
    DRIFT_BOTTLE_PHASES.UNCORKING,
    DRIFT_BOTTLE_PHASES.EXTRACTING,
    DRIFT_BOTTLE_PHASES.UNFOLDING,
    DRIFT_BOTTLE_PHASES.READING,
    DRIFT_BOTTLE_PHASES.FOLDING,
    DRIFT_BOTTLE_PHASES.INSERTING,
    DRIFT_BOTTLE_PHASES.CORKING,
    DRIFT_BOTTLE_PHASES.THROWING,
    DRIFT_BOTTLE_PHASES.SPLASHING,
    DRIFT_BOTTLE_PHASES.SEA,
  ];

  actions.forEach((type, index) => {
    state = driftBottleReducer(state, { type });
    assert.equal(state.phase, expectedPhases[index]);
  });

  assert.equal(state.lastReturnedBottleId, 'bottle-1');
  assert.equal(state.selectedPost, null);
});

test('动画期间忽略重复选择，关闭操作可以从任意阶段安全退出', () => {
  const sea = createDriftBottleState(true);
  const approaching = driftBottleReducer(sea, {
    type: DRIFT_BOTTLE_ACTIONS.SELECT,
    bottleId: 'bottle-2',
    post: posts[1],
  });
  const repeated = driftBottleReducer(approaching, {
    type: DRIFT_BOTTLE_ACTIONS.SELECT,
    bottleId: 'bottle-3',
    post: posts[2],
  });

  assert.strictEqual(repeated, approaching);
  assert.equal(isDriftBottleBusy(approaching.phase), true);
  assert.equal(isDriftBottleBusy(DRIFT_BOTTLE_PHASES.READING), false);

  const closed = driftBottleReducer(approaching, { type: DRIFT_BOTTLE_ACTIONS.CLOSE });
  assert.deepEqual(closed, createDriftBottleState(false));
});
