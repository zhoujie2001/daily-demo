export const TIME_MACHINE_STRATEGIES = [
  { id: 'surprise', label: '任意一天', description: '在所有旧日记中随机旅行' },
  { id: 'year-ago', label: '一年前的今天', description: '寻找最接近去年今天的记录' },
  { id: 'project-start', label: '某个项目的起点', description: '从标签中寻找最早的一篇记录' },
  { id: 'forgotten', label: '一篇被遗忘的日记', description: '优先前往更久以前的记录' },
];

const STRATEGY_IDS = new Set(TIME_MACHINE_STRATEGIES.map((strategy) => strategy.id));

export function parsePostDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  if (typeof value !== 'string' || !value.trim()) return null;

  const isoMatch = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

export function toDateKey(value) {
  const date = parsePostDate(value);
  if (!date) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatTimeMachineDate(value) {
  const date = parsePostDate(value);
  if (!date) return String(value || '未知日期');

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function getDaysFromToday(value, now = new Date()) {
  const date = parsePostDate(value);
  const today = parsePostDate(now);
  if (!date || !today) return null;

  const targetUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.floor((todayUtc - targetUtc) / 86400000));
}

function normalizePosts(posts) {
  return (Array.isArray(posts) ? posts : [])
    .filter((post) => post?.id && parsePostDate(post.date))
    .slice()
    .sort((a, b) => parsePostDate(b.date) - parsePostDate(a.date));
}

function randomItem(items, random) {
  if (!items.length) return null;
  const rawIndex = Math.floor(random() * items.length);
  const index = Math.min(items.length - 1, Math.max(0, rawIndex));
  return items[index];
}

function withoutCurrent(posts, currentId) {
  if (posts.length <= 1 || !currentId) return posts;
  const alternatives = posts.filter((post) => post.id !== currentId);
  return alternatives.length ? alternatives : posts;
}

function chooseYearAgo(posts, now, random) {
  const target = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest = [];

  posts.forEach((post) => {
    const distance = Math.abs(parsePostDate(post.date) - target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = [post];
    } else if (distance === nearestDistance) {
      nearest.push(post);
    }
  });

  return randomItem(nearest, random);
}

function chooseProjectStart(posts, random) {
  const tags = Array.from(new Set(posts.flatMap((post) => (Array.isArray(post.tags) ? post.tags : [])).filter(Boolean)));
  if (!tags.length) return posts[posts.length - 1] || null;

  const tag = randomItem(tags, random);
  const projectPosts = posts.filter((post) => post.tags?.includes(tag));
  return projectPosts[projectPosts.length - 1] || posts[posts.length - 1] || null;
}

function chooseForgotten(posts, random) {
  const forgottenStart = Math.max(0, Math.floor(posts.length * 0.4));
  const forgotten = posts.slice(forgottenStart);
  return randomItem(forgotten.length ? forgotten : posts, random);
}

function resolveSurpriseStrategy(random) {
  const roll = random();
  if (roll < 0.7) return 'surprise';
  if (roll < 0.85) return 'year-ago';
  if (roll < 0.95) return 'forgotten';
  return 'project-start';
}

export function chooseTimeMachinePost(posts, options = {}) {
  const { strategy = 'surprise', currentId = null, now = new Date(), random = Math.random } = options;
  const normalized = normalizePosts(posts);
  if (!normalized.length) return null;

  const candidates = withoutCurrent(normalized, currentId);
  const requestedStrategy = STRATEGY_IDS.has(strategy) ? strategy : 'surprise';
  const resolvedStrategy = requestedStrategy === 'surprise' ? resolveSurpriseStrategy(random) : requestedStrategy;

  if (resolvedStrategy === 'year-ago') return chooseYearAgo(candidates, parsePostDate(now) || new Date(), random);
  if (resolvedStrategy === 'project-start') return chooseProjectStart(candidates, random);
  if (resolvedStrategy === 'forgotten') return chooseForgotten(candidates, random);
  return randomItem(candidates, random);
}

export function createTravelSequence(posts, destination, options = {}) {
  const { length = 8, random = Math.random } = options;
  const normalized = normalizePosts(posts);
  if (!destination || !normalized.length) return [];

  const sequenceLength = Math.max(1, Math.floor(length));
  const sequence = Array.from({ length: Math.max(0, sequenceLength - 1) }, () => randomItem(normalized, random));
  sequence.push(destination);
  return sequence;
}

export function findPostByTimeKey(posts, key) {
  if (!key) return null;
  return normalizePosts(posts).find((post) => toDateKey(post.date) === key || post.id === key) || null;
}
