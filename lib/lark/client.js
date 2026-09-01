// Minimal Feishu/Lark OpenAPI client for the BESS dispatch callback.
// Only covers the P0 scope: tenant token, reply message (create thread),
// reading the original interactive message, and actively updating its card.
//
// Security notes:
// - App secret is only read through the injected accessor and never logged.
// - fetchImpl / baseUrl are injectable so tests never hit the real API.

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const TOKEN_REFRESH_MARGIN_MS = 3 * 60 * 1000;
const SHEET_SCAN_CHUNK_ROWS = 5000;
const MAX_SHEET_SCAN_ROWS = 20000;

export class LarkApiError extends Error {
  constructor(code, message, { httpStatus, endpoint, apiCode, apiMessage, logId } = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
    this.apiCode = apiCode;
    this.apiMessage = apiMessage;
    this.logId = logId;
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
      const apiCode = payload?.code;
      const apiMessage = typeof payload?.msg === 'string' ? payload.msg : '';
      throw new LarkApiError(
        apiCode != null ? `LARK_API_${apiCode}` : 'LARK_API_HTTP_ERROR',
        apiMessage || `Lark API HTTP ${response.status}`,
        {
          httpStatus: response.status,
          endpoint: pathname,
          apiCode,
          apiMessage,
          logId: typeof payload?.error?.log_id === 'string' ? payload.error.log_id : '',
        },
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

  async sendMessage({ receiveId, receiveIdType = 'chat_id', msgType, content, uuid }) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: receiveIdType },
      body: {
        receive_id: receiveId,
        msg_type: msgType,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        ...(uuid ? { uuid } : {}),
      },
      token,
    });
    return payload.data || {};
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

  parseSpreadsheetUrl(sheetUrl) {
    let parsed;
    try { parsed = new URL(sheetUrl); } catch { throw new LarkApiError('INVALID_SHEET_URL', '无效的飞书电子表格地址'); }
    const sheetMatch = parsed.pathname.match(/\/(?:sheets|spreadsheets)\/([^/?]+)/);
    if (sheetMatch) return { type: 'sheet', token: sheetMatch[1] };
    const wikiMatch = parsed.pathname.match(/\/wiki\/([^/?]+)/);
    if (wikiMatch) return { type: 'wiki', token: wikiMatch[1] };
    throw new LarkApiError('INVALID_SHEET_URL', '无法从地址识别电子表格或知识库 token');
  }

  async resolveSpreadsheetToken(sheetUrl, token) {
    const target = this.parseSpreadsheetUrl(sheetUrl);
    if (target.type === 'sheet') return target.token;

    const payload = await this.request('GET', '/open-apis/wiki/v2/spaces/get_node', {
      query: { token: target.token }, token,
    });
    const node = payload.data?.node;
    const objectType = String(node?.obj_type || '').toLowerCase();
    const objectToken = String(node?.obj_token || '').trim();
    if (!['sheet', 'sheets', 'spreadsheet'].includes(objectType) || !objectToken) {
      throw new LarkApiError('WIKI_NODE_NOT_SHEET', '该知识库链接指向的不是飞书电子表格');
    }
    return objectToken;
  }

  async getSheetValues({ sheetUrl, range }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    const payload = await this.request('GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
    return payload.data?.valueRange?.values || [];
  }

  async resolveSheetColumn({ sheetUrl, sheetId, fieldId, fieldName, spreadsheetToken, token }) {
    const direct = String(fieldId || '').trim().toUpperCase();
    if (/^[A-Z]{1,3}$/.test(direct)) return direct;
    if (!fieldName) throw new LarkApiError('INVALID_SHEET_FIELD', '表格列配置缺失');
    const resolvedToken = spreadsheetToken || await this.resolveSpreadsheetToken(sheetUrl, token);
    const payload = await this.request(
      'GET',
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(resolvedToken)}/values/${encodeURIComponent(`${sheetId}!1:1`)}`,
      { token },
    );
    const headers = payload.data?.valueRange?.values?.[0] || [];
    const index = headers.findIndex((value) => String(value).trim() === String(fieldName).trim());
    if (index < 0) throw new LarkApiError('SHEET_FIELD_NOT_FOUND', `找不到表格字段：${fieldName}`);
    let value = index + 1;
    let column = '';
    while (value > 0) {
      value -= 1;
      column = String.fromCharCode(65 + (value % 26)) + column;
      value = Math.floor(value / 26);
    }
    return column;
  }

  async readSheetDispatchRows({
    sheetUrl, sheetId, dateFieldId, dateFieldName, assigneeFieldId, assigneeFieldName,
    projectFieldId, projectFieldName, selectLatest,
  }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    const hasProjectColumn = Boolean(projectFieldId || projectFieldName);
    const [dateColumn, assigneeColumn, projectColumn, metadata] = await Promise.all([
      this.resolveSheetColumn({ sheetUrl, sheetId, fieldId: dateFieldId, fieldName: dateFieldName, spreadsheetToken, token }),
      this.resolveSheetColumn({ sheetUrl, sheetId, fieldId: assigneeFieldId, fieldName: assigneeFieldName, spreadsheetToken, token }),
      hasProjectColumn
        ? this.resolveSheetColumn({ sheetUrl, sheetId, fieldId: projectFieldId, fieldName: projectFieldName, spreadsheetToken, token })
        : Promise.resolve(null),
      this.request(
        'GET',
        `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/${encodeURIComponent(sheetId)}`,
        { token },
      ),
    ]);
    const rowCount = Number(metadata.data?.sheet?.grid_properties?.row_count);
    if (!Number.isInteger(rowCount) || rowCount < 1) {
      throw new LarkApiError('SHEET_METADATA_INVALID', '无法确定工作表有效范围');
    }
    if (rowCount > MAX_SHEET_SCAN_ROWS) {
      throw new LarkApiError('SHEET_SCAN_LIMIT_EXCEEDED', '工作表物理行数超过安全扫描上限');
    }
    const rows = [];
    let latest = null;
    for (let startRow = 1; startRow <= rowCount; startRow += SHEET_SCAN_CHUNK_ROWS) {
      const chunkEnd = Math.min(rowCount, startRow + SHEET_SCAN_CHUNK_ROWS - 1);
      const columns = projectColumn ? [dateColumn, assigneeColumn, projectColumn] : [dateColumn, assigneeColumn];
      const ranges = columns.map((column) => `${sheetId}!${column}${startRow}:${column}${chunkEnd}`);
      const values = await Promise.all(ranges.map(async (range) => {
        const payload = await this.request(
          'GET',
          `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
          { token },
        );
        return payload.data?.valueRange?.values || [];
      }));
      const length = Math.max(...values.map((columnValues) => columnValues.length));
      const chunkRows = [];
      for (let index = 0; index < length; index += 1) {
        chunkRows.push(values.map((columnValues) => columnValues[index]?.[0]));
      }
      if (typeof selectLatest === 'function') {
        const candidate = selectLatest(chunkRows);
        if (candidate !== null && candidate !== undefined) latest = candidate;
      } else {
        rows.push(...chunkRows);
      }
    }
    return typeof selectLatest === 'function' ? latest : rows;
  }

  async writeSheetAssignee({ sheetUrl, sheetId, rowIndex, assigneeFieldId, assigneeFieldName, assignee }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
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
    const payload = await this.request('GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
    const values = payload.data?.valueRange?.values || [];
    if (String(values?.[0]?.[0] ?? '').trim() !== String(assignee).trim()) {
      throw new LarkApiError('SHEET_READBACK_MISMATCH', '电子表格写入回读不一致');
    }
    return { range, assignee };
  }
}
