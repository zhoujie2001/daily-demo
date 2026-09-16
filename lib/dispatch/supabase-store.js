import process from 'node:process';
import { createHash } from 'node:crypto';

export class DispatchStoreError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'DispatchStoreError';
    this.code = code;
    this.status = status;
  }
}

function clean(value) { return String(value || '').trim(); }

export function createSupabaseDispatchStore({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  claimTimeoutMs = 1800,
  statusTimeoutMs = 1200,
  logger = console,
} = {}) {
  const baseUrl = clean(url).replace(/\/+$/, '');
  const key = clean(serviceRoleKey);
  if (!baseUrl || !key) throw new DispatchStoreError('DISPATCH_DB_NOT_CONFIGURED', '派单数据库尚未配置', 503);

  function logDbRequest(level, fields) {
    const writer = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger?.log?.bind(logger);
    writer?.(JSON.stringify({
      event: 'dispatch_db_request',
      vercel_region: clean(process.env.VERCEL_REGION) || 'unknown',
      supabase_region: clean(process.env.SUPABASE_REGION) || 'unknown',
      ...fields,
    }));
  }

  async function request(path, { method = 'GET', body, prefer, requestTimeoutMs = timeoutMs } = {}) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const resource = String(path).split('?')[0].replace(/[^a-zA-Z0-9_/-]/g, '').slice(0, 96);
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, requestTimeoutMs));
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: key,
          ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
          Accept: 'application/json',
          'X-Client-Info': 'daily-demo-dispatch/1.0',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      const durationMs = Date.now() - startedAt;
      const requestId = clean(response.headers?.get?.('x-request-id') || response.headers?.get?.('sb-request-id'));
      if (!response.ok) {
        const error = new DispatchStoreError('DISPATCH_DB_ERROR', `派单数据库请求失败 (${response.status})`);
        error.httpStatus = response.status;
        error.dbCode = String(payload?.code || '');
        error.dbMessage = String(payload?.message || '');
        error.dbOperation = `${method} ${resource}`;
        error.durationMs = durationMs;
        error.requestId = requestId;
        logDbRequest('error', {
          outcome: 'http_error', operation: error.dbOperation, duration_ms: durationMs,
          timeout_ms: effectiveTimeoutMs, http_status: response.status, request_id: requestId,
        });
        throw error;
      }
      logDbRequest(durationMs >= 1000 ? 'warn' : 'info', {
        outcome: 'ok', operation: `${method} ${resource}`, duration_ms: durationMs,
        timeout_ms: effectiveTimeoutMs, http_status: response.status, request_id: requestId,
      });
      return payload;
    } catch (error) {
      if (error instanceof DispatchStoreError) throw error;
      const durationMs = Date.now() - startedAt;
      const timedOut = error?.name === 'AbortError';
      const wrapped = new DispatchStoreError(timedOut ? 'DISPATCH_DB_TIMEOUT' : 'DISPATCH_DB_ERROR', '派单数据库暂时不可用');
      wrapped.dbOperation = `${method} ${resource}`;
      wrapped.durationMs = durationMs;
      wrapped.timeoutMs = effectiveTimeoutMs;
      wrapped.causeName = clean(error?.name);
      logDbRequest('error', {
        outcome: timedOut ? 'timeout' : 'network_error', operation: wrapped.dbOperation,
        duration_ms: durationMs, timeout_ms: effectiveTimeoutMs, http_status: null,
        request_id: '', cause_name: wrapped.causeName,
      });
      throw wrapped;
    } finally { clearTimeout(timer); }
  }

  function batchStorageKey(chatId, batchId) {
    const digest = createHash('sha256').update(`${chatId}:${batchId}`).digest('hex').slice(0, 48);
    return { formMessageId: `bb_${digest}`, requestId: `batch_${digest}` };
  }

  function ingestStorageKey(chatId, batchId) {
    const digest = createHash('sha256').update(`${chatId}:${batchId}`).digest('hex').slice(0, 48);
    return { formMessageId: `bi_${digest}`, requestId: `ingest_${digest}` };
  }

  function parseBatchContext(row) {
    if (!row) return null;
    const context = typeof row.request_context === 'string'
      ? JSON.parse(row.request_context)
      : row.request_context;
    return context && typeof context === 'object' ? context : null;
  }

  function batchClaimResult(row, outcome) {
    const context = parseBatchContext(row);
    if (!context) throw new DispatchStoreError('INVALID_BATCH_STATE', '持久化批次状态无效');
    return {
      outcome,
      batch_status: context.status,
      results: Array.isArray(context.results) ? context.results : [],
      original_message_id: row.original_message_id,
      card_update_done: context.cardUpdateDone === true,
      thread_reply_done: context.threadReplyDone === true,
      result_message_id: clean(context.resultMessageId),
    };
  }

  async function getBatchRow(formMessageId) {
    const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}&select=*&limit=1`);
    return rows?.[0] || null;
  }

  async function patchBatchContext({ formMessageId, claimToken, expectedLeaseExpiresAt, context, completedAt }) {
    const leaseFilter = expectedLeaseExpiresAt === undefined
      ? ''
      : `&request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(expectedLeaseExpiresAt)}`;
    const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}&request_context-%3E%3EclaimToken=eq.${encodeURIComponent(claimToken)}${leaseFilter}`, {
      method: 'PATCH',
      body: {
        request_context: context,
        ...(completedAt === undefined ? {} : { completed_at: completedAt }),
      },
      prefer: 'return=representation',
    });
    if (!rows?.[0]) throw new DispatchStoreError('BATCH_CLAIM_LOST', '批次处理权已失效', 409);
    return rows[0];
  }

  async function getIngestBatchStatus({ chatId, batchId }) {
    const key = ingestStorageKey(chatId, batchId);
    const rows = await request(
      `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&select=form_message_id,request_context&limit=1`,
      { requestTimeoutMs: statusTimeoutMs },
    );
    const row = rows?.[0] || null;
    if (!row) return { found: false };
    const context = parseBatchContext(row);
    if (!context || context.kind !== 'dispatch_ingest') return { found: false };
    const status = String(context.status || '').toUpperCase();
    const leaseExpiresAt = String(context.leaseExpiresAt || '');
    const retryable = status === 'FAILED' || (status === 'SENDING'
      && (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.now()));
    return {
      found: true,
      status: status || 'UNKNOWN',
      retryable,
      operation_id: String(context.operationId || ''),
      message_id: String(context.messageId || ''),
      error_code: String(context.errorCode || ''),
      request_ids: Array.isArray(context.requestIds) ? context.requestIds.map(String) : [],
      lease_expires_at: leaseExpiresAt,
      next_retry_at: String(context.nextRetryAt || ''),
      attempt: Number(context.attempt || 0),
    };
  }

  function isMissingRpc(error) {
    return error instanceof DispatchStoreError
      && (error.httpStatus === 404 || error.dbCode === 'PGRST202');
  }

  function outboxContext({ batchId, fingerprint, requestIds, operationId, card, source, now }) {
    return {
      kind: 'dispatch_ingest', batchId, fingerprint, requestIds, operationId, card,
      source: clean(source).slice(0, 64), status: 'QUEUED', attempt: 0,
      nextRetryAt: now.toISOString(), leaseExpiresAt: null, workerToken: null,
      messageId: '', errorCode: '',
    };
  }

  async function enqueueDispatchOutboxLegacy({
    chatId, batchId, fingerprint, requestIds, operationId, card, source,
    now, expiresAt, requestTimeoutMs,
  }) {
    const key = ingestStorageKey(chatId, batchId);
    const context = outboxContext({ batchId, fingerprint, requestIds, operationId, card, source, now });
    const inserted = await request('bess_dispatch_pending_forms?on_conflict=form_message_id', {
      method: 'POST',
      body: {
        form_message_id: key.formMessageId, request_id: key.requestId,
        original_message_id: key.formMessageId, chat_id: chatId,
        request_context: context, expires_at: expiresAt,
      },
      prefer: 'resolution=ignore-duplicates,return=representation',
      requestTimeoutMs,
    });
    if (inserted?.[0]) {
      return { outcome: 'ACCEPTED', status: 'QUEUED', operation_id: operationId, message_id: '' };
    }
    const rows = await request(
      `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&select=*&limit=1`,
      { requestTimeoutMs },
    );
    const row = rows?.[0];
    const existing = parseBatchContext(row);
    if (!existing || existing.kind !== 'dispatch_ingest' || existing.fingerprint !== fingerprint) {
      return { outcome: 'CONFLICT', status: String(existing?.status || 'UNKNOWN'), operation_id: String(existing?.operationId || ''), message_id: '' };
    }
    if (existing.status === 'SENT') {
      return {
        outcome: 'COMPLETE', status: 'SENT',
        operation_id: String(existing.operationId || operationId),
        message_id: String(existing.messageId || ''),
      };
    }
    if (!existing.operationId) {
      const statusFilter = existing.status
        ? `&request_context-%3E%3Estatus=eq.${encodeURIComponent(existing.status)}`
        : '&request_context-%3E%3Estatus=is.null';
      const upgraded = await request(
        `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Efingerprint=eq.${encodeURIComponent(fingerprint)}${statusFilter}`,
        {
          method: 'PATCH', body: { request_context: context, completed_at: null, expires_at: expiresAt },
          prefer: 'return=representation', requestTimeoutMs,
        },
      );
      if (upgraded?.[0]) return { outcome: 'ACCEPTED', status: 'QUEUED', operation_id: operationId, message_id: '' };
      return { outcome: 'ACCEPTED', status: 'PROCESSING', operation_id: operationId, message_id: '' };
    }
    if (existing.operationId !== operationId) {
      return { outcome: 'CONFLICT', status: existing.status || 'UNKNOWN', operation_id: existing.operationId, message_id: '' };
    }
    return {
      outcome: 'ACCEPTED', status: String(existing.status || 'QUEUED'),
      operation_id: operationId, message_id: String(existing.messageId || ''),
      error_code: String(existing.errorCode || ''),
    };
  }

  async function claimDispatchOutboxLegacy({ workerToken, limit, leaseSeconds, maxAttempts, now, formMessageId = '' }) {
    const targetFilter = formMessageId
      ? `&form_message_id=eq.${encodeURIComponent(formMessageId)}`
      : '';
    const rows = await request(
      `bess_dispatch_pending_forms?request_context-%3E%3Ekind=eq.dispatch_ingest&completed_at=is.null${targetFilter}&select=*&order=created_at.asc&limit=100`,
    ) || [];
    const claimed = [];
    for (const row of rows) {
      if (claimed.length >= limit) break;
      const context = parseBatchContext(row);
      const attempt = Number.isInteger(Number(context?.attempt)) ? Number(context.attempt) : 0;
      const status = String(context?.status || '').toUpperCase();
      const nextRetryAt = Date.parse(String(context?.nextRetryAt || ''));
      const leaseExpiresAt = Date.parse(String(context?.leaseExpiresAt || ''));
      const due = ['QUEUED', 'RETRY'].includes(status)
        ? (!Number.isFinite(nextRetryAt) || nextRetryAt <= now.getTime())
        : status === 'PROCESSING' && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now.getTime());
      if (!context?.operationId || !context?.card || !due || attempt >= maxAttempts) continue;
      const previousWorker = context.workerToken == null
        ? '&request_context-%3E%3EworkerToken=is.null'
        : `&request_context-%3E%3EworkerToken=eq.${encodeURIComponent(context.workerToken)}`;
      const previousLease = context.leaseExpiresAt == null
        ? '&request_context-%3E%3EleaseExpiresAt=is.null'
        : `&request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(context.leaseExpiresAt)}`;
      const nextContext = {
        ...context, status: 'PROCESSING', workerToken,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        attempt: attempt + 1, startedAt: now.toISOString(),
      };
      const patched = await request(
        `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(row.form_message_id)}&request_context-%3E%3EoperationId=eq.${encodeURIComponent(context.operationId)}&request_context-%3E%3Estatus=eq.${encodeURIComponent(status)}${previousWorker}${previousLease}`,
        { method: 'PATCH', body: { request_context: nextContext }, prefer: 'return=representation' },
      );
      if (!patched?.[0]) continue;
      claimed.push({
        form_message_id: row.form_message_id, chat_id: row.chat_id,
        batch_id: String(context.batchId || ''), operation_id: context.operationId,
        request_ids: Array.isArray(context.requestIds) ? context.requestIds.map(String) : [],
        card: context.card, attempt: attempt + 1,
      });
    }
    return claimed;
  }

  async function patchDispatchOutboxLegacy({ formMessageId, workerToken, operationId, contextPatch, topLevel = {} }) {
    const rows = await request(
      `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}&select=*&limit=1`,
    );
    const row = rows?.[0];
    const context = parseBatchContext(row);
    if (!context || context.status !== 'PROCESSING' || context.workerToken !== workerToken || context.operationId !== operationId) {
      throw new DispatchStoreError('OUTBOX_CLAIM_LOST', 'Outbox 处理权已失效', 409);
    }
    const patched = await request(
      `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}&request_context-%3E%3Estatus=eq.PROCESSING&request_context-%3E%3EworkerToken=eq.${encodeURIComponent(workerToken)}&request_context-%3E%3EoperationId=eq.${encodeURIComponent(operationId)}`,
      {
        method: 'PATCH', body: { request_context: { ...context, ...contextPatch }, ...topLevel },
        prefer: 'return=representation',
      },
    );
    if (!patched?.[0]) throw new DispatchStoreError('OUTBOX_CLAIM_LOST', 'Outbox 处理权已失效', 409);
    return patched[0];
  }

  return {
    getIngestBatchStatus,
    async enqueueDispatchOutbox({ chatId, batchId, fingerprint, requestIds, operationId, card, source, now = new Date(), expiresAt }) {
      const key = ingestStorageKey(chatId, batchId);
      const args = { chatId, batchId, fingerprint, requestIds, operationId, card, source, now, expiresAt, requestTimeoutMs: claimTimeoutMs };
      try {
        const payload = await request('rpc/bess_enqueue_dispatch_outbox', {
          method: 'POST',
          body: {
            p_form_message_id: key.formMessageId, p_request_id: key.requestId,
            p_chat_id: chatId, p_batch_id: batchId, p_fingerprint: fingerprint,
            p_request_ids: requestIds, p_operation_id: operationId, p_card: card,
            p_source: clean(source).slice(0, 64), p_now: now.toISOString(), p_expires_at: expiresAt,
          },
          requestTimeoutMs: claimTimeoutMs,
        });
        const result = Array.isArray(payload) ? payload[0] : payload;
        if (!result?.outcome) throw new DispatchStoreError('INVALID_OUTBOX_STATE', 'Outbox 接单返回无效');
        return {
          outcome: String(result.outcome), status: String(result.status || 'QUEUED'),
          operation_id: String(result.operation_id || operationId), message_id: String(result.message_id || ''),
          error_code: String(result.error_code || ''),
        };
      } catch (error) {
        if (!isMissingRpc(error, 'bess_enqueue_dispatch_outbox')) throw error;
        return enqueueDispatchOutboxLegacy(args);
      }
    },
    async claimDispatchOutboxBatch({ chatId, batchId, workerToken, leaseSeconds = 45, maxAttempts = 8, now = new Date() }) {
      const key = ingestStorageKey(chatId, batchId);
      // Status recovery must target the requested batch even when the optional RPC
      // migration is installed; REST/CAS provides the same lease ownership checks.
      return claimDispatchOutboxLegacy({
        workerToken, limit: 1, leaseSeconds, maxAttempts, now,
        formMessageId: key.formMessageId,
      });
    },
    async claimDispatchOutbox({ workerToken, limit = 5, leaseSeconds = 45, maxAttempts = 8, now = new Date() }) {
      try {
        const payload = await request('rpc/bess_claim_dispatch_outbox', {
          method: 'POST',
          body: { p_worker_token: workerToken, p_limit: limit, p_lease_seconds: leaseSeconds, p_max_attempts: maxAttempts, p_now: now.toISOString() },
        });
        return (Array.isArray(payload) ? payload : []).map((row) => ({
          form_message_id: String(row.form_message_id || ''), chat_id: String(row.chat_id || ''),
          batch_id: String(row.batch_id || ''), operation_id: String(row.operation_id || ''),
          request_ids: Array.isArray(row.request_ids) ? row.request_ids.map(String) : [],
          card: row.card, attempt: Number(row.attempt || 0),
        }));
      } catch (error) {
        if (!isMissingRpc(error, 'bess_claim_dispatch_outbox')) throw error;
        return claimDispatchOutboxLegacy({ workerToken, limit, leaseSeconds, maxAttempts, now });
      }
    },
    async completeDispatchOutbox({ formMessageId, workerToken, operationId, messageId, completedAt = new Date() }) {
      try {
        const payload = await request('rpc/bess_complete_dispatch_outbox', {
          method: 'POST',
          body: { p_form_message_id: formMessageId, p_worker_token: workerToken, p_operation_id: operationId, p_message_id: messageId, p_completed_at: completedAt.toISOString() },
        });
        const result = Array.isArray(payload) ? payload[0] : payload;
        if (!result?.completed) throw new DispatchStoreError('OUTBOX_CLAIM_LOST', 'Outbox 完成写入失去租约', 409);
        return result;
      } catch (error) {
        if (!isMissingRpc(error, 'bess_complete_dispatch_outbox')) throw error;
        await patchDispatchOutboxLegacy({
          formMessageId, workerToken, operationId,
          contextPatch: { status: 'SENT', messageId, completedAt: completedAt.toISOString(), leaseExpiresAt: null, workerToken: null, errorCode: '', nextRetryAt: null, card: null },
          topLevel: { original_message_id: messageId, completed_at: completedAt.toISOString() },
        });
        return { completed: true };
      }
    },
    async retryDispatchOutbox({ formMessageId, workerToken, operationId, errorCode, nextRetryAt, dead = false }) {
      try {
        const payload = await request('rpc/bess_retry_dispatch_outbox', {
          method: 'POST',
          body: { p_form_message_id: formMessageId, p_worker_token: workerToken, p_operation_id: operationId, p_error_code: clean(errorCode).slice(0, 100), p_next_retry_at: nextRetryAt.toISOString(), p_dead: Boolean(dead) },
        });
        const result = Array.isArray(payload) ? payload[0] : payload;
        if (!result?.updated) throw new DispatchStoreError('OUTBOX_CLAIM_LOST', 'Outbox 重试写入失去租约', 409);
        return result;
      } catch (error) {
        if (!isMissingRpc(error, 'bess_retry_dispatch_outbox')) throw error;
        await patchDispatchOutboxLegacy({
          formMessageId, workerToken, operationId,
          contextPatch: { status: dead ? 'DEAD' : 'RETRY', errorCode: clean(errorCode).slice(0, 100), nextRetryAt: nextRetryAt.toISOString(), leaseExpiresAt: null, workerToken: null },
          topLevel: { completed_at: dead ? new Date().toISOString() : null },
        });
        return { updated: true };
      }
    },
    async nudgeDispatchOutbox({ chatId, batchId, now = new Date() }) {
      const key = ingestStorageKey(chatId, batchId);
      try {
        const payload = await request('rpc/bess_nudge_dispatch_outbox', {
          method: 'POST', body: { p_form_message_id: key.formMessageId, p_now: now.toISOString() }, requestTimeoutMs: statusTimeoutMs,
        });
        const result = Array.isArray(payload) ? payload[0] : payload;
        return Boolean(result?.nudged);
      } catch (error) {
        if (!isMissingRpc(error, 'bess_nudge_dispatch_outbox')) throw error;
        const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&select=*&limit=1`, { requestTimeoutMs: statusTimeoutMs });
        const context = parseBatchContext(rows?.[0]);
        const lease = Date.parse(String(context?.leaseExpiresAt || ''));
        if (context?.status !== 'PROCESSING' || (Number.isFinite(lease) && lease > now.getTime())) return false;
        const workerFilter = context.workerToken == null ? '&request_context-%3E%3EworkerToken=is.null' : `&request_context-%3E%3EworkerToken=eq.${encodeURIComponent(context.workerToken)}`;
        const leaseFilter = context.leaseExpiresAt == null ? '&request_context-%3E%3EleaseExpiresAt=is.null' : `&request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(context.leaseExpiresAt)}`;
        const patched = await request(
          `bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Estatus=eq.PROCESSING${workerFilter}${leaseFilter}`,
          { method: 'PATCH', body: { request_context: { ...context, status: 'RETRY', nextRetryAt: now.toISOString(), leaseExpiresAt: null, workerToken: null } }, prefer: 'return=representation', requestTimeoutMs: statusTimeoutMs },
        );
        return Boolean(patched?.[0]);
      }
    },
    async cleanupExpired(now = new Date()) {
      const at = encodeURIComponent(now.toISOString());
      await Promise.all([
        request(`bess_dispatch_pending_forms?expires_at=lte.${at}`, { method: 'DELETE' }),
        request(`bess_dispatch_daily_state?expires_at=lte.${at}`, { method: 'DELETE' }),
      ]);
    },
    async claimIngestBatch({ chatId, batchId, fingerprint, requestIds, now = new Date(), expiresAt }) {
      const key = ingestStorageKey(chatId, batchId);
      const leaseExpiresAt = new Date(now.getTime() + 90 * 1000).toISOString();
      const startedAt = Date.now();
      const remaining = () => Math.max(1, claimTimeoutMs - (Date.now() - startedAt));
      const context = {
        kind: 'dispatch_ingest', batchId, fingerprint, requestIds,
        status: 'SENDING', leaseExpiresAt,
      };

      try {
        const payload = await request('rpc/bess_claim_ingest', {
          method: 'POST',
          body: {
            p_form_message_id: key.formMessageId,
            p_request_id: key.requestId,
            p_chat_id: chatId,
            p_batch_id: batchId,
            p_fingerprint: fingerprint,
            p_request_ids: requestIds,
            p_lease_expires_at: leaseExpiresAt,
            p_expires_at: expiresAt,
          },
          requestTimeoutMs: Math.min(1200, remaining()),
        });
        const result = Array.isArray(payload) ? payload[0] : payload;
        if (!result?.outcome) throw new DispatchStoreError('INVALID_INGEST_STATE', '原子接单返回无效');
        const outcome = String(result.outcome).toUpperCase();
        return {
          outcome,
          lease_expires_at: ['CLAIMED', 'RESUMED'].includes(outcome)
            ? leaseExpiresAt
            : String(result.lease_expires_at || ''),
          message_id: String(result.message_id || ''),
        };
      } catch (error) {
        const missingRpc = error instanceof DispatchStoreError
          && (error.httpStatus === 404 || error.dbCode === 'PGRST202')
          && /bess_claim_ingest/i.test(error.dbMessage);
        if (!missingRpc) throw error;
      }

      // 旧 schema 仅用于短期兼容。所有往返共享 claimTimeoutMs 总预算，
      // 宁可快速失败让调用方稍后重试，也绝不把 HTTP 请求拖到 30 秒。
      const legacyRequest = (path, options = {}) => {
        if (remaining() <= 1) throw new DispatchStoreError('DISPATCH_DB_TIMEOUT', '旧版接单已超过总时限', 503);
        return request(path, { ...options, requestTimeoutMs: remaining() });
      };
      const inserted = await legacyRequest('bess_dispatch_pending_forms?on_conflict=form_message_id', {
        method: 'POST',
        body: {
          form_message_id: key.formMessageId, request_id: key.requestId,
          original_message_id: key.formMessageId, chat_id: chatId,
          request_context: context, expires_at: expiresAt,
        },
        prefer: 'resolution=ignore-duplicates,return=representation',
      });
      if (inserted?.[0]) return { outcome: 'CLAIMED', lease_expires_at: leaseExpiresAt };
      const rows = await legacyRequest(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&select=*&limit=1`);
      const row = rows?.[0] || null;
      const existing = parseBatchContext(row);
      if (!existing || existing.kind !== 'dispatch_ingest') {
        throw new DispatchStoreError('INVALID_INGEST_STATE', '发送幂等状态无效', 409);
      }
      if (existing.fingerprint !== fingerprint) return { outcome: 'CONFLICT' };
      if (existing.status === 'SENT') return { outcome: 'COMPLETE', message_id: existing.messageId || '' };
      const currentLease = Date.parse(String(existing.leaseExpiresAt || ''));
      if (existing.status === 'SENDING' && Number.isFinite(currentLease) && currentLease > now.getTime()) {
        return { outcome: 'IN_FLIGHT', lease_expires_at: existing.leaseExpiresAt };
      }
      const leaseFilter = existing.leaseExpiresAt
        ? `eq.${encodeURIComponent(existing.leaseExpiresAt)}`
        : 'is.null';
      const resumed = await legacyRequest(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Efingerprint=eq.${encodeURIComponent(fingerprint)}&request_context-%3E%3Estatus=eq.${encodeURIComponent(existing.status)}&request_context-%3E%3EleaseExpiresAt=${leaseFilter}`, {
        method: 'PATCH', body: { request_context: context }, prefer: 'return=representation',
      });
      if (resumed?.[0]) return { outcome: 'RESUMED', lease_expires_at: leaseExpiresAt };
      throw new DispatchStoreError('INGEST_CLAIM_LOST', '发送幂等状态已被并发修改', 409);
    },
    async completeIngestBatch({ chatId, batchId, fingerprint, requestIds = [], messageId, expectedLeaseExpiresAt, completedAt = new Date() }) {
      const key = ingestStorageKey(chatId, batchId);
      const leaseFilter = expectedLeaseExpiresAt
        ? `&request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(expectedLeaseExpiresAt)}`
        : '';
      const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Efingerprint=eq.${encodeURIComponent(fingerprint)}&request_context-%3E%3Estatus=eq.SENDING${leaseFilter}`, {
        method: 'PATCH',
        body: {
          request_context: {
            kind: 'dispatch_ingest', batchId, fingerprint, requestIds,
            status: 'SENT', messageId, leaseExpiresAt: completedAt.toISOString(),
          },
          original_message_id: messageId,
          completed_at: completedAt.toISOString(),
        },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw new DispatchStoreError('INGEST_CLAIM_LOST', '发送幂等状态已失效', 409);
      return rows[0];
    },
    async failIngestBatch({ chatId, batchId, fingerprint, requestIds = [], errorCode, expectedLeaseExpiresAt, failedAt = new Date() }) {
      const key = ingestStorageKey(chatId, batchId);
      const leaseFilter = expectedLeaseExpiresAt
        ? `&request_context-%3E%3EleaseExpiresAt=eq.${encodeURIComponent(expectedLeaseExpiresAt)}`
        : '';
      const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Efingerprint=eq.${encodeURIComponent(fingerprint)}&request_context-%3E%3Estatus=eq.SENDING${leaseFilter}`, {
        method: 'PATCH',
        body: {
          request_context: {
            kind: 'dispatch_ingest', batchId, fingerprint, requestIds,
            status: 'FAILED', errorCode: clean(errorCode).slice(0, 100),
            leaseExpiresAt: failedAt.toISOString(),
          },
        },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw new DispatchStoreError('INGEST_CLAIM_LOST', '发送幂等状态已失效', 409);
      return rows[0];
    },
    async claimBatch({ chatId, batchId, fingerprint, items, originalMessageId, claimToken, now = new Date(), leaseExpiresAt, expiresAt }) {
      const key = batchStorageKey(chatId, batchId);
      const initialContext = {
        kind: 'batch_dispatch', batchId, fingerprint, items,
        status: 'PROCESSING', results: [], claimToken, leaseExpiresAt,
        cardUpdateDone: false, cardUpdateError: null,
        threadReplyDone: false, threadReplyError: null,
        resultMessageId: '',
      };
      const inserted = await request(`bess_dispatch_pending_forms?on_conflict=form_message_id`, {
        method: 'POST',
        body: {
          form_message_id: key.formMessageId,
          request_id: key.requestId,
          original_message_id: originalMessageId,
          chat_id: chatId,
          request_context: initialContext,
          expires_at: expiresAt,
        },
        prefer: 'resolution=ignore-duplicates,return=representation',
      });
      if (inserted?.[0]) return batchClaimResult(inserted[0], 'CLAIMED');

      let row = await getBatchRow(key.formMessageId);
      let context = parseBatchContext(row);
      if (!row || context?.kind !== 'batch_dispatch') {
        throw new DispatchStoreError('INVALID_BATCH_STATE', '批次幂等记录不存在或格式无效');
      }
      if (context.fingerprint !== fingerprint) return batchClaimResult(row, 'CONFLICT');
      if (context.status === 'SUCCESS' && context.cardUpdateDone === true && context.threadReplyDone === true) {
        return batchClaimResult(row, 'COMPLETE');
      }
      if (new Date(context.leaseExpiresAt).getTime() > now.getTime()) {
        return batchClaimResult(row, 'IN_FLIGHT');
      }

      const previousClaimToken = context.claimToken;
      const previousLeaseExpiresAt = context.leaseExpiresAt;
      context = { ...context, claimToken, leaseExpiresAt };
      try {
        row = await patchBatchContext({
          formMessageId: key.formMessageId,
          claimToken: previousClaimToken,
          expectedLeaseExpiresAt: previousLeaseExpiresAt,
          context,
        });
        return batchClaimResult(row, 'RESUMED');
      } catch (error) {
        if (!(error instanceof DispatchStoreError) || error.code !== 'BATCH_CLAIM_LOST') throw error;
        row = await getBatchRow(key.formMessageId);
        context = parseBatchContext(row);
        if (context?.fingerprint !== fingerprint) return batchClaimResult(row, 'CONFLICT');
        if (context?.status === 'SUCCESS' && context?.cardUpdateDone === true && context?.threadReplyDone === true) {
          return batchClaimResult(row, 'COMPLETE');
        }
        return batchClaimResult(row, 'IN_FLIGHT');
      }
    },
    async saveBatchProgress({ chatId, batchId, claimToken, status, results, leaseExpiresAt }) {
      const key = batchStorageKey(chatId, batchId);
      const row = await getBatchRow(key.formMessageId);
      const context = parseBatchContext(row);
      if (!context || context.claimToken !== claimToken) {
        throw new DispatchStoreError('BATCH_CLAIM_LOST', '批次处理权已失效', 409);
      }
      return patchBatchContext({
        formMessageId: key.formMessageId,
        claimToken,
        context: { ...context, status, results, leaseExpiresAt },
      });
    },
    async markBatchFinalization({ chatId, batchId, claimToken, effect, succeeded, errorCode = '' }) {
      if (!['card', 'thread'].includes(effect)) {
        throw new DispatchStoreError('INVALID_BATCH_EFFECT', '批次收尾副作用类型无效', 400);
      }
      const key = batchStorageKey(chatId, batchId);
      const row = await getBatchRow(key.formMessageId);
      const context = parseBatchContext(row);
      if (!context || context.claimToken !== claimToken) {
        throw new DispatchStoreError('BATCH_CLAIM_LOST', '批次处理权已失效', 409);
      }
      const doneField = effect === 'card' ? 'cardUpdateDone' : 'threadReplyDone';
      const errorField = effect === 'card' ? 'cardUpdateError' : 'threadReplyError';
      const nextContext = {
        ...context,
        [doneField]: Boolean(succeeded),
        [errorField]: succeeded ? null : String(errorCode || 'UNKNOWN').slice(0, 100),
      };
      const allDone = nextContext.cardUpdateDone === true && nextContext.threadReplyDone === true;
      return patchBatchContext({
        formMessageId: key.formMessageId,
        claimToken,
        context: nextContext,
        completedAt: allDone ? new Date().toISOString() : null,
      });
    },
    async saveBatchResultMessage({ chatId, batchId, claimToken, messageId }) {
      const key = batchStorageKey(chatId, batchId);
      const row = await getBatchRow(key.formMessageId);
      const context = parseBatchContext(row);
      if (!context || context.claimToken !== claimToken) {
        throw new DispatchStoreError('BATCH_CLAIM_LOST', '批次处理权已失效', 409);
      }
      return patchBatchContext({
        formMessageId: key.formMessageId,
        claimToken,
        context: { ...context, resultMessageId: clean(messageId) },
      });
    },
    async releaseBatchClaim({ chatId, batchId, claimToken, releasedAt = new Date() }) {
      const key = batchStorageKey(chatId, batchId);
      const row = await getBatchRow(key.formMessageId);
      const context = parseBatchContext(row);
      if (!context || context.claimToken !== claimToken) {
        throw new DispatchStoreError('BATCH_CLAIM_LOST', '批次处理权已失效', 409);
      }
      return patchBatchContext({
        formMessageId: key.formMessageId,
        claimToken,
        context: { ...context, leaseExpiresAt: releasedAt.toISOString() },
      });
    },
    async getDailyState(day, now = new Date()) {
      const rows = await request(`bess_dispatch_daily_state?day_key=eq.${encodeURIComponent(day)}&expires_at=gt.${encodeURIComponent(now.toISOString())}&select=*&limit=1`);
      return rows?.[0] || null;
    },
    async getPendingByRequest(requestId, chatId, now = new Date()) {
      const rows = await request(`bess_dispatch_pending_forms?request_id=eq.${encodeURIComponent(requestId)}&chat_id=eq.${encodeURIComponent(chatId)}&expires_at=gt.${encodeURIComponent(now.toISOString())}&completed_at=is.null&select=*&limit=1`);
      return rows?.[0] || null;
    },
    async savePending(pending) {
      const rows = await request('bess_dispatch_pending_forms?on_conflict=form_message_id', {
        method: 'POST', body: pending, prefer: 'resolution=merge-duplicates,return=representation',
      });
      return rows?.[0] || pending;
    },
    async getPending(formMessageId, now = new Date(), { includeCompleted = false } = {}) {
      const completedFilter = includeCompleted ? '' : '&completed_at=is.null';
      const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}&expires_at=gt.${encodeURIComponent(now.toISOString())}${completedFilter}&select=*&limit=1`);
      return rows?.[0] || null;
    },
    async markPendingCompleted(formMessageId, completedAt = new Date()) {
      const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(formMessageId)}`, {
        method: 'PATCH',
        body: { completed_at: completedAt.toISOString() },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw new DispatchStoreError('PENDING_FORM_NOT_FOUND', '待处理表单不存在');
      return rows[0];
    },
    async getAssignment(dayKey, requestId) {
      const rows = await request(`bess_dispatch_assignments?day_key=eq.${encodeURIComponent(dayKey)}&request_id=eq.${encodeURIComponent(requestId)}&select=*&limit=1`);
      return rows?.[0] || null;
    },
    async getDailyAssignments(dayKey) {
      // created_at is the durable automatic-dispatch order. Context is filtered
      // by the service because project/sheet keys live in existing JSONB data.
      return await request(`bess_dispatch_assignments?day_key=eq.${encodeURIComponent(dayKey)}&select=*&order=created_at.desc,id.desc`) || [];
    },
    async calibrateCursor({ dayKey, assignee, roster }) {
      const normalizedAssignee = String(assignee || '').trim();
      const normalizedRoster = Array.isArray(roster) ? roster.map((name) => String(name || '').trim()) : [];
      const assigneeIndex = normalizedRoster.indexOf(normalizedAssignee);
      if (!dayKey || !normalizedAssignee || normalizedRoster.length === 0 || assigneeIndex < 0) {
        throw new DispatchStoreError('INVALID_CURSOR_CALIBRATION', '派单游标校准参数无效', 400);
      }
      try {
        const rows = await request('rpc/bess_calibrate_cursor', {
          method: 'POST',
          body: { p_day_key: dayKey, p_assignee: normalizedAssignee, p_roster: normalizedRoster },
        });
        const state = Array.isArray(rows) ? rows[0] : rows;
        if (!state) throw new DispatchStoreError('DAILY_STATE_NOT_FOUND', '当天派单状态不存在');
        return state;
      } catch (error) {
        const missingRpc = error instanceof DispatchStoreError
          && (error.httpStatus === 404 || error.dbCode === 'PGRST202' || /bess_calibrate_cursor/i.test(error.dbMessage));
        if (!missingRpc) throw error;
      }

      // Compatibility path for deployments where PostgREST has not exposed the
      // calibration RPC yet.  Compare-and-swap on the existing state row keeps
      // calibration from silently overwriting a concurrent cursor movement.
      // A conflict is fail-closed; callers can retry and re-read the sheet.
      const currentRows = await request(`bess_dispatch_daily_state?day_key=eq.${encodeURIComponent(dayKey)}&select=*&limit=1`);
      const current = currentRows?.[0];
      if (!current) throw new DispatchStoreError('DAILY_STATE_NOT_FOUND', '当天派单状态不存在');
      if (JSON.stringify(current.roster) !== JSON.stringify(normalizedRoster)) {
        throw new DispatchStoreError('ROSTER_CHANGED', '今日派单名单已变化，请重试', 409);
      }
      const rows = await request(`bess_dispatch_daily_state?day_key=eq.${encodeURIComponent(dayKey)}&forward_cursor=eq.${encodeURIComponent(current.forward_cursor)}&reverse_cursor=eq.${encodeURIComponent(current.reverse_cursor)}&roster=eq.${encodeURIComponent(JSON.stringify(normalizedRoster))}`, {
        method: 'PATCH',
        body: {
          forward_cursor: assigneeIndex + 1,
          reverse_cursor: normalizedRoster.length - assigneeIndex,
          updated_at: new Date().toISOString(),
        },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw new DispatchStoreError('CURSOR_CALIBRATION_CONFLICT', '派单游标已被并发更新，请重试', 409);
      return rows[0];
    },
    async updateRosterStatus({ dayKey, offDuty, expectedVersion }) {
      if (!dayKey || !Array.isArray(offDuty)) {
        throw new DispatchStoreError('INVALID_STATUS_UPDATE', '更新人员状态参数无效', 400);
      }
      const rows = await request('rpc/bess_update_roster_status', {
        method: 'POST',
        body: {
          p_day_key: dayKey,
          p_off_duty: offDuty,
          p_expected_version: expectedVersion,
        },
      });
      const state = Array.isArray(rows) ? rows[0] : rows;
      if (!state) throw new DispatchStoreError('STATUS_UPDATE_CONFLICT', '人员状态已被并发更新，请重试', 409);
      return state;
    },
    async assign({ dayKey, requestId, direction, roster, expiresAt, context }) {
      const rows = await request('rpc/bess_assign_next', {
        method: 'POST',
        body: {
          p_day_key: dayKey, p_request_id: requestId, p_direction: direction,
          p_roster: roster || null, p_expires_at: expiresAt, p_context: context,
        },
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },
  };
}
