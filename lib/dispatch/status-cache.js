import process from 'node:process';
import { getCache } from '@vercel/functions';
import { dispatchOperationId } from './operation.js';

const PENDING_TTL_SECONDS = 15;
const TERMINAL_TTL_SECONDS = 24 * 60 * 60;
const FAILED_TTL_SECONDS = 5 * 60;

function clean(value) { return String(value || '').trim(); }

function cacheKey(chatId, batchId) {
  return dispatchOperationId(clean(chatId), clean(batchId));
}

function ttlFor(status) {
  const normalized = clean(status).toUpperCase();
  if (normalized === 'SENT') return TERMINAL_TTL_SECONDS;
  if (['FAILED', 'DEAD'].includes(normalized)) return FAILED_TTL_SECONDS;
  return PENDING_TTL_SECONDS;
}

function validStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = clean(value.status).toUpperCase();
  if (!status) return null;
  return {
    ...value,
    found: value.found !== false,
    status,
    operation_id: clean(value.operation_id),
    message_id: clean(value.message_id),
    error_code: clean(value.error_code),
    request_ids: Array.isArray(value.request_ids) ? value.request_ids.map(String) : [],
  };
}

function deadline(promise, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createDispatchStatusCache({
  cache = getCache({ namespace: 'bess-dispatch-status-v1' }),
  timeoutMs = 200,
  logger = console,
} = {}) {
  function log(level, outcome, fields = {}) {
    const writer = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger?.log?.bind(logger);
    writer?.(JSON.stringify({
      module: 'bess-dispatch-status-cache', outcome,
      vercel_region: clean(process.env.VERCEL_REGION) || 'unknown',
      ...fields,
    }));
  }

  return {
    async get({ chatId, batchId }) {
      const startedAt = Date.now();
      try {
        const value = await deadline(cache.get(cacheKey(chatId, batchId)), timeoutMs, undefined);
        const status = validStatus(value);
        log('info', status ? 'hit' : 'miss', {
          duration_ms: Date.now() - startedAt,
        });
        return status;
      } catch (error) {
        log('warn', 'read_error', {
          duration_ms: Date.now() - startedAt,
          error_code: clean(error?.code || error?.name || 'CACHE_READ_FAILED').slice(0, 80),
        });
        return null;
      }
    },

    async set({ chatId, batchId, value }) {
      const status = validStatus(value);
      if (!status) return false;
      const startedAt = Date.now();
      try {
        const outcome = await deadline(cache.set(cacheKey(chatId, batchId), status, {
          ttl: ttlFor(status.status),
          tags: ['bess-dispatch-status'],
          name: `dispatch-${status.status.toLowerCase()}`,
        }).then(() => true), timeoutMs, false);
        log(outcome ? 'info' : 'warn', outcome ? 'write_ok' : 'write_timeout', {
          status: status.status,
          duration_ms: Date.now() - startedAt,
        });
        return outcome;
      } catch (error) {
        log('warn', 'write_error', {
          status: status.status,
          duration_ms: Date.now() - startedAt,
          error_code: clean(error?.code || error?.name || 'CACHE_WRITE_FAILED').slice(0, 80),
        });
        return false;
      }
    },
  };
}

export function queuedDispatchStatus({ operationId, requestIds = [] } = {}) {
  return {
    found: false,
    status: 'QUEUED',
    transient: true,
    operation_id: clean(operationId),
    request_ids: requestIds.map(String),
  };
}

export async function readDispatchStatusCache(statusCache, key) {
  try { return await statusCache?.get?.(key) || null; } catch { return null; }
}

export async function writeDispatchStatusCache(statusCache, payload) {
  try { return await statusCache?.set?.(payload) === true; } catch { return false; }
}
