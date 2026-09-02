import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BATCH_DISPATCH_ACTION, DISPATCH_ACTION, SCHEMA_VERSION, validateDispatchValue } from '../lark/card-actions.js';

export const LOCAL_PROMO_CHAT_ID = 'oc_99cb9239c03701fe263b870cc26a825c';

const LOCAL_PROMO_BLOCKED_REJECT_REASONS = Object.freeze([
  '涉及保证产品/服务效果',
  '投资类:未显著标明“投资有风险”提示语',
  '【团购】其他有违客观事实的虚假内容',
]);

export function shouldSkipLocalPromoDispatch(chatId, item) {
  if (String(chatId || '').trim() !== LOCAL_PROMO_CHAT_ID) return false;
  const rejectReason = String(item?.reject_reason ?? item?.rejectReason ?? item?.['拒绝理由'] ?? '');
  // 本地推群不派发命中指定拒绝理由的需求，避免将无需处置的风险类型分配给执行人。
  return LOCAL_PROMO_BLOCKED_REJECT_REASONS.some((reason) => rejectReason.includes(reason));
}

export const DISPATCH_INGEST_BINDINGS = Object.freeze({
  [LOCAL_PROMO_CHAT_ID]: Object.freeze({ businessType: '本地推', targetCategory: 'local_promo', sheetId: 'TQuzLA', requirePeriod: true }),
  oc_2ecc53a432a03f6f81f6a18babe8cda1: Object.freeze({ businessType: '千川', targetCategory: 'qianchuan', sheetId: 'TQuzLA', requirePeriod: true }),
  // The main monitor chat carries multiple business types. Cards sent there must
  // still go through this service so the sender app owns the callback.
  oc_aa1602f07bf35a5fdfd289aff67025a4: Object.freeze({ businessType: '*', targetCategory: '*', sheetId: '' }),
});

export class DispatchIngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DispatchIngestError';
    this.code = code;
    this.status = status;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function safeEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(actual.toLowerCase(), 'hex');
  const right = Buffer.from(expected.toLowerCase(), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyDispatchIngestSignature({ body, timestamp, signature, secret, now = Date.now, toleranceMs = 5 * 60 * 1000 }) {
  if (!secret) throw new DispatchIngestError('INGEST_NOT_CONFIGURED', '派单接入服务尚未配置', 503);
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now() - timestampMs) > toleranceMs) {
    throw new DispatchIngestError('STALE_REQUEST', '请求时间戳无效或已过期', 401);
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
  const actual = String(signature || '').replace(/^sha256=/i, '');
  if (!safeEqualHex(actual, expected)) throw new DispatchIngestError('INVALID_SIGNATURE', '请求签名校验失败', 401);
}

function normalizePeriod(body, binding) {
  const explicit = String(body.time_segment || body.items?.[0]?.time_segment || '').trim().toUpperCase();
  const title = String(body.card_title || '').trim();
  const titleMatch = title.match(/(?:^|\s)([A-Z])\s*段(?:\s|批量|自动|$)/i);
  const fromTitle = titleMatch ? `${titleMatch[1].toUpperCase()} 段` : '';
  const segment = explicit ? (explicit.endsWith('段') ? explicit.replace(/([A-Z])\s*段/i, '$1 段') : `${explicit} 段`) : fromTitle;
  if (binding.requirePeriod && !/^[A-Z] 段$/.test(segment)) {
    throw new DispatchIngestError('MISSING_TIME_SEGMENT', '千川/本地推群卡片必须提供真实时段');
  }
  if (explicit && fromTitle && explicit.replace(/\s/g, '') !== fromTitle.replace(/\s/g, '')) {
    throw new DispatchIngestError('TIME_SEGMENT_CONFLICT', '卡片标题时段与结构化时段不一致');
  }
  return {
    segment,
    windowStart: String(body.window_start || '').trim(),
    windowEnd: String(body.window_end || '').trim(),
  };
}

