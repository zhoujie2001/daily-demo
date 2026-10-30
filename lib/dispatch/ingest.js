import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BATCH_DISPATCH_ACTION, DISPATCH_ACTION, LOCAL_PROMO_SHEET_ID, MAIN_SHEET_ID,
  QIANCHUAN_SHEET_ID, SCHEMA_VERSION, validateDispatchValue,
} from '../lark/card-actions.js';
import { dispatchOperationId } from './operation.js';
import { TEST_DISPATCH_CHAT_ID } from './profile.js';
import { MAX_BATCH_ITEMS, MAX_ITEMS_PER_CARD, MAX_BATCH_CHUNKS, LEGACY_MAX_BATCH_ITEMS } from './batch-limits.js';
import {
  QIANCHUAN_ITEM_KEYS, QIANCHUAN_LEGACY_POLICY, QIANCHUAN_UPSTREAM_POLICY, hasQianchuanMetadata, buildQianchuanSnapshot,
  decisionMember, stableJson, qianchuanActionFields,
  decisionSnapshotHash,
} from './qianchuan-policy.js';

export { TEST_DISPATCH_CHAT_ID };

export const BESS_ADDITIONAL_CHAT_ID = 'oc_e1bdb85a89d9f49cb62fd4e3ffebb68e';
export const BESS_AD_ADDITIONAL_CHAT_ID = 'oc_38aec46e64a6ebd245c7751271bd770f';
export const LOCAL_PROMO_CHAT_ID = 'oc_99cb9239c03701fe263b870cc26a825c';
export const AD_DISPATCH_CHAT_ID = 'oc_56debf24fa90e17ea92257c20454d742';

export const LOCAL_PROMO_BLOCKED_REJECT_REASONS = Object.freeze([
  '【团购】涉及保证产品/服务效果',
  '投资类：未显著标明“投资有风险”提示语',
  '【团购】其他有违客观事实的虚假内容',
  '【团购】涉及联系方式',
]);

const REJECT_REASON_FIELDS = Object.freeze(['reject_reason', 'rejectReason', '拒绝理由']);

/**
 * Whether the caller explicitly carried a reject-reason field (empty string is
 * allowed — some requirements genuinely have no reject reason). Used to detect
 * upstream contract violations where the field is missing entirely, which would
 * otherwise make the skip filter silently ineffective.
 */
export function hasLocalPromoRejectReasonField(item) {
  return REJECT_REASON_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(item || {}, field));
}

export function shouldSkipLocalPromoDispatch() {
  // 2026-09-23：业务确认取消拒绝理由过滤，所有需求按原顺序进入派单。
  return false;
}

/**
 * 拒绝理由过滤已停用。保留审计接口兼容旧调用方，但不跳过或告警任何需求。
 */
export function auditLocalPromoRejectReasons() {
  return { skipped: [], missingField: [] };
}

export const DISPATCH_INGEST_BINDINGS = Object.freeze({
  [LOCAL_PROMO_CHAT_ID]: Object.freeze({ businessType: '本地推', targetCategory: 'local_promo', sheetId: 'TQuzLA', requirePeriod: true }),
  oc_2ecc53a432a03f6f81f6a18babe8cda1: Object.freeze({ businessType: '千川', targetCategory: 'qianchuan', sheetId: 'TQuzLA', requirePeriod: true }),
  // The main monitor and dedicated test chats carry multiple business types.
  // Cards sent there must still go through this service so the sender app owns the callback.
  oc_aa1602f07bf35a5fdfd289aff67025a4: Object.freeze({ businessType: '*', targetCategory: '*', sheetId: '' }),
  [TEST_DISPATCH_CHAT_ID]: Object.freeze({ businessType: '*', targetCategory: '*', sheetId: '' }),
  [AD_DISPATCH_CHAT_ID]: Object.freeze({
    businessType: 'AD',
    targetCategory: Object.freeze(['ad', 'game_agent', 'qianchuan_ad', 'ehc_emergency_ad']),
    sheetId: '',
    dateFieldId: 'J',
    dateFieldName: '日期',
    assigneeFieldId: 'B',
    assigneeFieldName: '姓名',
    strictFieldIds: true,
    fieldIdsByCategory: Object.freeze({
      qianchuan_ad: Object.freeze({ sheetId: 'Vp2A6O', dateFieldId: 'A', assigneeFieldId: 'F' }),
      ehc_emergency_ad: Object.freeze({ sheetId: 'Vp2A6O', dateFieldId: 'A', assigneeFieldId: 'F' }),
    }),
  }),
  [BESS_ADDITIONAL_CHAT_ID]: Object.freeze({
    businessType: '*',
    targetCategory: Object.freeze(['qianchuan', 'local_promo', 'stock', 'ehc_emergency_other', 'ehc_emergency']),
    businessTypesByCategory: Object.freeze({
      ehc_emergency: Object.freeze(['千川', '本地推']),
    }),
    sheetId: '',
  }),
  [BESS_AD_ADDITIONAL_CHAT_ID]: Object.freeze({
    businessType: 'AD',
    targetCategory: Object.freeze(['qianchuan_ad', 'ehc_emergency_ad']),
    sheetId: 'Vp2A6O',
    dateFieldId: 'A',
    dateFieldName: '需求创建时间',
    assigneeFieldId: 'F',
    assigneeFieldName: '回扫人',
    strictSheetId: true,
    strictFieldIds: true,
  }),
});

