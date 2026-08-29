// Minimal Feishu/Lark OpenAPI client for the BESS dispatch callback.
// Only covers the P0 scope: tenant token, reply message (create thread),
// reading the original interactive message, and actively updating its card.
//
// Security notes:
// - App secret is only read through the injected accessor and never logged.
// - fetchImpl / baseUrl are injectable so tests never hit the real API.

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const TOKEN_REFRESH_MARGIN_MS = 3 * 60 * 1000;

export class LarkApiError extends Error {
  constructor(code, message, { httpStatus, endpoint } = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
  }
}

function resolveValue(value) {
  return typeof value === 'function' ? value() : value;
}

export class LarkClient {
  constructor({
    appId,
    appSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl,
    timeoutMs = 6000,
    now = Date.now,
  } = {}) {
    this.getAppId = typeof appId === 'function' ? appId : () => appId;
    this.getAppSecret = typeof appSecret === 'function' ? appSecret : () => appSecret;
    this.getBaseUrl = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;
    // Resolved lazily in request() so tests can stub globalThis.fetch after
    // the client was constructed.
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.tokenCache = null;
  }

  async request(method, pathname, { query, body, token, timeoutMs } = {}) {
    const baseUrl = String(resolveValue(this.getBaseUrl()) || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(pathname, `${baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    const fetchImpl = this.fetchImpl || globalThis.fetch;
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new LarkApiError('LARK_API_TIMEOUT', `Lark API timeout: ${pathname}`, { endpoint: pathname });
      }
      throw new LarkApiError('LARK_API_NETWORK', `Lark API network error: ${pathname}`, { endpoint: pathname });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new LarkApiError(
        'LARK_API_HTTP_ERROR',
        `Lark API HTTP ${response.status}`,
        { httpStatus: response.status, endpoint: pathname },
      );
    }
    if (!payload || payload.code !== 0) {
      throw new LarkApiError(
        payload?.code != null ? `LARK_API_${payload.code}` : 'LARK_API_BAD_RESPONSE',
        typeof payload?.msg === 'string' && payload.msg ? payload.msg : 'Lark API returned an error',
        { httpStatus: response.status, endpoint: pathname },
      );
    }
    return payload;
  }

  async getTenantAccessToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > this.now()) {
      return this.tokenCache.token;
    }

    const appId = this.getAppId();
    const appSecret = this.getAppSecret();
    if (!appId || !appSecret) {
      throw new LarkApiError('MISSING_APP_CREDENTIALS', 'LARK_APP_ID / LARK_APP_SECRET not configured');
    }

    const payload = await this.request(
      'POST',
      '/open-apis/auth/v3/tenant_access_token/internal',
      { body: { app_id: appId, app_secret: appSecret }, timeoutMs: Math.min(this.timeoutMs, 4000) },
    );
    const token = typeof payload.tenant_access_token === 'string' ? payload.tenant_access_token : '';
    if (!token) {
      throw new LarkApiError('LARK_API_BAD_RESPONSE', 'tenant_access_token missing in response');
    }
    const expireSeconds = Number(payload.expire) || 7200;
    this.tokenCache = {
      token,
      expiresAt: this.now() + expireSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
    return token;
  }

  // Reply to the original card and explicitly create a thread rooted at it.
  // A plain reply is not promoted to a topic unless reply_in_thread is true.
  async replyMessage({ messageId, msgType, content, uuid, replyInThread = true }) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        body: {
          msg_type: msgType,
          content: typeof content === 'string' ? content : JSON.stringify(content),
          reply_in_thread: replyInThread,
          ...(uuid ? { uuid } : {}),
        },
        token,
      },
    );
    return payload.data || {};
  }

  // Update the card after acknowledging card.action.trigger. Feishu requires
  // this delayed-update API to run after the callback response has been sent;
  // the callback token is valid for 30 minutes and can be used at most twice.
  async delayUpdateMessageCard(cardUpdateToken, card) {
    const token = await this.getTenantAccessToken();
    await this.request(
      'POST',
      '/open-apis/interactive/v1/card/update',
      {
        body: {
          token: cardUpdateToken,
          card,
        },
        token,
      },
    );
  }

  // Unconditionally replace an interactive message by message ID. This is
  // retained for non-callback update scenarios; callback-triggered updates
  // should prefer delayUpdateMessageCard().
  async updateMessageCard(messageId, card) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request(
      'PATCH',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        body: {
          content: JSON.stringify(card),
        },
        token,
      },
    );
    return payload.data || {};
  }

  // Read a message so we can patch the original Card 2.0 JSON in the
  // synchronous callback response (card.action.trigger does not include it).
  async getMessage(messageId) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request(
      'GET',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { token },
    );
    const items = payload.data?.items || [];
    return items[0] || null;
  }

  async replyInteractiveCard({ messageId, card, uuid, replyInThread = true }) {
    return this.replyMessage({ messageId, msgType: 'interactive', content: card, uuid, replyInThread });
  }

  getSpreadsheetToken(sheetUrl) {
    let parsed;
    try { parsed = new URL(sheetUrl); } catch { throw new LarkApiError('INVALID_SHEET_URL', '无效的飞书电子表格地址'); }
    const match = parsed.pathname.match(/\/sheets\/([^/?]+)/);
    if (!match) throw new LarkApiError('INVALID_SHEET_URL', '无法从地址识别电子表格 token');
    return match[1];
  }

  async getSheetValues({ sheetUrl, range }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = this.getSpreadsheetToken(sheetUrl);
    const payload = await this.request('GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
    return payload.data?.valueRange?.values || [];
  }

  async writeSheetAssignee({ sheetUrl, sheetId, rowIndex, assigneeFieldId, assigneeFieldName, assignee }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = this.getSpreadsheetToken(sheetUrl);
    let column = String(assigneeFieldId || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(column)) {
      if (!assigneeFieldName) throw new LarkApiError('INVALID_ASSIGNEE_FIELD', '负责人列配置缺失');
      const headers = await this.getSheetValues({ sheetUrl, range: `${sheetId}!1:1` });
      const index = (headers[0] || []).findIndex((value) => String(value).trim() === String(assigneeFieldName).trim());
      if (index < 0) throw new LarkApiError('ASSIGNEE_FIELD_NOT_FOUND', '找不到负责人字段');
      let value = index + 1;
      column = '';
      while (value > 0) { value -= 1; column = String.fromCharCode(65 + (value % 26)) + column; value = Math.floor(value / 26); }
    }
    const range = `${sheetId}!${column}${rowIndex}:${column}${rowIndex}`;
    await this.request('PUT', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`, {
      token, body: { valueRange: { range, values: [[assignee]] } },
    });
    const values = await this.getSheetValues({ sheetUrl, range });
    if (values?.[0]?.[0] !== assignee) throw new LarkApiError('SHEET_READBACK_MISMATCH', '电子表格写入回读不一致');
    return { range, assignee };
  }
}
