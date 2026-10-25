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
const SHEET_HEADER_SCAN_ROWS = 10;
const REQUEST_ID_HEADER_ALIASES = new Set(['需求id', 'request_id']);
const KNOWN_REQUEST_ID_COLUMNS = new Map([
  ['NWVztk', 'X'],
]);

function sheetColumnForIndex(index) {
  let value = index + 1;
  let column = '';
  while (value > 0) {
    value -= 1;
    column = String.fromCharCode(65 + (value % 26)) + column;
    value = Math.floor(value / 26);
  }
  return column;
}

function normalizedRequestIdHeader(value) {
  return sheetCellText(value).trim().toLowerCase().replace(/\s+/gu, '');
}

export class LarkApiError extends Error {
  constructor(code, message, { httpStatus, method, endpoint, apiCode, apiMessage, logId } = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.method = method;
    this.endpoint = endpoint;
    this.apiCode = apiCode;
    this.apiMessage = apiMessage;
    this.logId = logId;
  }
}

function resolveValue(value) {
  return typeof value === 'function' ? value() : value;
}

function sheetCellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') {
    if (typeof cell.text === 'string') return cell.text;
    if (typeof cell.value === 'string' || typeof cell.value === 'number') return String(cell.value);
  }
  return String(cell);
}

function checkedTargetCell(payload) {
  const values = payload.data?.valueRange?.values;
  if (!Array.isArray(values) || values.length > 1
      || (values.length === 1 && (!Array.isArray(values[0]) || values[0].length > 1))) {
    throw new LarkApiError('SHEET_TARGET_READ_INVALID', '负责人单元格读取结果不完整，已停止写入');
  }
  return sheetCellText(values[0]?.[0]).trim();
}

export class LarkClient {
  constructor({
    appId,
    appSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl,
    timeoutMs = 6000,
    now = Date.now,
    sleep,
  } = {}) {
    this.getAppId = typeof appId === 'function' ? appId : () => appId;
    this.getAppSecret = typeof appSecret === 'function' ? appSecret : () => appSecret;
    this.getBaseUrl = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;
    // Resolved lazily in request() so tests can stub globalThis.fetch after
    // the client was constructed.
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
        throw new LarkApiError('LARK_API_TIMEOUT', `Lark API timeout: ${pathname}`, { method, endpoint: pathname });
      }
      throw new LarkApiError('LARK_API_NETWORK', `Lark API network error: ${pathname}`, { method, endpoint: pathname });
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
          method,
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
        {
          httpStatus: response.status,
          method,
          endpoint: pathname,
          apiCode: payload?.code,
          apiMessage: typeof payload?.msg === 'string' ? payload.msg : '',
          logId: typeof payload?.error?.log_id === 'string' ? payload.error.log_id : '',
        },
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

