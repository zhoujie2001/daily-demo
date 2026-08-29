// Parsing and schema validation for card.action.trigger events.
// action.value is treated as an untrusted business hint: every field is
// length/shape-checked before use.

export const DISPATCH_ACTION = 'bess_auto_dispatch';
export const SCHEMA_VERSION = 1;

export class DispatchValidationError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.name = 'DispatchValidationError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function parseCardActionEvent(body) {
  const header = body?.header || {};
  const event = body?.event || {};
  const action = event?.action || {};
  const context = event?.context || {};
  const operator = event?.operator || {};

  let value = action.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }

  return {
    eventId: String(header.event_id || '').trim(),
    actionTag: String(action.tag || '').trim(),
    value: value && typeof value === 'object' && !Array.isArray(value) ? value : null,
    operatorOpenId: String(operator.open_id || '').trim(),
    cardUpdateToken: String(event.token || '').trim(),
    messageId: String(context.open_message_id || '').trim(),
    chatId: String(context.open_chat_id || '').trim(),
  };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REQUEST_NAME_LENGTH = 200;
const MAX_BUSINESS_TYPE_LENGTH = 50;

// Throws DispatchValidationError with a user-safe message on any malformed
// field. Returns a normalized fields object on success.
export function validateDispatchValue(value) {
  if (!value || typeof value !== 'object') {
    throw new DispatchValidationError('INVALID_ACTION_VALUE', '按钮参数缺失或格式不正确');
  }
  if (value.action !== DISPATCH_ACTION) {
    throw new DispatchValidationError('UNSUPPORTED_ACTION', '未识别的按钮操作，已忽略');
  }
  if (value.schema_version !== undefined && value.schema_version !== SCHEMA_VERSION) {
    throw new DispatchValidationError(
      'UNSUPPORTED_SCHEMA_VERSION',
      '按钮版本不受支持，请等待最新监控卡片下发',
    );
  }

  const requestId = String(value.request_id ?? '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new DispatchValidationError('INVALID_REQUEST_ID', '需求 ID 缺失或格式不正确');
  }

  const requestName = String(value.request_name ?? '').trim();
  if (!requestName || requestName.length > MAX_REQUEST_NAME_LENGTH) {
    throw new DispatchValidationError('INVALID_REQUEST_NAME', '需求名称缺失或过长');
  }

  const businessType = String(value.business_type ?? '').trim();
  if (!businessType || businessType.length > MAX_BUSINESS_TYPE_LENGTH) {
    throw new DispatchValidationError('INVALID_BUSINESS_TYPE', '业务类型缺失或格式不正确');
  }

  const rawRowIndex = value.row_index;
  let rowIndex = null;
  if (rawRowIndex !== undefined && rawRowIndex !== null && rawRowIndex !== '') {
    const parsed = Number(rawRowIndex);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new DispatchValidationError('INVALID_ROW_INDEX', '台账行号格式不正确');
    }
    rowIndex = parsed;
  }

  return {
    requestId,
    requestName,
    businessType,
    targetCategory: String(value.target_category ?? '').trim(),
    cardTitle: String(value.card_title ?? '').trim(),
    sheetUrl: String(value.sheet_url ?? '').trim(),
    sheetId: String(value.sheet_id ?? '').trim(),
    rowIndex,
  };
}

export function parseAllowedChatIds(raw) {
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Kill switch: LARK_DISPATCH_FEATURE_ENABLED=false|0|off|no disables dispatch.
// Default (unset/empty) is enabled so rollout only needs the secret + allowlist.
export function isFeatureEnabled(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return true;
  }
  return !['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}