export class DispatchIngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DispatchIngestError';
    this.code = code;
    this.status = status;
  }
}

// This request was rejected before handoff, not proof that an older request
// with the same batch key was never accepted. Never classify timeouts this way.
export function dispatchBatchSizeRejection(error) {
  if (!(error instanceof DispatchIngestError) || error.code !== 'INVALID_BATCH_SIZE') return {};
  return {
    accepted: false,
    retryable: false,
    message: error.message,
    item_count: error.itemCount,
    limits: {
      min_items: 1, max_items: error.maxItems,
      max_items_per_card: MAX_ITEMS_PER_CARD, max_card_count: MAX_BATCH_CHUNKS,
    },
  };
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

/**
 * Signature verification for POST /api/dispatch/status only.
 *
 * The shared Lark Base status workflow is driven by two paste skills whose
 * deployed versions sign different canonical bodies:
 *   - 2-field projection: {"chat_id","batch_id"}
 *   - 3-field body:        {"chat_id","batch_id","operation_id"}
 * while the workflow itself sends one fixed body shape. operation_id is a
 * deterministic hash of chat_id+batch_id (see dispatchOperationId), so the
 * 3-field form is security-equivalent to the 2-field form. We accept a
 * signature matching any of:
 *   1. the exact received body (strict; covers request_id single form too)
 *   2. the 2-field projection, when body has no other keys besides the trio
 *   3. the canonical 3-field body with the deterministic operation_id
 * Unknown keys never weaken verification: such bodies only match candidate 1.
 * The ingest endpoint keeps using strict whole-body verification.
 */
export function verifyDispatchStatusSignature({ body, timestamp, signature, secret, now = Date.now, toleranceMs = 5 * 60 * 1000 }) {
  if (!secret) throw new DispatchIngestError('INGEST_NOT_CONFIGURED', '派单接入服务尚未配置', 503);
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now() - timestampMs) > toleranceMs) {
    throw new DispatchIngestError('STALE_REQUEST', '请求时间戳无效或已过期', 401);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DispatchIngestError('INVALID_SIGNATURE', '请求签名校验失败', 401);
  }
  const actual = String(signature || '').replace(/^sha256=/i, '');

  const candidates = [body];
  const chatId = String(body.chat_id ?? '');
  const batchId = String(body.batch_id ?? '');
  const ownKeys = Object.keys(body);
  const trioKeys = ownKeys.every((key) => key === 'chat_id' || key === 'batch_id' || key === 'operation_id');
  if (chatId && batchId && trioKeys) {
    const projected = { chat_id: chatId, batch_id: batchId };
    const deterministicOp = dispatchOperationId(chatId, batchId);
    if (!ownKeys.includes('operation_id')) {
      candidates.push(projected);
      candidates.push({ chat_id: chatId, batch_id: batchId, operation_id: deterministicOp });
    } else if (String(body.operation_id ?? '') === deterministicOp) {
      candidates.push(projected);
      candidates.push({ chat_id: chatId, batch_id: batchId, operation_id: deterministicOp });
    }
  }

  const matched = candidates.some((candidate) => safeEqualHex(
    actual,
    createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(candidate)}`).digest('hex'),
  ));
  if (!matched) throw new DispatchIngestError('INVALID_SIGNATURE', '请求签名校验失败', 401);
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

  const resolvedSheetId = String(body.sheet_id || binding.sheetId || '').trim();
  let defaultDateField = { id: 'H', name: '提需时间' };
  let defaultRequestFieldId = '';
  if (resolvedSheetId === MAIN_SHEET_ID) {
    defaultDateField = { id: 'B', name: '需求提出日期' };
    defaultRequestFieldId = 'X';
  } else if ([LOCAL_PROMO_SHEET_ID, QIANCHUAN_SHEET_ID].includes(resolvedSheetId)) {
    defaultDateField = {
      id: 'A',
      name: resolvedSheetId === LOCAL_PROMO_SHEET_ID ? '处理日期' : '粘贴日期',
    };
  }

  let fields;
  try {
    fields = validateDispatchValue({
      schema_version: SCHEMA_VERSION,
      action: DISPATCH_ACTION,
      request_id: body.request_id,
      request_name: body.request_name,
      business_type: body.business_type,
      target_category: body.target_category,
      dispatch_profile: body.dispatch_profile,
      card_title: body.card_title,
      created_at: body.created_at,
      created_at_raw: body.created_at_raw,
      creator: body.creator,
      creator_name: body.creator_name,
      risk_level: body.risk_level,
      riskLevel: body.riskLevel,
      reject_reason: body.reject_reason,
      rejectReason: body.rejectReason,
      sheet_url: body.sheet_url,
      sheet_id: body.sheet_id || binding.sheetId,
      row_index: body.row_index,
      request_field_id: body.request_field_id || (body.request_field_name ? '' : defaultRequestFieldId),
      request_field_name: body.request_field_name,
      date_field_id: body.date_field_id || binding.dateFieldId || (body.date_field_name ? '' : defaultDateField.id),
      date_field_name: body.date_field_name || binding.dateFieldName || (body.date_field_id ? '' : defaultDateField.name),
      assignee_field_id: body.assignee_field_id || binding.assigneeFieldId,
      assignee_field_name: body.assignee_field_name || binding.assigneeFieldName,
      project_field_id: body.project_field_id,
      project_field_name: body.project_field_name,
      project_value: body.project_value,
      ...Object.fromEntries(QIANCHUAN_ITEM_KEYS.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])),
    }, { chatId });
  } catch (error) {
    const contractMismatch = [
      'AD_SHEET_CONTRACT_MISMATCH', 'DISPATCH_PROFILE_MISMATCH', 'TEST_DISPATCH_PROFILE_FORBIDDEN',
      'AD_ISOLATION_PROFILE_FORBIDDEN',
    ].includes(error?.code);
    throw new DispatchIngestError(
      contractMismatch ? 'BINDING_MISMATCH' : (error?.code || 'INVALID_SCHEMA'),
      contractMismatch ? '群聊、业务类型或目标表不匹配' : (error?.userMessage || '派单参数不正确'),
      contractMismatch ? 403 : 400,
    );
  }

  const categoryBusinessTypes = binding.businessTypesByCategory?.[fields.targetCategory];
  const businessMatches = (binding.businessType === '*' || fields.businessType === binding.businessType)
    && (!categoryBusinessTypes || categoryBusinessTypes.includes(fields.businessType));
  const categoryMatches = binding.targetCategory === '*'
    || (Array.isArray(binding.targetCategory)
      ? binding.targetCategory.includes(fields.targetCategory)
      : fields.targetCategory === binding.targetCategory);
  const categoryFieldBinding = binding.fieldIdsByCategory?.[fields.targetCategory];
  const sheetMatches = categoryFieldBinding
    ? fields.sheetId === categoryFieldBinding.sheetId
    : (!binding.strictSheetId || fields.sheetId === binding.sheetId);
  const fieldIdsMatch = categoryFieldBinding
    ? (fields.dateFieldId === categoryFieldBinding.dateFieldId
      && fields.assigneeFieldId === categoryFieldBinding.assigneeFieldId)
    : (!binding.strictFieldIds
      || (fields.dateFieldId === binding.dateFieldId && fields.assigneeFieldId === binding.assigneeFieldId));
  if (!businessMatches || !categoryMatches || !sheetMatches || !fieldIdsMatch) {
    throw new DispatchIngestError('BINDING_MISMATCH', '群聊、业务类型或目标表不匹配', 403);
  }
  if (!fields.sheetUrl || !fields.sheetId || !fields.rowIndex || (!fields.assigneeFieldId && !fields.assigneeFieldName)) {
    throw new DispatchIngestError('INVALID_SHEET_TARGET', '缺少表格、工作表、行号或负责人字段');
  }
  return { chatId, fields };
}

export function normalizeBatchDispatchIngest(body, { splitCards = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DispatchIngestError('INVALID_SCHEMA', '请求体格式不正确');
  }
  const chatId = String(body.chat_id || '').trim();
  const binding = DISPATCH_INGEST_BINDINGS[chatId];
  if (!binding) {
    throw new DispatchIngestError('FORBIDDEN_CHAT', '目标群未开放派单接入', 403);
  }
  const period = normalizePeriod(body, binding);
  const qianchuanV2 = hasQianchuanMetadata(body) || body.items?.some(hasQianchuanMetadata);
  const maxItems = qianchuanV2 ? MAX_ITEMS_PER_CARD : splitCards ? MAX_BATCH_ITEMS : LEGACY_MAX_BATCH_ITEMS;
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > maxItems) {
    throw Object.assign(new DispatchIngestError(
      'INVALID_BATCH_SIZE', `批量派单需求数必须为 1 至 ${maxItems} 条`,
    ), { itemCount: Array.isArray(body.items) ? body.items.length : null, maxItems });
  }
  const seen = new Set();
  let fieldsList = body.items.map((item) => {
    const normalized = normalizeDispatchIngest({
      ...item,
      ...(qianchuanV2 ? {
        source_batch_id: item.source_batch_id ?? body.source_batch_id,
        decision_policy_version: item.decision_policy_version ?? body.decision_policy_version,
        decision_snapshot_hash: item.decision_snapshot_hash ?? body.decision_snapshot_hash,
      } : {}),
      chat_id: chatId,
      dispatch_profile: item?.dispatch_profile ?? body.dispatch_profile,
      card_title: item?.card_title || body.card_title,
    }).fields;
    if (seen.has(normalized.requestId)) {
      throw new DispatchIngestError('DUPLICATE_REQUEST_ID', '批量派单中存在重复需求 ID');
    }
    seen.add(normalized.requestId);
    return { ...normalized, batchCard: true };
  });
  let qianchuanSnapshot;
  if (qianchuanV2) {
    // Legacy producer used "unified" as an envelope label, not an item bucket.
    // The existing v1 contract permits both homogeneous and mixed deliveries.
    // Each item has already passed its versioned code/bucket validation. Never mutate the
    // received items/frozen snapshot or reinterpret v1 codes.
    const legacyUnified = body.decision_group === 'unified'
      && body.decision_policy_version === QIANCHUAN_LEGACY_POLICY
      && fieldsList.every((item) => item.decisionPolicyVersion === QIANCHUAN_LEGACY_POLICY);
    // Use normalized item policies, not optional envelope fields: omitting the
    // top-level policy/group must not permit a mixed v2 delivery.
    const mixedV2 = fieldsList.some((item) => item.decisionPolicyVersion === QIANCHUAN_UPSTREAM_POLICY)
      && new Set(fieldsList.map((item) => item.decisionGroup)).size > 1;
    if (mixedV2
        || (body.source_batch_id !== undefined && fieldsList.some((item) => item.sourceBatchId !== body.source_batch_id))
        || (body.decision_policy_version !== undefined && fieldsList.some((item) => item.decisionPolicyVersion !== body.decision_policy_version))
        || (!legacyUnified && body.decision_group !== undefined && fieldsList.some((item) => item.decisionGroup !== body.decision_group))) {
      throw new DispatchIngestError('QIANCHUAN_BATCH_ITEM_CONFLICT', '批次级与需求级决策字段不一致');
    }
    if (!Array.isArray(body.decision_snapshot) || !body.decision_snapshot.length || body.decision_snapshot.length > 1000) {
      throw new DispatchIngestError('QIANCHUAN_SOURCE_SNAPSHOT_REQUIRED', '千川 v2 必须携带拆卡前完整有序 decision_snapshot');
    }
    if (body.decision_snapshot_hash !== decisionSnapshotHash(body.decision_snapshot)) {
      throw new DispatchIngestError('QIANCHUAN_SNAPSHOT_HASH_MISMATCH', '完整快照内容或顺序与哈希不一致');
    }
    const sourceBatchId = fieldsList[0].sourceBatchId;
    const policyVersion = fieldsList[0].decisionPolicyVersion;
    const snapshotFields = body.decision_snapshot.map((item) => normalizeDispatchIngest({
      ...item, chat_id: chatId,
      source_batch_id: item.source_batch_id ?? body.source_batch_id ?? sourceBatchId,
      decision_policy_version: item.decision_policy_version ?? body.decision_policy_version ?? policyVersion,
    }).fields);
    if ([...fieldsList, ...snapshotFields].some((item) => item.sourceBatchId !== sourceBatchId
        || item.decisionPolicyVersion !== policyVersion || item.dispatchScope !== fieldsList[0].dispatchScope)) {
      throw new DispatchIngestError('QIANCHUAN_MIXED_SOURCE_POLICY', '同一原始批次必须使用同一千川策略和范围');
    }
    qianchuanSnapshot = buildQianchuanSnapshot({ sourceBatchId, policyVersion,
      upstreamSnapshotHash: body.decision_snapshot_hash ?? fieldsList[0].decisionSnapshotHash,
      sourceSnapshot: body.decision_snapshot,
      members: snapshotFields.map((fields, index) => decisionMember(fields, index)) });
    if (snapshotFields.some((item) => item.decisionSnapshotHash
        && item.decisionSnapshotHash !== qianchuanSnapshot.upstreamSnapshotHash)) {
      throw new DispatchIngestError('QIANCHUAN_DELIVERY_SNAPSHOT_MISMATCH', '完整批次中的哈希不一致');
    }
    fieldsList = fieldsList.map((fields) => {
      const member = qianchuanSnapshot.members.find((item) => item.requestId === fields.requestId);
      const { assignmentGroup: _assignmentGroup, ...sourceMember } = member || {};
      if (!member || stableJson(decisionMember(fields, member.sourcePosition)) !== stableJson(sourceMember)
          || (fields.decisionSnapshotHash && fields.decisionSnapshotHash !== qianchuanSnapshot.upstreamSnapshotHash)
          || (fields.decisionManifestHash && fields.decisionManifestHash !== qianchuanSnapshot.snapshotHash)
          || (fields.sourcePosition !== undefined && fields.sourcePosition !== member.sourcePosition)) {
        throw new DispatchIngestError('QIANCHUAN_DELIVERY_SNAPSHOT_MISMATCH', '投递内容与完整批次决策快照不一致');
      }
      return { ...fields, sourcePosition: member.sourcePosition,
        decisionSnapshotHash: qianchuanSnapshot.upstreamSnapshotHash, decisionManifestHash: qianchuanSnapshot.snapshotHash };
    });
  }
  const scopes = new Set(fieldsList.map((item) => item.dispatchScope));
  if (scopes.size !== 1) {
    throw new DispatchIngestError('MIXED_DISPATCH_SCOPE', '同一批次不能混合生产与隔离名单或不同隔离 run_id');
  }
  const suppliedBatchId = String(body.batch_id || '').trim();
  const batchId = suppliedBatchId || createHash('sha256')
    .update(`${chatId}:${fieldsList.map((item) => item.requestId).join(',')}`)
    .digest('hex')
    .slice(0, 24);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
    throw new DispatchIngestError('INVALID_BATCH_ID', '批次 ID 格式不正确');
  }
  const cardLayout = body.card_layout && typeof body.card_layout === 'object' && !Array.isArray(body.card_layout)
    ? { version: String(body.card_layout.version || '').trim() }
    : null;
  return { chatId, fieldsList, cardTitle: String(body.card_title || '').trim(), batchId, period, cardLayout,
    ...(qianchuanSnapshot ? { qianchuanSnapshot } : {}) };
}

export function dispatchIdempotencyValue(fields) {
  const { riskLevel: _riskLevel, rejectReason: _rejectReason, ...stableFields } = fields;
  return stableFields;
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
    dispatch_profile: fields.dispatchProfile,
    card_title: fields.cardTitle,
    created_at: fields.createdAt,
    creator: fields.creator,
    risk_level: fields.riskLevel,
    reject_reason: fields.rejectReason,
    sheet_url: fields.sheetUrl,
    sheet_id: fields.sheetId,
    row_index: fields.rowIndex,
    request_field_id: fields.requestFieldId,
    request_field_name: fields.requestFieldName,
    date_field_id: fields.dateFieldId,
    date_field_name: fields.dateFieldName,
    assignee_field_id: fields.assigneeFieldId,
    assignee_field_name: fields.assigneeFieldName,
    project_field_id: fields.projectFieldId,
    project_field_name: fields.projectFieldName,
    project_value: fields.projectValue,
    batch_card: fields.batchCard === true,
    ...qianchuanActionFields(fields),
  };
}
