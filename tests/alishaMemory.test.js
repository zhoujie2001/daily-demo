import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmptyAlishaMemoryProfile,
  mergeAlishaMemoryProfiles,
  normalizeCloudRecommendation,
  recordAlishaDelivery,
  selectAlishaMemory,
  updateAlishaDeliveryAction,
} from '../src/utils/alishaMemory.js';

const NOW = new Date('2026-08-18T10:00:00+08:00');

function post(id, date, text, media = []) {
  return { id, date, text, media, tags: [] };
}

test('同一天不同年份优先于普通旧日记', () => {
  const profile = createEmptyAlishaMemoryProfile('visitor-1', NOW);
  const selected = selectAlishaMemory({
    posts: [
      post('ordinary', 'Jan 05, 2024', '普通的一天', [{ type: 'image' }]),
      post('anniversary', 'Aug 18, 2025', '去年今天的一场雨'),
    ],
    profile,
    now: NOW,
  });

  assert.equal(selected.contentId, 'anniversary');
  assert.equal(selected.reason, '同一天，不同年份');
});

test('每天最多出现一次记忆', () => {
  let profile = createEmptyAlishaMemoryProfile('visitor-1', NOW);
  profile = recordAlishaDelivery(profile, 'old-day', 'delivered', NOW);
  const selected = selectAlishaMemory({
    posts: [post('another-day', 'Jun 02, 2024', '另一段旧日记')],
    profile,
    now: NOW,
  });
  assert.equal(selected, null);
});

test('最近三十天展示过的内容不会重复出现', () => {
  let profile = createEmptyAlishaMemoryProfile('visitor-1', NOW);
  profile = recordAlishaDelivery(
    profile,
    'recently-shown',
    'delivered',
    new Date('2026-08-17T10:00:00+08:00')
  );
  const selected = selectAlishaMemory({
    posts: [
      post('recently-shown', 'Mar 01, 2024', '刚刚展示过'),
      post('fresh-choice', 'Apr 01, 2024', '还没有展示过'),
    ],
    profile,
    now: NOW,
  });
  assert.equal(selected.contentId, 'fresh-choice');
});

test('打开或忽略会更新对应投递记录', () => {
  let profile = createEmptyAlishaMemoryProfile('visitor-1', NOW);
  profile = recordAlishaDelivery(profile, 'memory-1', 'delivered', NOW);
  profile = updateAlishaDeliveryAction(profile, 'memory-1', 'opened');
  assert.equal(profile.deliveries[0].action, 'opened');
});

test('云端推荐只能引用当前公开内容列表中的日记', () => {
  const posts = [post('post-7', 'May 03, 2025', '五月的风')];
  assert.equal(
    normalizeCloudRecommendation({ contentId: 'private-9' }, posts),
    null
  );
  assert.equal(
    normalizeCloudRecommendation({ contentId: 'post-7', reason: '同一座城市' }, posts).reason,
    '同一座城市'
  );
});

test('云端档案同步不会抹掉本机当天已经展示的记忆', () => {
  const local = recordAlishaDelivery(
    createEmptyAlishaMemoryProfile('visitor-1', NOW),
    'memory-local',
    'dismissed',
    NOW
  );
  const remote = {
    ...createEmptyAlishaMemoryProfile('visitor-1', new Date('2026-08-10T10:00:00+08:00')),
    sectionVisits: { daily: 8 },
  };
  const merged = mergeAlishaMemoryProfiles(local, remote, 'visitor-1');
  assert.equal(merged.deliveries[0].memoryId, 'memory-local');
  assert.equal(merged.sectionVisits.daily, 8);
});