export function normalizeDispatchIngest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DispatchIngestError('INVALID_SCHEMA', '请求体格式不正确');
  }
  const chatId = String(body.chat_id || '').trim();
  const binding = DISPATCH_INGEST_BINDINGS[chatId];
  if (!binding) throw new DispatchIngestError('FORBIDDEN_CHAT', '目标群未开放派单接入', 403);

  let fields;
  try {
    fields = validateDispatchValue({
      schema_version: SCHEMA_VERSION,
      action: DISPATCH_ACTION,
      request_id: body.request_id,
      request_name: body.request_name,
      business_type: body.business_type,
      target_category: body.target_category,
      card_title: body.card_title,
      sheet_url: body.sheet_url,
      sheet_id: body.sheet_id || binding.sheetId,
      row_index: body.row_index,
      date_field_id: body.date_field_id || (body.date_field_name ? '' : 'H'),
      date_field_name: body.date_field_name || (body.date_field_id ? '' : '提需时间'),
      assignee_field_id: body.assignee_field_id,
      assignee_field_name: body.assignee_field_name,
      project_field_id: body.project_field_id,
      project_field_name: body.project_field_name,
      project_value: body.project_value,
    });
  } catch (error) {
    throw new DispatchIngestError(error?.code || 'INVALID_SCHEMA', error?.userMessage || '派单参数不正确');
  }

  const businessMatches = binding.businessType === '*' || fields.businessType === binding.businessType;
  const categoryMatches = binding.targetCategory === '*' || fields.targetCategory === binding.targetCategory;
  if (!businessMatches || !categoryMatches) {
    throw new DispatchIngestError('BINDING_MISMATCH', '群聊与业务类型不匹配', 403);
  }
  if (!fields.sheetUrl || !fields.sheetId || !fields.rowIndex || (!fields.assigneeFieldId && !fields.assigneeFieldName)) {
    throw new DispatchIngestError('INVALID_SHEET_TARGET', '缺少表格、工作表、行号或负责人字段');
  }
  return { chatId, fields };
}

export function normalizeBatchDispatchIngest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DispatchIngestError('INVALID_SCHEMA', '请求体格式不正确');
  }
  const chatId = String(body.chat_id || '').trim();
  const binding = DISPATCH_INGEST_BINDINGS[chatId];
  if (!binding) {
    throw new DispatchIngestError('FORBIDDEN_CHAT', '目标群未开放派单接入', 403);
  }
  const period = normalizePeriod(body, binding);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    throw new DispatchIngestError('INVALID_BATCH_SIZE', '批量派单需求数必须为 1 至 30 条');
  }
  const seen = new Set();
  const fieldsList = body.items.map((item) => {
    const normalized = normalizeDispatchIngest({
      ...item,
      chat_id: chatId,
      card_title: item?.card_title || body.card_title,
    }).fields;
    if (seen.has(normalized.requestId)) {
      throw new DispatchIngestError('DUPLICATE_REQUEST_ID', '批量派单中存在重复需求 ID');
    }
    seen.add(normalized.requestId);
    return { ...normalized, batchCard: true };
  });
  const suppliedBatchId = String(body.batch_id || '').trim();
  const batchId = suppliedBatchId || createHash('sha256')
    .update(`${chatId}:${fieldsList.map((item) => item.requestId).join(',')}`)
    .digest('hex')
    .slice(0, 24);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(batchId)) {
    throw new DispatchIngestError('INVALID_BATCH_ID', '批次 ID 格式不正确');
  }
  return { chatId, fieldsList, cardTitle: String(body.card_title || '').trim(), batchId, period };
}

export function batchDispatchActionValue(batchId, fieldsList) {
  return {
    schema_version: SCHEMA_VERSION,
    action: BATCH_DISPATCH_ACTION,
    batch_id: batchId,
    items: fieldsList.map(dispatchActionValue),
  };
}

export function dispatchActionValue(fields) {
  return {
    schema_version: SCHEMA_VERSION,
    action: DISPATCH_ACTION,
    request_id: fields.requestId,
    request_name: fields.requestName,
    business_type: fields.businessType,
    target_category: fields.targetCategory,
    card_title: fields.cardTitle,
    sheet_url: fields.sheetUrl,
    sheet_id: fields.sheetId,
    row_index: fields.rowIndex,
    date_field_id: fields.dateFieldId,
    date_field_name: fields.dateFieldName,
    assignee_field_id: fields.assigneeFieldId,
    assignee_field_name: fields.assigneeFieldName,
    project_field_id: fields.projectFieldId,
    project_field_name: fields.projectFieldName,
    project_value: fields.projectValue,
    batch_card: fields.batchCard === true,
  };
}
