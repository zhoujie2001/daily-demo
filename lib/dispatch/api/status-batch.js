import process from 'node:process';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../ingest.js';
import { dispatchOperationId } from '../operation.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import {
  createDispatchStatusCache,
  queuedDispatchStatus,
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

function publicStatus(status, { chatId, batchId, source }) {
  if (!status?.found) {
    return {
      chat_id: chatId,
      batch_id: batchId,
      found: false,
      status: 'QUEUED',
      transient: true,
      operation_id: dispatchOperationId(chatId, batchId),
      retry_after_ms: 2_000,
      source,
    };
  }
  const deadLetter = status.status === 'DEAD';
  const expiredLease = status.status === 'SENDING' && status.retryable === true;
  const unresolved = ['QUEUED', 'RETRY', 'PROCESSING'].includes(status.status);
  return {
    chat_id: chatId,
    batch_id: batchId,
    ...status,
    status: expiredLease ? 'FAILED' : unresolved ? 'SENDING' : deadLetter ? 'FAILED' : status.status,
    ...(expiredLease && !status.error_code ? { error_code: 'INGEST_LEASE_EXPIRED' } : {}),
    ...(deadLetter ? {
      dead_letter: true,
      terminal_reason: status.error_code || 'OUTBOX_DELIVERY_FAILED',
    } : {}),
    source,
  };
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
          if (item.status) {
            results.set(keyOf(item.chatId, item.batchId), publicStatus(item.status, {
              ...item, source: 'runtime-cache',
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
              results.set(keyOf(item.chatId, item.batchId), publicStatus(status, {
                ...item, source: 'supabase',
              }));
              await writeDispatchStatusCache(statusCache, {
                chatId: item.chatId,
                batchId: item.batchId,
                value: status.found
                  ? status
                  : queuedDispatchStatus({ operationId: dispatchOperationId(item.chatId, item.batchId) }),
              });
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
        return res.status(error.status || 400).json({
          ok: false,
          error_code: error.code,
          message: error.message,
        });
      }
      if (error?.code === 'BATCH_STATUS_TIMEOUT') {
        return res.status(503).json({
          ok: false,
          status: 'UNAVAILABLE',
          transient: true,
          error_code: 'BATCH_STATUS_TIMEOUT',
        });
      }
      return res.status(500).json({ ok: false, error_code: 'INTERNAL_ERROR' });
    }
  };
}

export default createDispatchStatusBatchHandler();
