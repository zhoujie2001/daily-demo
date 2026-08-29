import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

let hasRun = false;

function valuesMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function encryptPayload(payload, encryptKey) {
  const key = createHash('sha256').update(encryptKey).digest();
  const initializationVector = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, initializationVector);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([initializationVector, ciphertext]).toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.VERCEL_ENV !== 'preview') {
    return res.status(404).json({ error: 'Not found' });
  }

  const testToken = process.env.LARK_TEST_CALLBACK_TOKEN;
  if (!testToken || !valuesMatch(req.headers?.['x-lark-test-token'], testToken)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (hasRun) {
    return res.status(409).json({ error: 'Test callback already used' });
  }
  hasRun = true;

  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const verificationToken = process.env.LARK_VERIFICATION_TOKEN;
  const appId = process.env.LARK_APP_ID;
  if (!encryptKey || !verificationToken || !appId) {
    return res.status(500).json({ error: 'Missing callback configuration' });
  }

  const event = {
    header: {
      event_type: 'card.action.trigger',
      token: verificationToken,
      app_id: appId,
    },
    event: {
      action: { value: { test: 'preview-callback-validation' } },
    },
  };
  const body = JSON.stringify({ encrypt: encryptPayload(event, encryptKey) });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const signature = createHash('sha256')
    .update(timestamp + nonce + encryptKey + body)
    .digest('hex');
  const host = req.headers?.host;
  if (typeof host !== 'string' || !host.endsWith('.vercel.app')) {
    return res.status(400).json({ error: 'Invalid preview host' });
  }

  const callbackResponse = await fetch(`https://${host}/api/lark/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lark-Request-Timestamp': timestamp,
      'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': signature,
    },
    body,
  });
  const responseText = await callbackResponse.text();
  const emptyAcknowledgement = responseText === '' || responseText === '{}';

  return res.status(callbackResponse.ok ? 200 : 502).json({
    callbackStatus: callbackResponse.status,
    acknowledgement: emptyAcknowledgement ? 'empty' : 'non-empty',
  });
}
