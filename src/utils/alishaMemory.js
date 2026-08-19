const DAY_MS = 86_400_000;

export const ALISHA_MEMORY_VERSION = 1;
export const ALISHA_MEMORY_STORAGE_KEY = 'daily-demo-alisha-memory-v1';
export const ALISHA_VISITOR_STORAGE_KEY = 'daily-demo-alisha-visitor-v1';

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toLocalDayKey(value = new Date()) {
  const date = safeDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function stableNoise(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function excerptFromPost(post) {
  const text = String(post?.text || post?.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '那天留下了一些影像，阿丽莎想带你再看一眼。';
  return text.length > 74 ? `${text.slice(0, 74).trim()}…` : text;
}

export function createEmptyAlishaMemoryProfile(visitorId, now = new Date()) {
  const timestamp = safeDate(now)?.toISOString() || new Date().toISOString();
  return {
    version: ALISHA_MEMORY_VERSION,
    visitorId,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    visitDays: [toLocalDayKey(now)],
    sectionVisits: {},
    deliveries: [],
  };
}

export function normalizeAlishaMemoryProfile(value, visitorId, now = new Date()) {
  const fallback = createEmptyAlishaMemoryProfile(visitorId, now);
  if (!value || typeof value !== 'object') return fallback;
  return {
    ...fallback,
    ...value,
    version: ALISHA_MEMORY_VERSION,
    visitorId,
    visitDays: Array.from(
      new Set((Array.isArray(value.visitDays) ? value.visitDays : fallback.visitDays).filter(Boolean))
    ).slice(-90),
    sectionVisits:
      value.sectionVisits && typeof value.sectionVisits === 'object'
        ? value.sectionVisits
        : {},
    deliveries: (Array.isArray(value.deliveries) ? value.deliveries : [])
      .filter((item) => item?.memoryId && item?.deliveredAt)
      .slice(-60),
  };
}

export function mergeAlishaMemoryProfiles(localValue, remoteValue, visitorId) {
  const local = normalizeAlishaMemoryProfile(localValue, visitorId);
  const remote = normalizeAlishaMemoryProfile(remoteValue, visitorId);
  const deliveryMap = new Map();
  [...remote.deliveries, ...local.deliveries].forEach((delivery) => {
    const key = `${delivery.memoryId}-${delivery.deliveredAt}`;
    deliveryMap.set(key, delivery);
  });
  const sectionKeys = new Set([
    ...Object.keys(remote.sectionVisits || {}),
    ...Object.keys(local.sectionVisits || {}),
  ]);
  const sectionVisits = Object.fromEntries(
    Array.from(sectionKeys).map((section) => [
      section,
      Math.max(
        Number(local.sectionVisits?.[section] || 0),
        Number(remote.sectionVisits?.[section] || 0)
      ),
    ])
  );
  const firstSeenAt = [local.firstSeenAt, remote.firstSeenAt]
    .filter(Boolean)
    .sort()[0];
  const lastSeenAt = [local.lastSeenAt, remote.lastSeenAt]
    .filter(Boolean)
    .sort()
    .at(-1);

  return normalizeAlishaMemoryProfile(
    {
      ...remote,
      firstSeenAt,
      lastSeenAt,
      visitDays: Array.from(new Set([...remote.visitDays, ...local.visitDays])),
      sectionVisits,
      deliveries: Array.from(deliveryMap.values())
        .sort((left, right) => left.deliveredAt.localeCompare(right.deliveredAt))
        .slice(-60),
    },
    visitorId
  );
}

export function registerAlishaVisit(profile, now = new Date()) {
  const date = safeDate(now) || new Date();
  const dayKey = toLocalDayKey(date);
  return {
    ...profile,
    lastSeenAt: date.toISOString(),
    visitDays: Array.from(new Set([...(profile.visitDays || []), dayKey])).slice(-90),
  };
}

export function hasDeliveredToday(profile, now = new Date()) {
  const today = toLocalDayKey(now);
  return (profile?.deliveries || []).some(
    (delivery) => toLocalDayKey(delivery.deliveredAt) === today
  );
}

export function recordAlishaDelivery(
  profile,
  memoryId,
  action = 'delivered',
  now = new Date()
) {
  const deliveredAt = (safeDate(now) || new Date()).toISOString();
  const previous = (profile.deliveries || []).filter(
    (delivery) => delivery.memoryId !== memoryId
  );
  return {
    ...profile,
    deliveries: [...previous, { memoryId, deliveredAt, action }].slice(-60),
  };
}

export function updateAlishaDeliveryAction(profile, memoryId, action) {
  return {
    ...profile,
    deliveries: (profile.deliveries || []).map((delivery) =>
      delivery.memoryId === memoryId ? { ...delivery, action } : delivery
    ),
  };
}

function deliveredRecently(profile, memoryId, now, days = 30) {
  const cutoff = now.getTime() - days * DAY_MS;
  return (profile?.deliveries || []).some((delivery) => {
    if (delivery.memoryId !== memoryId) return false;
    const deliveredAt = safeDate(delivery.deliveredAt);
    return deliveredAt && deliveredAt.getTime() >= cutoff;
  });
}

function scoreMemory(post, profile, now) {
  const postDate = safeDate(post.date);
  if (!postDate) return null;
  const ageDays = Math.floor((now.getTime() - postDate.getTime()) / DAY_MS);
  if (ageDays < 2) return null;

  const memoryId = String(post.id);
  if (deliveredRecently(profile, memoryId, now)) return null;

  const sameDay =
    postDate.getMonth() === now.getMonth() && postDate.getDate() === now.getDate();
  const mediaCount = Array.isArray(post.media) ? post.media.length : 0;
  const tagCount = Array.isArray(post.tags) ? post.tags.length : 0;
  const score =
    Math.min(28, Math.log2(ageDays + 1) * 4) +
    (sameDay ? 52 : 0) +
    Math.min(8, mediaCount * 3) +
    Math.min(4, tagCount) +
    stableNoise(`${memoryId}-${toLocalDayKey(now)}`) * 5;

  return {
    post,
    memoryId,
    score,
    reason: sameDay
      ? '同一天，不同年份'
      : mediaCount > 0
        ? '一段很久没见的影像记忆'
        : '一页很久没翻过的旧日记',
  };
}

export function selectAlishaMemory({ posts, profile, now = new Date() }) {
  const current = safeDate(now) || new Date();
  if (!Array.isArray(posts) || posts.length === 0 || hasDeliveredToday(profile, current)) {
    return null;
  }

  const ranked = posts
    .map((post) => scoreMemory(post, profile, current))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  if (!selected) return null;

  return {
    id: selected.memoryId,
    contentType: 'diary',
    contentId: selected.post.id,
    date: selected.post.date,
    title: '阿丽莎想起了一天',
    excerpt: excerptFromPost(selected.post),
    reason: selected.reason,
    source: 'local-rules',
  };
}

export function normalizeCloudRecommendation(value, posts) {
  if (!value || typeof value !== 'object') return null;
  const contentId = String(value.contentId || value.content_id || '');
  const post = (posts || []).find((item) => String(item.id) === contentId);
  if (!post) return null;
  return {
    id: String(value.id || contentId),
    contentType: 'diary',
    contentId: post.id,
    date: post.date,
    title: String(value.title || '阿丽莎想起了一天'),
    excerpt: String(value.excerpt || excerptFromPost(post)),
    reason: String(value.reason || '一页值得重看的旧日记'),
    source: 'cloud-rules',
  };
}
