import {
  AlishaMemoryError,
  createAlishaMemoryService,
} from './alishaMemoryService.js';
import {
  clearVisitorSession,
  clientIp,
  establishVisitorSession,
  rateLimitBucket,
  requireVisitorSession,
} from './alishaMemorySecurity.js';

const DEFAULT_ORIGINS = [
  'https://www.littlearisa88.com',
  'https://littlearisa88.com',
  'https://zhoujie2001.github.io',
  'http://localhost:5173',
];

function allowedOrigins() {
  const configured = String(process.env.ALISHA_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

function configureCors(req, res) {
  const origin = String(req.headers?.origin || '');
  const allowed = !origin || allowedOrigins().has(origin);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Alisha-Visitor-Id'
  );
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return allowed;
}

async function enforceRateLimits(service, req, visitorId, action, options = {}) {
  if (options.skipRateLimit) return;
  const identityRequest = action === 'identity';
  const windowSeconds = identityRequest ? 600 : 60;
  const ipLimit = identityRequest ? 30 : 120;
  const ipResult = await service.consumeRateLimit(
    rateLimitBucket('ip', clientIp(req), options),
    ipLimit,
    windowSeconds
  );
  let visitorResult = null;
  if (visitorId) {
    visitorResult = await service.consumeRateLimit(
      rateLimitBucket('visitor', visitorId, options),
      60,
      60
    );
  }
  const blocked = [ipResult, visitorResult].filter(Boolean).find((result) => !result.allowed);
  if (blocked) {
    const retryAfter = Math.max(1, Number(blocked.retry_after || 60));
    const error = new AlishaMemoryError('请求过于频繁，请稍后再试', 429);
    error.retryAfter = retryAfter;
    throw error;
  }
}

function requestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new AlishaMemoryError('请求正文不是有效 JSON', 400);
    }
  }
  return req.body;
}

function localDayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function handleAlishaMemoryRequest(req, res, action, options = {}) {
  const corsAllowed = configureCors(req, res);
  if (req.method === 'OPTIONS') {
    return corsAllowed ? res.status(204).end() : res.status(403).end();
  }
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  try {
    const service = options.service || createAlishaMemoryService(options);
    if (action === 'identity' && req.method === 'POST') {
      await enforceRateLimits(service, req, null, action, options);
      const visitorId = establishVisitorSession(req, res, options);
      return res.status(200).json({ visitorId });
    }
    const visitorId = requireVisitorSession(req, res, options);
    await enforceRateLimits(service, req, visitorId, action, options);
    if (action === 'profile' && req.method === 'GET') {
      const profile = await service.getProfile(visitorId, localDayKey());
      return res.status(200).json({ profile });
    }
    if (action === 'events' && req.method === 'POST') {
      const result = await service.recordEvents(
        visitorId,
        requestBody(req).events,
        localDayKey()
      );
      return res.status(202).json(result);
    }
    if (action === 'recommendation' && req.method === 'GET') {
      const recommendation = await service.recommend(visitorId, {
        dayKey: String(req.query?.day || localDayKey()),
        section: String(req.query?.section || 'daily'),
      });
      return recommendation
        ? res.status(200).json({ recommendation })
        : res.status(204).end();
    }
    if (action === 'feedback' && req.method === 'POST') {
      const body = requestBody(req);
      const result = await service.recordFeedback(
        visitorId,
        body.memoryId,
        body.action
      );
      return res.status(200).json(result);
    }
    if (action === 'forget' && req.method === 'DELETE') {
      await service.forget(visitorId);
      clearVisitorSession(req, res);
      return res.status(204).end();
    }
    res.setHeader('Allow', action === 'forget' ? 'DELETE, OPTIONS' : 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = error?.status || 500;
    if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    console.error(JSON.stringify({
      level: 'error',
      event: 'alisha_memory_request_failed',
      action,
      status,
      upstreamStatus: error?.upstreamStatus || null,
      message: error?.message || 'Unknown error',
    }));
    return res.status(status).json({
      error: status >= 500 ? '阿丽莎暂时记不起来了' : error.message,
    });
  }
}

export async function handleAlishaMemoryCleanup(req, res, options = {}) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronSecret = String(options.cronSecret || process.env.CRON_SECRET || '');
  if (!cronSecret || req.headers?.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const service = options.service || createAlishaMemoryService(options);
    const result = await service.cleanupExpired(options.now || new Date());
    return res.status(200).json({ cleaned: true, ...result });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'alisha_memory_cleanup_failed',
      message: error?.message || 'Unknown error',
    }));
    return res.status(500).json({ error: 'Cleanup failed' });
  }
}
