import { siteBrand } from '../data/site.js';

export const SITE_PROFILE_LIMITS = Object.freeze({
  tagline: 140,
  intro: 100,
});

export const DEFAULT_SITE_PROFILE = Object.freeze({
  tagline: siteBrand.tagline,
  intro: siteBrand.intro,
});

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeSiteProfile(value, fallback = DEFAULT_SITE_PROFILE) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    tagline: cleanText(source.tagline) || fallback.tagline,
    intro: cleanText(source.intro) || fallback.intro,
  };
}

export function validateSiteProfile(value) {
  const tagline = cleanText(value?.tagline);
  const intro = cleanText(value?.intro);
  const errors = {};

  if (!tagline) errors.tagline = '请输入英文简介';
  else if (tagline.length > SITE_PROFILE_LIMITS.tagline) {
    errors.tagline = `英文简介不能超过 ${SITE_PROFILE_LIMITS.tagline} 个字符`;
  }

  if (!intro) errors.intro = '请输入中文说明';
  else if (intro.length > SITE_PROFILE_LIMITS.intro) {
    errors.intro = `中文说明不能超过 ${SITE_PROFILE_LIMITS.intro} 个字符`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    profile: { tagline, intro },
  };
}

export function extractRemoteSiteProfile(payload) {
  const source = payload?.profile && typeof payload.profile === 'object'
    ? payload.profile
    : payload;
  const tagline = cleanText(source?.tagline);
  const intro = cleanText(source?.intro);

  if (!tagline || !intro) return null;
  return { tagline, intro };
}

export function profilesEqual(left, right) {
  if (!left || !right) return false;
  return cleanText(left.tagline) === cleanText(right.tagline)
    && cleanText(left.intro) === cleanText(right.intro);
}
