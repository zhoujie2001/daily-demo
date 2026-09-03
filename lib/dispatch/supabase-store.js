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
} = {}) {
  const baseUrl = clean(url).replace(/\/+$/, '');
  const key = clean(serviceRoleKey);
  if (!baseUrl || !key) throw new DispatchStoreError('DISPATCH_DB_NOT_CONFIGURED', '派单数据库尚未配置', 503);

  async function request(path, { method = 'GET', body, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: key,
          ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!response.ok) {
        const error = new DispatchStoreError('DISPATCH_DB_ERROR', `派单数据库请求失败 (${response.status})`);
        error.httpStatus = response.status;
        error.dbCode = String(payload?.code || '');
        error.dbMessage = String(payload?.message || '');
        throw error;
      }
      return payload;
    } catch (error) {
      if (error instanceof DispatchStoreError) throw error;
      throw new DispatchStoreError(error?.name === 'AbortError' ? 'DISPATCH_DB_TIMEOUT' : 'DISPATCH_DB_ERROR', '派单数据库暂时不可用');
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

  return {
    async cleanupExpired(now = new Date()) {
      const at = encodeURIComponent(now.toISOString());
      await Promise.all([
        request(`bess_dispatch_pending_forms?expires_at=lte.${at}`, { method: 'DELETE' }),
        request(`bess_dispatch_daily_state?expires_at=lte.${at}`, { method: 'DELETE' }),
      ]);
    },
    async claimIngestBatch({ chatId, batchId, fingerprint, requestIds, expiresAt }) {
      const key = ingestStorageKey(chatId, batchId);
      const context = { kind: 'dispatch_ingest', batchId, fingerprint, requestIds, status: 'SENDING' };
      const inserted = await request('bess_dispatch_pending_forms?on_conflict=form_message_id', {
        method: 'POST',
        body: {
          form_message_id: key.formMessageId, request_id: key.requestId,
          original_message_id: key.formMessageId, chat_id: chatId,
          request_context: context, expires_at: expiresAt,
        },
        prefer: 'resolution=ignore-duplicates,return=representation',
      });
      if (inserted?.[0]) return { outcome: 'CLAIMED' };
      const row = await getBatchRow(key.formMessageId);
      const existing = parseBatchContext(row);
      if (!existing || existing.kind !== 'dispatch_ingest') {
        throw new DispatchStoreError('INVALID_INGEST_STATE', '发送幂等状态无效', 409);
      }
      if (existing.fingerprint !== fingerprint) return { outcome: 'CONFLICT' };
      return {
        outcome: existing.status === 'SENT' ? 'COMPLETE' : 'IN_FLIGHT',
        message_id: existing.messageId || '',
      };
    },
    async completeIngestBatch({ chatId, batchId, fingerprint, messageId, completedAt = new Date() }) {
      const key = ingestStorageKey(chatId, batchId);
      const rows = await request(`bess_dispatch_pending_forms?form_message_id=eq.${encodeURIComponent(key.formMessageId)}&request_context-%3E%3Efingerprint=eq.${encodeURIComponent(fingerprint)}`, {
        method: 'PATCH',
        body: {
          request_context: { kind: 'dispatch_ingest', batchId, fingerprint, status: 'SENT', messageId },
          original_message_id: messageId,
          completed_at: completedAt.toISOString(),
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
