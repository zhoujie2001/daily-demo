import process from 'node:process';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import { isAcceptedQueuedStatus, toPublicDispatchStatus } from '../public-status.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import {
  createDispatchStatusCache,
  readDispatchStatusCache,
  writeDispatchStatusCache,
} from '../status-cache.js';
import { createServerTiming } from '../timing.js';
import { attachDispatchResponseMetadata } from './response-metadata.js';

const MAX_ITEMS = 20;
const DEFAULT_TOTAL_TIMEOUT_MS = 2_500;

function keyOf(chatId, batchId) {
  return `${chatId}\u0000${batchId}`;
}

function withDeadline(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Batch status timeout'), {
        code: 'BATCH_STATUS_TIMEOUT',
      })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createDispatchStatusBatchHandler({
  storeFactory = () => createSupabaseDispatchStore(),
  statusCache = createDispatchStatusCache(),
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
} = {}) {
  return async function handler(req, res) {
    const timing = createServerTiming(res);
    const metadata = attachDispatchResponseMetadata(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      timing.flush();
      return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        timing.flush();
        return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' });
      }
    }

    try {
      const authStartedAt = Date.now();
      verifyDispatchIngestSignature({
        body,
        timestamp: req.headers?.['x-bess-timestamp'],
        signature: req.headers?.['x-bess-signature'],
        secret: process.env.BESS_DISPATCH_INGEST_SECRET,
      });
      timing.measure('auth', authStartedAt);

      if (!Array.isArray(body?.items) || body.items.length === 0) {
        throw new DispatchIngestError('INVALID_SCHEMA', 'items 必须是非空数组');
      }
      if (body.items.length > MAX_ITEMS) {
        throw new DispatchIngestError('TOO_MANY_ITEMS', `items 单次最多 ${MAX_ITEMS} 条`, 400);
      }

      const invalid = [];
      const unique = [];
      const seen = new Set();
      body.items.forEach((item, inputIndex) => {
        const chatId = String(item?.chat_id || '').trim();
        const batchId = String(item?.batch_id || '').trim();
        if (!chatId || !batchId) {
          invalid.push({ input_index: inputIndex, ok: false, error_code: 'INVALID_ITEM_SCHEMA' });
          return;
        }
        const key = keyOf(chatId, batchId);
        if (seen.has(key)) return;
        seen.add(key);
        unique.push({ chatId, batchId });
      });

      const run = async () => {
        const cacheStartedAt = Date.now();
        const cacheReads = await Promise.all(unique.map(async (item) => ({
          ...item,
          status: await readDispatchStatusCache(statusCache, item),
        })));
        timing.measure('cache', cacheStartedAt);

        const results = new Map();
        const misses = [];
        for (const item of cacheReads) {
          if (item.status?.found || isAcceptedQueuedStatus(item.status, item)) {
            results.set(keyOf(item.chatId, item.batchId), toPublicDispatchStatus(item.status, {
              ...item, source: 'runtime-cache', httpStatus: 200,
            }));
          } else {
            misses.push(item);
          }
        }

        if (misses.length > 0) {
          const databaseStartedAt = Date.now();
          try {
            const rows = await storeFactory().getIngestBatchStatuses(misses);
            const byKey = new Map(rows.map((row) => [keyOf(row.chat_id, row.batch_id), row]));
            await Promise.all(misses.map(async (item) => {
              const status = byKey.get(keyOf(item.chatId, item.batchId)) || { found: false };
              results.set(keyOf(item.chatId, item.batchId), toPublicDispatchStatus(status, {
                ...item, source: 'supabase', httpStatus: 200,
              }));
              if (status.found) {
                await writeDispatchStatusCache(statusCache, {
                  chatId: item.chatId,
                  batchId: item.batchId,
                  value: status,
                });
              }
            }));
          } catch (error) {
            for (const item of misses) {
              results.set(keyOf(item.chatId, item.batchId), {
                chat_id: item.chatId,
                batch_id: item.batchId,
                ok: false,
                status: 'UNAVAILABLE',
                transient: true,
                retryable: true,
                error_code: error?.code === 'DISPATCH_DB_TIMEOUT'
                  ? 'STATUS_TEMPORARILY_UNAVAILABLE'
                  : 'STATUS_ITEM_FAILED',
                error_detail: error?.message || 'Dispatch status item query failed.',
                http_status: 503,
                status_source: 'supabase',
                source: 'supabase',
              });
            }
          } finally {
            timing.measure('database', databaseStartedAt);
          }
        }

        const sources = new Set([...results.values()].map((item) => item.source));
        metadata.setStatusSource(sources.size === 1 ? [...sources][0] : sources.size > 1 ? 'mixed' : 'none');
        return [...unique.map((item) => results.get(keyOf(item.chatId, item.batchId))), ...invalid];
      };

      const items = await withDeadline(run(), totalTimeoutMs);
      timing.flush();
      return res.status(200).json({ ok: true, items });
    } catch (error) {
      timing.flush();
      if (error instanceof DispatchIngestError) {
        const httpStatus = error.status || 400;
        metadata.setStatusSource('request-validation');
        return res.status(httpStatus).json({
          ok: false,
          error_code: error.code,
          error_detail: error.message,
          message: error.message,
          status_source: 'request-validation',
          http_status: httpStatus,
        });
      }
      if (error?.code === 'BATCH_STATUS_TIMEOUT') {
        metadata.setStatusSource('batch-handler');
        return res.status(503).json({
          ok: false,
          status: 'UNAVAILABLE',
          transient: true,
          error_code: 'BATCH_STATUS_TIMEOUT',
          error_detail: error?.message || 'Batch dispatch status query timed out.',
          status_source: 'batch-handler',
          http_status: 503,
        });
      }
      metadata.setStatusSource('batch-handler');
      return res.status(500).json({
        ok: false,
        error_code: 'INTERNAL_ERROR',
        error_detail: error?.message || 'Internal Error',
        status_source: 'batch-handler',
        http_status: 500,
      });
    }
  };
}

export default createDispatchStatusBatchHandler();
