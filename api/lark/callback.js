import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient } from '../../lib/lark/client.js';
import { handleDispatchEvent } from '../../lib/dispatch/dispatch-service.js';

// Feishu requires card.action.trigger callbacks to answer within ~3s; leave
// a small safety margin. If the business flow cannot finish in time the user
// gets an "accepted" toast, while the OpenAPI calls (guarded by a server-side
// reply uuid) may still complete in the background.
const DISPATCH_DEADLINE_MS = 2800;

// Module-level so the tenant_access_token cache survives warm invocations.
// Env values are read lazily through accessors.
const larkClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

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

function deadline(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        httpStatus: 200,
        body: { toast: { type: 'info', content: '派单请求已受理，请稍后刷新卡片查看结果' } },
        errorCode: 'CALLBACK_DEADLINE',
      });
    }, timeoutMs);
  });
}

async function handleCardAction(body) {
  return Promise.race([
    handleDispatchEvent(body, {
      client: larkClient,
      config: {
        featureEnabled: process.env.LARK_DISPATCH_FEATURE_ENABLED,
        allowedChatIds: process.env.LARK_DISPATCH_ALLOWED_CHAT_IDS,
      },
    }),
    deadline(DISPATCH_DEADLINE_MS),
  ]);
}

function scheduleAfterResponse(task) {
  const pending = Promise.resolve().then(task);
  pending.catch(() => {
    // The task logs a sanitized failure itself. This catch prevents an
    // unhandled rejection if a future task implementation throws unexpectedly.
  });
  try {
    waitUntil(pending);
  } catch {
    // Outside Vercel (notably local tests), the promise still runs. In Vercel,
    // waitUntil keeps the invocation alive after the HTTP response is flushed.
  }
}

export default async function handler(req, res) {
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

  if (!tokenValid || !appIdValid) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Business layer: dispatch thread + card update. Business outcomes are
  // returned as HTTP 200 with a toast body; only protocol/auth failures above
  // use non-2xx so the Feishu client never shows a generic interaction error.
  try {
    const result = await handleCardAction(body);
    const response = res.status(result.httpStatus || 200).json(result.body);
    if (typeof result.afterResponse === 'function') {
      scheduleAfterResponse(result.afterResponse);
    }
    return response;
  } catch {
    console.error(JSON.stringify({ module: 'bess-dispatch', stage: 'callback_failed', error_code: 'UNEXPECTED' }));
    return res.status(200).json({ toast: { type: 'error', content: '派单服务暂时不可用，请稍后重试' } });
  }
}
