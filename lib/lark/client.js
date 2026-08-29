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

  // Reply to the original card message. In a normal group a reply groups into
  // a thread rooted at the card, which is exactly the "dispatch topic".
  async replyMessage({ messageId, msgType, content, uuid }) {
    const token = await this.getTenantAccessToken();
    const payload = await this.request(
      'POST',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        query: uuid ? { uuid } : undefined,
        body: {
          msg_type: msgType,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
        token,
      },
    );
    return payload.data || {};
  }

  // Replace the original message with a Card JSON 2.0 payload. The OpenAPI
  // expects interactive content to be encoded as a JSON string.
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
}
