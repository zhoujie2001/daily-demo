import process from 'node:process';

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
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) throw new DispatchStoreError('DISPATCH_DB_ERROR', `派单数据库请求失败 (${response.status})`);
      return payload;
    } catch (error) {
      if (error instanceof DispatchStoreError) throw error;
      throw new DispatchStoreError(error?.name === 'AbortError' ? 'DISPATCH_DB_TIMEOUT' : 'DISPATCH_DB_ERROR', '派单数据库暂时不可用');
    } finally { clearTimeout(timer); }
  }

  return {
    async cleanupExpired(now = new Date()) {
      const at = encodeURIComponent(now.toISOString());
      await Promise.all([
        request(`bess_dispatch_pending_forms?expires_at=lte.${at}`, { method: 'DELETE' }),
        request(`bess_dispatch_daily_state?expires_at=lte.${at}`, { method: 'DELETE' }),
      ]);
    },
    async getDailyState(day, now = new Date()) {
      const rows = await request(`bess_dispatch_daily_state?day_key=eq.${encodeURIComponent(day)}&expires_at=gt.${encodeURIComponent(now.toISOString())}&select=*&limit=1`);
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
    async calibrateCursor({ dayKey, direction, cursor }) {
      if (!['forward', 'reverse'].includes(direction) || !Number.isInteger(cursor) || cursor < 0) {
        throw new DispatchStoreError('INVALID_CURSOR_CALIBRATION', '派单游标校准参数无效', 400);
      }
      const field = direction === 'forward' ? 'forward_cursor' : 'reverse_cursor';
      const rows = await request(`bess_dispatch_daily_state?day_key=eq.${encodeURIComponent(dayKey)}`, {
        method: 'PATCH', body: { [field]: cursor }, prefer: 'return=representation',
      });
      if (!rows?.[0]) throw new DispatchStoreError('DAILY_STATE_NOT_FOUND', '当天派单状态不存在');
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
