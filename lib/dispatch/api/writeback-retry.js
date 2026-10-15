import process from 'node:process';
import { Buffer } from 'node:buffer';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { LarkClient } from '../../lark/client.js';
import {
  DEFAULT_WRITEBACK_MAX_ATTEMPTS,
  isPermanentWritebackError,
  writebackRetryDelayMs,
} from '../writeback-policy.js';

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export async function runPendingWritebacks({
  store = createSupabaseDispatchStore(),
  client = new LarkClient({
    appId: () => process.env.LARK_APP_ID,
    appSecret: () => process.env.LARK_APP_SECRET,
  }),
  appToken = process.env.BESS_BASE_APP_TOKEN,
  tableId = process.env.BESS_BASE_TABLE_ID,
  now = () => new Date(),
  maxAttempts = DEFAULT_WRITEBACK_MAX_ATTEMPTS,
  limit = 100,
} = {}) {
  if (!appToken || !tableId) {
    throw Object.assign(new Error('Base writeback is not configured'), { code: 'WRITEBACK_NOT_CONFIGURED' });
  }
  const current = now();
  const workerToken = randomUUID();
  const tasks = await store.claimPendingWritebacks({
    workerToken, now: current, leaseSeconds: 60, limit, maxAttempts,
  });
  const results = [];
  for (const task of tasks) {
    const { formMessageId, recordId, operationId, attempt } = task;
    try {
      await client.request('PATCH', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
        body: { fields: { Status: 'INGESTED', DispatchOperationID: operationId } },
      });
      const completed = await store.completeWriteback({ formMessageId, recordId, workerToken });
      results.push({ recordId, ok: true, reused: completed.reused === true });
    } catch (error) {
      const nextAttempt = Number(attempt || 0) + 1;
      const dead = isPermanentWritebackError(error) || nextAttempt >= maxAttempts;
      const failure = await store.failClaimedWriteback({
        formMessageId, recordId, workerToken,
        errorCode: error?.code || 'BASE_WRITEBACK_FAILED',
        now: current,
        nextRetryAt: new Date(current.getTime() + writebackRetryDelayMs(attempt)),
        dead,
      });
      results.push({
        recordId, ok: false, dead_letter: dead,
        ownership_lost: failure.ownershipLost === true,
        error_code: error?.code || 'BASE_WRITEBACK_FAILED',
      });
    }
  }
  return { ok: true, claimed: tasks.length, results };
}

export function createWritebackRetryHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  client = new LarkClient({
    appId: () => process.env.LARK_APP_ID,
    appSecret: () => process.env.LARK_APP_SECRET,
  }),
  secret = process.env.CRON_SECRET,
  appToken = process.env.BESS_BASE_APP_TOKEN,
  tableId = process.env.BESS_BASE_TABLE_ID,
  now = () => new Date(),
  maxAttempts = DEFAULT_WRITEBACK_MAX_ATTEMPTS,
} = {}) {
  return async function handler(req, res) {
    if (req?.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!appToken || !tableId) return res.status(500).json({ ok: false, error: 'Base writeback is not configured' });

    try {
      const result = await runPendingWritebacks({
        store: storeFactory(), client, appToken, tableId, now, maxAttempts,
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(503).json({ ok: false, error_code: error?.code || 'WRITEBACK_RETRY_UNAVAILABLE' });
    }
  };
}

export default createWritebackRetryHandler();
