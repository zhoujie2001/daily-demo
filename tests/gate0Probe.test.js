import assert from 'node:assert/strict';
import test from 'node:test';
import { createGate0ProbeHandler } from '../lib/gate0/api/probe.js';

const SECRET = 'gate0-preview-test-secret';
const BODY = Object.freeze({
  schema_version: 1,
  probe_id: 'gate0-probe-0001',
  source_record_id: 'recGate0Record0001',
  payload_hash: 'a'.repeat(64),
  sent_at: '2026-09-17T10:52:00.000Z',
});

async function invoke({ method = 'POST', token = SECRET, body = BODY, secret = SECRET } = {}) {
  const result = { headers: {} };
  const headers = token === undefined ? {} : { 'x-gate0-token': token };
  const req = { method, headers, body };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return payload; },
  };
  await createGate0ProbeHandler({
    secret,
    now: () => new Date('2026-09-17T10:52:01.000Z'),
  })(req, res);
  return result;
}

test('acknowledges a valid probe without external side effects', async () => {
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(result.body, {
    ok: true,
    status: 'ACKNOWLEDGED',
    probe_id: BODY.probe_id,
    source_record_id: BODY.source_record_id,
    payload_hash: BODY.payload_hash,
    ack_id: 'gate0-0de96c093dbb9a0ba7d09813',
    received_at: '2026-09-17T10:52:01.000Z',
  });
});

test('returns the same acknowledgement identity for an identical retry', async () => {
  const first = await invoke();
  const second = await invoke();
  assert.equal(first.body.ack_id, second.body.ack_id);
  assert.equal(first.body.probe_id, second.body.probe_id);
  assert.equal(first.body.source_record_id, second.body.source_record_id);
});

test('accepts authentication in the JSON body for clients that cannot send custom headers', async () => {
  const result = await invoke({
    token: undefined,
    body: { ...BODY, automation_token: SECRET },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ACKNOWLEDGED');
  assert.equal(result.body.probe_id, BODY.probe_id);
});

test('rejects missing or incorrect authentication', async () => {
  const missing = await invoke({ token: '' });
  const wrong = await invoke({ token: 'wrong-secret' });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error_code, 'INVALID_PROBE_TOKEN');
});

test('fails closed when the Preview secret is not configured', async () => {
  const result = await invoke({ secret: '' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error_code, 'PROBE_NOT_CONFIGURED');
});

test('accepts POST only', async () => {
  const result = await invoke({ method: 'GET' });
  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, 'POST');
});

test('rejects malformed and oversized payloads', async () => {
  const invalidRecord = await invoke({ body: { ...BODY, source_record_id: 'not-a-record' } });
  const invalidHash = await invoke({ body: { ...BODY, payload_hash: 'abc' } });
  const invalidTime = await invoke({ body: { ...BODY, sent_at: 'not-a-time' } });
  const oversized = await invoke({ body: { ...BODY, padding: 'x'.repeat(9 * 1024) } });
  for (const result of [invalidRecord, invalidHash, invalidTime, oversized]) {
    assert.equal(result.status, 400);
    assert.equal(result.body.error_code, 'INVALID_SCHEMA');
  }
});
