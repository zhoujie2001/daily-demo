import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DISPATCH_ACTION, SCHEMA_VERSION, validateDispatchValue } from '../lark/card-actions.js';

export const DISPATCH_INGEST_BINDINGS = Object.freeze({
  oc_99cb9239c03701fe263b870cc26a825c: Object.freeze({ businessType: '本地推', targetCategory: 'local_promo', sheetId: 'TQuzLA' }),
  oc_2ecc53a432a03f6f81f6a18babe8cda1: Object.freeze({ businessType: '千川', targetCategory: 'qianchuan', sheetId: 'TQuzLA' }),
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
    });
  } catch (error) {
    throw new DispatchIngestError(error?.code || 'INVALID_SCHEMA', error?.userMessage || '派单参数不正确');
  }

  if (fields.businessType !== binding.businessType || fields.targetCategory !== binding.targetCategory) {
    throw new DispatchIngestError('BINDING_MISMATCH', '群聊与业务类型不匹配', 403);
  }
  if (!fields.sheetUrl || !fields.sheetId || !fields.rowIndex || (!fields.assigneeFieldId && !fields.assigneeFieldName)) {
    throw new DispatchIngestError('INVALID_SHEET_TARGET', '缺少表格、工作表、行号或负责人字段');
  }
  return { chatId, fields };
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
  };
}
