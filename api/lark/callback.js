import { timingSafeEqual } from 'node:crypto';

function valuesMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getVerificationToken(req, body) {
  const authorization = req.headers?.authorization;
  const bearerToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : undefined;

  return req.headers?.['x-lark-verification-token']
    || bearerToken
    || body?.header?.token
    || body?.token;
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const verificationToken = process.env.LARK_VERIFICATION_TOKEN;

  if (body.type === 'url_verification') {
    if (!verificationToken || !valuesMatch(body.token, verificationToken)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (typeof body.challenge !== 'string' || body.challenge.length === 0) {
      return res.status(400).json({ error: 'Invalid challenge' });
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ challenge: body.challenge });
  }

  const eventType = body.type || body.header?.event_type;
  if (eventType !== 'card.action.trigger') {
    return res.status(200).json({});
  }

  const appId = process.env.LARK_APP_ID;
  const requestToken = getVerificationToken(req, body);
  const requestAppId = body.header?.app_id || req.headers?.['x-lark-app-id'];

  if (!verificationToken || !appId
    || !valuesMatch(requestToken, verificationToken)
    || !valuesMatch(requestAppId, appId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // TODO: 后续接入派单、写飞书表格和更新卡片逻辑；耗时任务不得阻塞本次响应。
  return res.status(200).json({});
}
