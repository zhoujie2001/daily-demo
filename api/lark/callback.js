import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

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

function parseJson(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return JSON.parse(value);
}

function decryptPayload(encryptedPayload, encryptKey) {
  const encryptedBuffer = Buffer.from(encryptedPayload, 'base64');
  if (encryptedBuffer.length <= 16) {
    throw new Error('Invalid encrypted payload');
  }

  const key = createHash('sha256').update(encryptKey).digest();
  const initializationVector = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, initializationVector);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  return JSON.parse(plaintext);
}

function parseRequestBody(rawBody, encryptKey) {
  const body = parseJson(rawBody) || {};

  if (typeof body.encrypt !== 'string') {
    return body;
  }

  if (!encryptKey) {
    const error = new Error('Missing LARK_ENCRYPT_KEY');
    error.code = 'MISSING_ENCRYPT_KEY';
    throw error;
  }

  return decryptPayload(body.encrypt, encryptKey);
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = parseRequestBody(req.body, process.env.LARK_ENCRYPT_KEY);
  } catch (error) {
    const status = error.code === 'MISSING_ENCRYPT_KEY' ? 500 : 400;
    return res.status(status).json({ error: 'Invalid request body' });
  }

  const verificationToken = process.env.LARK_VERIFICATION_TOKEN;
  const hasChallenge = Object.prototype.hasOwnProperty.call(body, 'challenge');
  const hasTopLevelType = Object.prototype.hasOwnProperty.call(body, 'type');
  const hasHeaderEventType = typeof body.header?.event_type === 'string';
  const isUrlVerification = body.type === 'url_verification'
    || (!hasTopLevelType && !hasHeaderEventType && hasChallenge);

  if (isUrlVerification) {
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
  const tokenValid = Boolean(verificationToken)
    && valuesMatch(requestToken, verificationToken);
  const appIdValid = Boolean(appId) && valuesMatch(requestAppId, appId);

  console.info('Lark callback authentication', {
    eventType,
    appIdValid,
    tokenValid,
  });

  if (!tokenValid || !appIdValid) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // TODO: 后续接入派单、写飞书表格和更新卡片逻辑；耗时任务不得阻塞本次响应。
  return res.status(200).json({});
}
