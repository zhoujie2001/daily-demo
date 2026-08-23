import { formatTimeMachineDate, toDateKey } from './timeMachine.js';

const DEFAULT_SITE_TITLE = '四十四次日落';
const DEFAULT_SHARE_COPY = '分享一篇来自四十四次日落的 Daily。';

function getLocationHref() {
  return typeof window === 'undefined' ? 'https://www.littlearisa88.com/' : window.location.href;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxLength = 72) {
  const text = compactText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}…`;
}

export function createDailyLink(post, { baseHref = getLocationHref(), source = 'share' } = {}) {
  const key = toDateKey(post?.date) || post?.id;
  if (!key) throw new Error('这篇 Daily 暂时无法生成分享链接');

  const url = new URL(baseHref);
  url.search = '';
  url.searchParams.set('time', key);
  url.searchParams.set('from', source);
  url.hash = 'daily';
  return url;
}

export function createDailySharePayload(post, baseHref) {
  const formattedDate = formatTimeMachineDate(post?.date) || post?.date || '某一天';
  const excerpt = truncateText([post?.title, post?.text].filter(Boolean).join(' · '));

  return {
    title: `${DEFAULT_SITE_TITLE} · ${formattedDate}`,
    text: excerpt || DEFAULT_SHARE_COPY,
    url: createDailyLink(post, { baseHref, source: 'share' }).toString(),
  };
}

export function getDailyLinkArrivalSource(href = getLocationHref()) {
  try {
    return new URL(href).searchParams.get('from') === 'share' ? 'share' : 'link';
  } catch {
    return 'link';
  }
}

export function isCanceledShare(error) {
  return error?.name === 'AbortError';
}

export async function copyText(value, {
  navigatorObject = typeof navigator === 'undefined' ? null : navigator,
  documentObject = typeof document === 'undefined' ? null : document,
} = {}) {
  if (navigatorObject?.clipboard?.writeText) {
    await navigatorObject.clipboard.writeText(value);
    return;
  }

  if (!documentObject?.body || typeof documentObject.execCommand !== 'function') {
    throw new Error('当前浏览器不支持复制链接');
  }

  const textarea = documentObject.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  documentObject.body.appendChild(textarea);
  textarea.select();

  try {
    if (!documentObject.execCommand('copy')) {
      throw new Error('当前浏览器不支持复制链接');
    }
  } finally {
    textarea.remove();
  }
}