  async deleteMessage(messageId) {
    const token = await this.getTenantAccessToken();
    await this.request(
      'DELETE',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { token },
    );
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

  async getSheetMetadata({ spreadsheetToken, sheetId, token }) {
    const payload = await this.request(
      'GET',
      `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
      { token },
    );
    return (payload.data?.sheets || []).find(
      (sheet) => String(sheet?.sheet_id || '') === String(sheetId),
    ) || payload.data?.sheet;
  }

  sheetHeaderRange(sheetId, metadata) {
    const columnCount = Number(metadata?.grid_properties?.column_count);
    const rowCount = Number(metadata?.grid_properties?.row_count);
    if (!Number.isInteger(columnCount) || columnCount < 1
        || !Number.isInteger(rowCount) || rowCount < 1) {
      throw new LarkApiError('SHEET_METADATA_INVALID', '无法确定工作表有效表头范围');
    }
    const lastHeaderRow = Math.min(rowCount, SHEET_HEADER_SCAN_ROWS);
    return `${sheetId}!A1:${sheetColumnForIndex(columnCount - 1)}${lastHeaderRow}`;
  }

  findSheetHeaderColumn(rows, matches, { notFoundCode, notFoundMessage, ambiguousCode, ambiguousMessage }) {
    if (!Array.isArray(rows)) {
      throw new LarkApiError(notFoundCode, notFoundMessage);
    }
    const candidateColumns = new Set();
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      row.forEach((value, index) => {
        if (matches(value)) candidateColumns.add(index);
      });
    }
    if (candidateColumns.size === 0) {
      throw new LarkApiError(notFoundCode, notFoundMessage);
    }
    if (candidateColumns.size !== 1) {
      throw new LarkApiError(ambiguousCode, ambiguousMessage);
    }
    return sheetColumnForIndex([...candidateColumns][0]);
  }

  async resolveSheetColumn({ sheetUrl, sheetId, fieldId, fieldName, spreadsheetToken, token, metadata }) {
    const direct = String(fieldId || '').trim().toUpperCase();
    if (/^[A-Z]{1,3}$/.test(direct)) return direct;
    if (!fieldName) throw new LarkApiError('INVALID_SHEET_FIELD', '表格列配置缺失');
    const resolvedToken = spreadsheetToken || await this.resolveSpreadsheetToken(sheetUrl, token);
    const resolvedMetadata = metadata
      || await this.getSheetMetadata({ spreadsheetToken: resolvedToken, sheetId, token });
    const payload = await this.request(
      'GET',
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(resolvedToken)}/values/${encodeURIComponent(this.sheetHeaderRange(sheetId, resolvedMetadata))}`,
      { token },
    );
    const expected = String(fieldName).trim();
    return this.findSheetHeaderColumn(
      payload.data?.valueRange?.values,
      (value) => String(value).trim() === expected,
      {
        notFoundCode: 'SHEET_FIELD_NOT_FOUND',
        notFoundMessage: `找不到表格字段：${fieldName}`,
        ambiguousCode: 'SHEET_FIELD_AMBIGUOUS',
        ambiguousMessage: `表格字段不唯一：${fieldName}`,
      },
    );
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
        `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
        { token },
      ),
    ]);
    const matchedSheet = (metadata.data?.sheets || []).find(
      (sheet) => String(sheet?.sheet_id || '') === String(sheetId),
    ) || metadata.data?.sheet;
    const rowCount = Number(matchedSheet?.grid_properties?.row_count);
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
        const candidate = selectLatest(chunkRows, startRow);
        if (candidate !== null && candidate !== undefined) latest = candidate;
      } else {
        rows.push(...chunkRows);
      }
    }
    return typeof selectLatest === 'function' ? latest : rows;
  }

  async getSheetValuesBatch({ sheetUrl, ranges }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    const payload = await this.request('GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_get`, {
      query: { ranges: ranges.join(',') },
      token,
    });
    return (payload.data?.valueRanges || []).map((vr) => vr.values || []);
  }

