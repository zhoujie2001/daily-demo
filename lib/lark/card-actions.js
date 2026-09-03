// Parsing and schema validation for card.action.trigger events.
// action.value is treated as an untrusted business hint: every field is
// length/shape-checked before use.

export const DISPATCH_ACTION = 'bess_auto_dispatch';
export const BATCH_DISPATCH_ACTION = 'bess_batch_auto_dispatch';
export const ADJUST_STATUS_ACTION = 'bess_adjust_status';
export const ADJUST_STATUS_SUBMIT_ACTION = 'bess_adjust_status_submit';
export const SCHEMA_VERSION = 1;
export const BATCH_STATUS = Object.freeze({
  READY: 'READY',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});

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

  let formValue = action.form_value;
  if (typeof formValue === 'string') {
    try {
      formValue = JSON.parse(formValue);
    } catch {
      formValue = null;
    }
  }

  return {
    eventId: String(header.event_id || '').trim(),
    actionTag: String(action.tag || '').trim(),
    value: value && typeof value === 'object' && !Array.isArray(value) ? value : null,
    formValue: formValue && typeof formValue === 'object' && !Array.isArray(formValue) ? formValue : null,
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
function legacySheetFields({
  sheetId, targetCategory, dateFieldId, dateFieldName, assigneeFieldId, assigneeFieldName,
  projectFieldId, projectFieldName,
}) {
  const hasDateField = Boolean(dateFieldId || dateFieldName);
  const hasAssigneeField = Boolean(assigneeFieldId || assigneeFieldName);
  const hasProjectField = Boolean(projectFieldId || projectFieldName);
  const usesSharedProjectSheet = ['qianchuan', 'local_promo'].includes(targetCategory);
  if (sheetId === 'TQuzLA' || usesSharedProjectSheet) {
    return {
      dateFieldId: hasDateField ? dateFieldId : 'H',
      dateFieldName: hasDateField ? dateFieldName : '提需时间',
      assigneeFieldId: hasAssigneeField ? assigneeFieldId : 'J',
      assigneeFieldName: hasAssigneeField ? assigneeFieldName : '执行人',
      projectFieldId: hasProjectField ? projectFieldId : 'C',
      projectFieldName: hasProjectField ? projectFieldName : '项目',
    };
  }
  if (sheetId === 'p7Wqx4') {
    return {
      dateFieldId: hasDateField ? dateFieldId : 'D',
      dateFieldName: hasDateField ? dateFieldName : '创建时间',
      assigneeFieldId,
      assigneeFieldName,
      projectFieldId,
      projectFieldName,
    };
  }
  return {
    dateFieldId, dateFieldName, assigneeFieldId, assigneeFieldName, projectFieldId, projectFieldName,
  };
}

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

  const sheetId = String(value.sheet_id ?? '').trim();
  const targetCategory = String(value.target_category ?? '').trim();
  const sheetFields = legacySheetFields({
    sheetId,
    targetCategory,
    dateFieldId: String(value.date_field_id ?? '').trim().toUpperCase(),
    dateFieldName: String(value.date_field_name ?? '').trim(),
    assigneeFieldId: String(value.assignee_field_id ?? '').trim().toUpperCase(),
    assigneeFieldName: String(value.assignee_field_name ?? '').trim(),
    projectFieldId: String(value.project_field_id ?? '').trim().toUpperCase(),
    projectFieldName: String(value.project_field_name ?? '').trim(),
  });
  const defaultProjectValue = targetCategory === 'qianchuan'
    ? '千川'
    : targetCategory === 'local_promo' ? '本地' : '';

  return {
    requestId,
    requestName,
    businessType,
    targetCategory,
    cardTitle: String(value.card_title ?? '').trim(),
    sheetUrl: String(value.sheet_url ?? '').trim(),
    sheetId,
    rowIndex,
    ...sheetFields,
    projectValue: defaultProjectValue
      ? String(value.project_value ?? '').trim() || defaultProjectValue
      : '',
    batchCard: value.batch_card === true,
  };
}

export function validateBatchDispatchValue(value) {
  if (!value || typeof value !== 'object') {
    throw new DispatchValidationError('INVALID_ACTION_VALUE', '批量派单参数缺失或格式不正确');
  }
  if (value.action !== BATCH_DISPATCH_ACTION) {
    throw new DispatchValidationError('UNSUPPORTED_ACTION', '未识别的按钮操作，已忽略');
  }
  if (value.schema_version !== undefined && value.schema_version !== SCHEMA_VERSION) {
    throw new DispatchValidationError('UNSUPPORTED_SCHEMA_VERSION', '按钮版本不受支持，请等待最新监控卡片下发');
  }
  const batchId = String(value.batch_id ?? '').trim();
  if (!REQUEST_ID_PATTERN.test(batchId)) {
    throw new DispatchValidationError('INVALID_BATCH_ID', '批次 ID 缺失或格式不正确');
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 30) {
    throw new DispatchValidationError('INVALID_BATCH_SIZE', '批量派单需求数必须为 1 至 30 条');
  }
  const seen = new Set();
  const items = value.items.map((item) => {
    const fields = validateDispatchValue({ ...item, action: DISPATCH_ACTION });
    if (seen.has(fields.requestId)) {
      throw new DispatchValidationError('DUPLICATE_REQUEST_ID', '批量派单中存在重复需求 ID');
    }
    seen.add(fields.requestId);
    return fields;
  });
  return { batchId, items };
}

export function validateAdjustStatusValue(value) {
  if (!value || typeof value !== 'object') {
    throw new DispatchValidationError('INVALID_ACTION_VALUE', '按钮参数缺失或格式不正确');
  }
  if (value.action !== ADJUST_STATUS_ACTION) {
    throw new DispatchValidationError('UNSUPPORTED_ACTION', '未识别的按钮操作');
  }
  return {
    dayKey: String(value.day_key || '').trim(),
    businessType: String(value.business_type || '').trim(),
  };
}

export function validateAdjustStatusSubmitValue(value) {
  if (!value || typeof value !== 'object') {
    throw new DispatchValidationError('INVALID_ACTION_VALUE', '参数缺失或格式不正确');
  }
  return {
    dayKey: String(value.day_key || '').trim(),
    businessType: String(value.business_type || '').trim(),
    expectedVersion: Number(value.expected_version || 0),
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
