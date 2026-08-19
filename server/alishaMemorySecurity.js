import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { AlishaMemoryError, validateVisitorId } from './alishaMemoryService.js';

const SESSION_COOKIE = 'alisha_memory_session';
const SESSION_VERSION = 'v1';
const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const SESSION_RENEWAL_SECONDS = 30 * 24 * 60 * 60;

function requiredSecret(value, name) {
  const secret = String(value || '').trim();
  if (secret.length < 32) {
    throw new AlishaMemoryError(`${name} 尚未安全配置`, 503);
  }
  return secret;
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  return String(req.headers?.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return cookies;
      const name = part.slice(0, separator);
      const value = part.slice(separator + 1);
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function sessionSecret(options = {}) {
  return requiredSecret(
    options.signingSecret || process.env.ALISHA_VISITOR_SIGNING_SECRET,
    '阿丽莎访客签名密钥'
  );
}

function sessionValue(visitorId, expiresAt, secret) {
  const payload = `${SESSION_VERSION}.${visitorId}.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

function decodeSession(value, secret, nowMs) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;
  const [, visitorId, expiresText, signature] = parts;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return null;
  try {
    validateVisitorId(visitorId);
  } catch {
    return null;
  }
  const payload = `${SESSION_VERSION}.${visitorId}.${expiresAt}`;
  if (!safeEqual(signature, sign(payload, secret))) return null;
  return { visitorId, expiresAt };
}

function requestIsSecure(req) {
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' || Boolean(req.socket?.encrypted);
}

function cookieSameSite(req) {
  const origin = String(req.headers?.origin || '');
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
  if (!origin || !host) return 'Lax';
  try {
    return new URL(origin).hostname === host.split(':')[0] ? 'Lax' : 'None';
  } catch {
    return 'Lax';
  }
}

function appendSetCookie(res, cookie) {
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
  const values = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...values, cookie]);
}

function setSessionCookie(req, res, visitorId, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  const value = sessionValue(visitorId, expiresAt, sessionSecret(options));
  const sameSite = cookieSameSite(req);
  const secure = requestIsSecure(req) || sameSite === 'None';
  appendSetCookie(
    res,
    [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      'Path=/api/alisha/memory',
      'HttpOnly',
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      `SameSite=${sameSite}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  );
  return { visitorId, expiresAt };
}

function readSession(req, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const secret = sessionSecret(options);
  return decodeSession(parseCookies(req)[SESSION_COOKIE], secret, nowMs);
}

function legacyVisitorId(req, options = {}) {
  const cutoffValue = options.legacyCutoff || process.env.ALISHA_LEGACY_ID_CUTOFF;
  const cutoff = Date.parse(String(cutoffValue || ''));
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(cutoff) || nowMs > cutoff) return null;
  try {
    return validateVisitorId(req.headers?.['x-alisha-visitor-id']);
  } catch {
    return null;
  }
}

export function establishVisitorSession(req, res, options = {}) {
  const existing = readSession(req, options);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (existing) {
    if (existing.expiresAt - nowSeconds <= SESSION_RENEWAL_SECONDS) {
      setSessionCookie(req, res, existing.visitorId, options);
    }
    return existing.visitorId;
  }
  const visitorId = legacyVisitorId(req, options) || randomUUID();
  setSessionCookie(req, res, visitorId, options);
  return visitorId;
}

export function requireVisitorSession(req, res, options = {}) {
  const session = readSession(req, options);
  if (!session) throw new AlishaMemoryError('阿丽莎访客会话无效，请刷新页面', 401);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (session.expiresAt - nowSeconds <= SESSION_RENEWAL_SECONDS) {
    setSessionCookie(req, res, session.visitorId, options);
  }
  return session.visitorId;
}

export function clearVisitorSession(req, res) {
  const sameSite = cookieSameSite(req);
  const secure = requestIsSecure(req) || sameSite === 'None';
  appendSetCookie(
    res,
    [
      `${SESSION_COOKIE}=`,
      'Path=/api/alisha/memory',
      'HttpOnly',
      'Max-Age=0',
      `SameSite=${sameSite}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  );
}

export function clientIp(req) {
  const value =
    req.headers?.['x-vercel-forwarded-for'] ||
    req.headers?.['x-forwarded-for'] ||
    req.headers?.['x-real-ip'] ||
    'unknown';
  return String(Array.isArray(value) ? value[0] : value).split(',')[0].trim().slice(0, 128);
}

export function rateLimitBucket(kind, value, options = {}) {
  const secret = requiredSecret(
    options.rateLimitSalt || process.env.ALISHA_RATE_LIMIT_SALT || options.signingSecret || process.env.ALISHA_VISITOR_SIGNING_SECRET,
    '阿丽莎限流盐值'
  );
  return `${kind}:${sign(String(value || 'unknown'), secret)}`;
}

export const ALISHA_SESSION_COOKIE = SESSION_COOKIE;
