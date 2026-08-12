import { apiUrl, authHeaders } from './client.js';
import {
  DEFAULT_SITE_PROFILE,
  extractRemoteSiteProfile,
  normalizeSiteProfile,
  profilesEqual,
  validateSiteProfile,
} from '../utils/siteProfile.js';

const STORAGE_KEY = 'site-profile-v1';
const PENDING_KEY = 'site-profile-v1-pending';

function readLocalProfile() {
  if (typeof window === 'undefined') return { profile: DEFAULT_SITE_PROFILE, exists: false };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { profile: DEFAULT_SITE_PROFILE, exists: false, pending: false };
    return {
      profile: normalizeSiteProfile(JSON.parse(raw)),
      exists: true,
      pending: window.localStorage.getItem(PENDING_KEY) === 'true',
    };
  } catch {
    return { profile: DEFAULT_SITE_PROFILE, exists: false, pending: false };
  }
}

function writeLocalProfile(profile, pending = false) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    window.localStorage.setItem(PENDING_KEY, String(pending));
  } catch {
    // 隐私模式或存储配额不足时，当前页面状态仍然可用。
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchRemoteProfile() {
  const response = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return extractRemoteSiteProfile(await readJson(response));
}

export async function loadSiteProfile() {
  const local = readLocalProfile();
  try {
    const remote = await fetchRemoteProfile();
    if (!remote) return { profile: local.profile, source: local.exists ? 'local' : 'default' };
    if (local.pending && !profilesEqual(local.profile, remote)) {
      return { profile: local.profile, source: 'local' };
    }
    writeLocalProfile(remote, false);
    return { profile: remote, source: 'remote' };
  } catch {
    return { profile: local.profile, source: local.exists ? 'local' : 'default' };
  }
}

export async function saveSiteProfile({ token, value }) {
  const validation = validateSiteProfile(value);
  if (!validation.valid) {
    const error = new Error('资料校验失败');
    error.code = 'VALIDATION';
    error.errors = validation.errors;
    throw error;
  }

  const profile = validation.profile;
  let synchronized = false;

  try {
    const response = await fetch(apiUrl('/api/status'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(token),
      },
      body: JSON.stringify({
        adminToken: token,
        tagline: profile.tagline,
        intro: profile.intro,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      const error = new Error('登录已过期');
      error.code = 'AUTH_EXPIRED';
      throw error;
    }
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);

    const returned = extractRemoteSiteProfile(await readJson(response));
    synchronized = profilesEqual(returned, profile);
    if (!synchronized) {
      const verified = await fetchRemoteProfile().catch(() => null);
      synchronized = profilesEqual(verified, profile);
    }
  } catch (error) {
    if (error?.code === 'AUTH_EXPIRED') throw error;
  }

  writeLocalProfile(profile, !synchronized);
  return { profile, synchronized };
}