  // This observation belongs to one claimed batch only. Never cache mutable
  // sheet values on the warm Function instance or reuse them in another run.
  async readDispatchSheetSnapshot({ items }) {
    const fields = items[0];
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(fields.sheetUrl, token);
    const metadata = await this.getSheetMetadata({ spreadsheetToken, sheetId: fields.sheetId, token });
    const rowCount = Number(metadata?.grid_properties?.row_count);
    if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_SHEET_SCAN_ROWS) {
      throw new LarkApiError('SCAN_INCOMPLETE', '无法完整读取批次工作表，已停止派单');
    }
    let headers;
    const column = async (fieldId, fieldName, requestId = false) => {
      const direct = String(fieldId || '').trim().toUpperCase();
      if (/^[A-Z]{1,3}$/.test(direct)) return direct;
      const known = requestId && KNOWN_REQUEST_ID_COLUMNS.get(String(fields.sheetId));
      if (known && !fieldName) return known;
      headers ||= this.request('GET',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(this.sheetHeaderRange(fields.sheetId, metadata))}`,
        { token }).then((payload) => payload.data?.valueRange?.values);
      return this.findSheetHeaderColumn(await headers,
        requestId && !fieldName
          ? (value) => REQUEST_ID_HEADER_ALIASES.has(normalizedRequestIdHeader(value))
          : (value) => sheetCellText(value).trim() === String(fieldName || '').trim(),
        { notFoundCode: requestId ? 'REQUEST_ID_FIELD_NOT_FOUND' : 'SHEET_FIELD_NOT_FOUND',
          notFoundMessage: '批次表格字段未找到',
          ambiguousCode: requestId ? 'REQUEST_ID_FIELD_AMBIGUOUS' : 'SHEET_FIELD_AMBIGUOUS',
          ambiguousMessage: '批次表格字段不唯一' });
    };
    const [requestColumn, dateColumn, assigneeColumn, projectColumn] = await Promise.all([
      column(fields.requestFieldId, fields.requestFieldName, true),
      column(fields.dateFieldId, fields.dateFieldName),
      column(fields.assigneeFieldId, fields.assigneeFieldName),
      fields.projectValue ? column(fields.projectFieldId, fields.projectFieldName) : null,
    ]);
    const columns = [...new Set([requestColumn, dateColumn, assigneeColumn, projectColumn].filter(Boolean))];
    const snapshot = { spreadsheetToken, sheetId: fields.sheetId, rowCount,
      requestColumn, dateColumn, assigneeColumn, projectColumn, columns, cells: new Map() };
    const ranges = [];
    for (const name of columns) {
      for (let start = 1; start <= rowCount; start += SHEET_SCAN_CHUNK_ROWS) {
        ranges.push(`${fields.sheetId}!${name}${start}:${name}${Math.min(rowCount, start + SHEET_SCAN_CHUNK_ROWS - 1)}`);
      }
    }
    const values = await this.readDispatchRanges({ snapshot, ranges });
    ranges.forEach((range, index) => {
      const [, name, start, , end] = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      const cells = snapshot.cells.get(name) || new Array(rowCount).fill('');
      for (let row = Number(start); row <= Number(end); row += 1) {
        cells[row - 1] = sheetCellText(values[index][row - Number(start)]?.[0]);
      }
      snapshot.cells.set(name, cells);
    });
    snapshot.targets = new Map();
    snapshot.cells.get(requestColumn).forEach((id, index) => {
      const key = String(id).trim();
      if (!key) return;
      const matches = snapshot.targets.get(key) || [];
      matches.push(index + 1);
      snapshot.targets.set(key, matches);
    });
    snapshot.rows = Array.from({ length: rowCount }, (_, index) => [
      snapshot.cells.get(dateColumn)[index], snapshot.cells.get(assigneeColumn)[index],
      projectColumn ? snapshot.cells.get(projectColumn)[index] : '',
    ]);
    return snapshot;
  }

  async readDispatchRanges({ snapshot, ranges }) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request('GET',
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(snapshot.spreadsheetToken)}/values_batch_get`,
      { query: { ranges: ranges.join(',') }, token });
    const values = payload.data?.valueRanges;
    if (!Array.isArray(values) || values.length !== ranges.length) {
      throw new LarkApiError('SCAN_INCOMPLETE', '批次读取范围不完整，已停止派单');
    }
    const revisions = new Set(values.map((value) => value.revision).filter((value) => value != null));
    if (revisions.size > 1) {
      throw new LarkApiError('SHEET_TARGET_CHANGED', '批次读取期间表格版本发生变化，已停止派单');
    }
    return values.map((value, index) => {
      const match = ranges[index].match(/!([A-Z]+)(\d+):\1(\d+)$/);
      if (!match || value.range !== ranges[index] || !Array.isArray(value.values)
          || value.values.length > Number(match[3]) - Number(match[2]) + 1
          || value.values.some((row) => !Array.isArray(row) || row.length > 1)) {
        throw new LarkApiError('SCAN_INCOMPLETE', '批次读取范围或响应顺序不匹配，已停止派单');
      }
      return value.values;
    });
  }

  async verifyDispatchSheetSnapshot({ snapshot, startRow, endRow }) {
    const ranges = [];
    for (const column of snapshot.columns) {
      for (let row = startRow; row <= endRow; row += SHEET_SCAN_CHUNK_ROWS) {
        ranges.push(`${snapshot.sheetId}!${column}${row}:${column}${Math.min(endRow, row + SHEET_SCAN_CHUNK_ROWS - 1)}`);
      }
    }
    const values = await this.readDispatchRanges({ snapshot, ranges });
    return ranges.every((range, index) => {
      const [, column, start, , end] = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      for (let row = Number(start); row <= Number(end); row += 1) {
        if (sheetCellText(values[index][row - Number(start)]?.[0]) !== snapshot.cells.get(column)[row - 1]) return false;
      }
      return true;
    });
  }

  async readDispatchTargets({ snapshot, items }) {
    const ranges = items.flatMap((item) => [snapshot.requestColumn, snapshot.assigneeColumn]
      .map((column) => `${snapshot.sheetId}!${column}${item.rowIndex}:${column}${item.rowIndex}`));
    const values = await this.readDispatchRanges({ snapshot, ranges });
    return items.map((item, index) => ({ rowIndex: item.rowIndex,
      requestId: sheetCellText(values[index * 2]?.[0]?.[0]).trim(),
      assignee: sheetCellText(values[index * 2 + 1]?.[0]?.[0]).trim() }));
  }

  async writeSheetValuesBatch({ sheetUrl, valueRanges, spreadsheetToken: resolvedToken }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = resolvedToken || await this.resolveSpreadsheetToken(sheetUrl, token);
    const payload = await this.request('POST', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_update`, {
      token,
      body: { valueRanges },
    });
    return payload.data?.responses || [];
  }

  async locateSheetRequestRow({ sheetUrl, sheetId, requestId, requestFieldId, requestFieldName }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    const hasExplicitField = Boolean(String(requestFieldId || '').trim() || String(requestFieldName || '').trim());
    const knownRequestColumn = KNOWN_REQUEST_ID_COLUMNS.get(String(sheetId || '').trim()) || '';
    const metadataPromise = this.getSheetMetadata({ spreadsheetToken, sheetId, token });
    const columnPromise = hasExplicitField
      ? metadataPromise.then((metadata) => this.resolveSheetColumn({
        sheetUrl, sheetId, fieldId: requestFieldId, fieldName: requestFieldName,
        spreadsheetToken, token, metadata,
      }))
      : knownRequestColumn
        ? Promise.resolve(knownRequestColumn)
        : metadataPromise.then((metadata) => this.request('GET',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(this.sheetHeaderRange(sheetId, metadata))}`,
        { token })).then((payload) => this.findSheetHeaderColumn(
        payload.data?.valueRange?.values,
        (value) => REQUEST_ID_HEADER_ALIASES.has(normalizedRequestIdHeader(value)),
        {
          notFoundCode: 'REQUEST_ID_FIELD_NOT_FOUND',
          notFoundMessage: '未找到唯一可信的需求 ID 列，已停止派单',
          ambiguousCode: 'REQUEST_ID_FIELD_AMBIGUOUS',
          ambiguousMessage: '存在多个需求 ID 候选列，已停止派单',
        },
      ));
    const [column, matched] = await Promise.all([columnPromise, metadataPromise]);
    const rowCount = Number(matched?.grid_properties?.row_count);
    if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_SHEET_SCAN_ROWS) {
      throw new LarkApiError('SCAN_INCOMPLETE', '无法完整扫描需求 ID 列，已停止派单');
    }
    const matches = [];
    for (let start = 1; start <= rowCount; start += SHEET_SCAN_CHUNK_ROWS) {
      const end = Math.min(rowCount, start + SHEET_SCAN_CHUNK_ROWS - 1);
      const range = `${sheetId}!${column}${start}:${column}${end}`;
      const payload = await this.request('GET',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
      const values = payload.data?.valueRange?.values;
      if (!Array.isArray(values)) throw new LarkApiError('SCAN_INCOMPLETE', '需求 ID 扫描结果不完整，已停止派单');
      values.forEach((row, offset) => {
        if (sheetCellText(row?.[0]).trim() === String(requestId).trim()) matches.push(start + offset);
      });
    }
    if (matches.length !== 1) {
      throw new LarkApiError('TARGET_NOT_FOUND', matches.length ? '需求 ID 在表中不唯一，已停止派单' : '未在表中找到需求 ID，已停止派单');
    }
    return { rowIndex: matches[0], scanComplete: true };
  }

  async readSheetAssignee({ sheetUrl, sheetId, rowIndex, assigneeFieldId, assigneeFieldName }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    const column = await this.resolveSheetColumn({
      sheetUrl, sheetId, fieldId: assigneeFieldId, fieldName: assigneeFieldName, spreadsheetToken, token,
    });
    const range = `${sheetId}!${column}${rowIndex}:${column}${rowIndex}`;
    const payload = await this.request('GET',
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
    return checkedTargetCell(payload);
  }

  async writeSheetAssignee({ sheetUrl, sheetId, rowIndex, assigneeFieldId, assigneeFieldName, assignee, requireEmpty = false }) {
    const token = await this.getTenantAccessToken();
    const spreadsheetToken = await this.resolveSpreadsheetToken(sheetUrl, token);
    if (!String(assigneeFieldId || '').trim() && !assigneeFieldName) {
      throw new LarkApiError('INVALID_ASSIGNEE_FIELD', '负责人列配置缺失');
    }
    let column;
    try {
      column = await this.resolveSheetColumn({
        sheetUrl, sheetId, fieldId: assigneeFieldId, fieldName: assigneeFieldName,
        spreadsheetToken, token,
      });
    } catch (error) {
      if (error?.code === 'SHEET_FIELD_NOT_FOUND') {
        throw new LarkApiError('ASSIGNEE_FIELD_NOT_FOUND', '找不到负责人字段');
      }
      throw error;
    }

    const expected = String(assignee ?? '').trim();
    const range = `${sheetId}!${column}${rowIndex}:${column}${rowIndex}`;
    if (requireEmpty) {
      // This narrows the external read/write race; it is NOT a Sheets CAS.
      // Never overwrite a value observed after the durable assignment commit.
      const payload = await this.request('GET',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { token });
      const actual = checkedTargetCell(payload);
      if (actual) {
        if (actual === expected) return { range, assignee, written: false };
        throw new LarkApiError('SHEET_TARGET_CHANGED', '目标负责人已被修改，未覆盖表格，请核对已落库的派单记录');
      }
    }

    await this.request('PUT', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`, {
      token,
      body: { valueRange: { range, values: [[assignee]] } },
    });

    // Sheets values read-after-write can be eventually consistent in some cases.
    // Use a bounded retry to avoid false negatives.
    const backoffs = [0, 120, 300, 800];
    let lastActual = '';
    for (let attempt = 0; attempt < backoffs.length; attempt += 1) {
      if (backoffs[attempt] > 0) await this.sleep(backoffs[attempt]);
      const payload = await this.request(
        'GET',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
        { token },
      );
      const values = payload.data?.valueRange?.values || [];
      lastActual = sheetCellText(values?.[0]?.[0] ?? '').trim();
      if (lastActual === expected) return { range, assignee };
    }

    throw new LarkApiError('SHEET_READBACK_MISMATCH', `电子表格写入回读不一致（readback=${lastActual || '-'}）`);
  }
}
