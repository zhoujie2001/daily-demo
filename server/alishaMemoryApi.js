import {
  AlishaMemoryError,
  createAlishaMemoryService,
} from './alishaMemoryService.js';

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
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Alisha-Visitor-Id'
  );
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return allowed;
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

  const visitorId = req.headers?.['x-alisha-visitor-id'];
  try {
    const service = options.service || createAlishaMemoryService(options);
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
      return res.status(204).end();
    }
    res.setHeader('Allow', action === 'forget' ? 'DELETE, OPTIONS' : 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = error?.status || 500;
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
