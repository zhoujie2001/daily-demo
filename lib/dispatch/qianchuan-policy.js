import { createHash } from 'node:crypto';

export const QIANCHUAN_CONTRACT = 'qianchuan-review/v2';
export const QIANCHUAN_SERVER_POLICY = 'qianchuan-grouped/v1';
export const QIANCHUAN_UPSTREAM_POLICY = 'code-membership-1000676/v2';
export const QIANCHUAN_LEGACY_POLICY = 'code-membership-1005004/v1';
const POLICY_CODES = Object.freeze({
  [QIANCHUAN_UPSTREAM_POLICY]: '1000676',
  [QIANCHUAN_LEGACY_POLICY]: '1005004',
});
export const QIANCHUAN_ITEM_KEYS = Object.freeze([
  'audit_object_id', 'reject_reason_codes', 'contains_code_1005004', 'contains_code_1000676', 'decision_group',
  'decision_policy_version', 'source_batch_id', 'decision_snapshot_hash', 'decision_manifest_hash', 'source_position',
]);

export function policyError(code, message = code) {
  return Object.assign(new Error(message), { code, userMessage: message,
    status: code === 'QIANCHUAN_SOURCE_CONFLICT' ? 409 : 400 });
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const SNAPSHOT_RUNTIME_KEYS = new Set([
  'decision_snapshot_hash', 'decision_manifest_hash', 'source_position',
  'batch_id', 'operation_id', 'message_id', 'record_id', 'signature', 'authorization',
  'automation_token', 'secret', 'retry_count', 'retry_at',
]);

// Canonical snapshot v1: UTF-8, recursively sorted ASCII object keys, compact
// JSON, unescaped Unicode, unchanged ARRAY order, finite safe integers only.
// Matches Python json.dumps(..., ensure_ascii=False, sort_keys=True,
// separators=(',', ':'), allow_nan=False) for this deliberately bounded schema.
export function decisionSnapshotHash(snapshot) {
  const active = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 16) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
    if (typeof value === 'string') {
      for (const character of value) {
        const point = character.codePointAt(0);
        if (point >= 0xd800 && point <= 0xdfff) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
      }
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
      return;
    }
    if (typeof value !== 'object' || active.has(value)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
    active.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) visit(value[i], depth + 1);
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (!/^[\x20-\x7e]+$/.test(key)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
        if (SNAPSHOT_RUNTIME_KEYS.has(key)) throw policyError('QIANCHUAN_SNAPSHOT_RUNTIME_FIELD', `完整快照不得包含运行字段 ${key}`);
        visit(child, depth + 1);
      }
    }
    active.delete(value);
  };
  if (!Array.isArray(snapshot)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_JSON');
  visit(snapshot);
  return createHash('sha256').update(stableJson(snapshot), 'utf8').digest('hex');
}

function text(value, field, { empty = false } = {}) {
  // Never stringify an already rounded numeric audit ID.
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 256) {
    throw policyError('QIANCHUAN_INVALID_CONTRACT', `${field} 必须是有效字符串`);
  }
  return value.trim();
}

export function normalizeReasonCodes(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some((code) => typeof code !== 'string')) {
    throw policyError('QIANCHUAN_INVALID_REASON_CODES', '拒绝代码必须为字符串数组');
  }
  const codes = [...new Set(value.map((code) => code.trim()).filter(Boolean))].sort();
  if (codes.some((code) => !/^\d{1,32}$/.test(code))) throw policyError('QIANCHUAN_INVALID_REASON_CODES');
  return codes;
}

export function hasQianchuanMetadata(value) {
  // source_batch_id alone is generic provenance used by other workflows.
  return QIANCHUAN_ITEM_KEYS.filter((key) => !['source_batch_id', 'source_position'].includes(key))
    .some((key) => Object.hasOwn(value || {}, key));
}

export function normalizeQianchuanItem(value, fields) {
  if (!hasQianchuanMetadata(value)) return {};
  if (fields.targetCategory !== 'qianchuan' || !['千川', 'qianchuan'].includes(fields.businessType)
      || !['default', 'test_default'].includes(fields.dispatchScope) || fields.dispatchDirection !== 'forward') {
    throw policyError('QIANCHUAN_POLICY_FORBIDDEN', '该决策策略仅用于千川大盘');
  }
  const codes = normalizeReasonCodes(value.reject_reason_codes);
  const specialCode = Object.hasOwn(POLICY_CODES, value.decision_policy_version) ? POLICY_CODES[value.decision_policy_version] : null;
  if (!specialCode) throw policyError('UNSUPPORTED_QIANCHUAN_POLICY', '千川决策策略版本未受支持');
  const flag = `contains_code_${specialCode}`;
  const otherFlag = specialCode === '1000676' ? 'contains_code_1005004' : 'contains_code_1000676';
  if (Object.hasOwn(value, otherFlag)) throw policyError('QIANCHUAN_REASON_FLAG_CONFLICT', '禁止混用新旧决策字段');
  if (value[flag] !== codes.includes(specialCode)) {
    throw policyError('QIANCHUAN_REASON_FLAG_CONFLICT', '拒绝代码与标记不一致');
  }
  const deliveryGroup = `${codes.includes(specialCode) ? 'contains' : 'without'}_${specialCode}`;
  if (value.decision_group !== deliveryGroup) {
    throw policyError('QIANCHUAN_INVALID_DELIVERY_GROUP', '投递分桶必须与拒绝代码精确匹配');
  }
  const result = {
    auditObjectId: text(value.audit_object_id, 'audit_object_id', { empty: true }),
    rejectReasonCodes: codes, containsSpecialReason: codes.includes(specialCode),
    [`containsCode${specialCode}`]: codes.includes(specialCode),
    decisionGroup: text(value.decision_group, 'decision_group'),
    decisionPolicyVersion: text(value.decision_policy_version, 'decision_policy_version'),
    sourceBatchId: text(value.source_batch_id, 'source_batch_id'),
  };
  if (value.decision_snapshot_hash !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.decision_snapshot_hash)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_HASH');
    result.decisionSnapshotHash = value.decision_snapshot_hash;
  }
  if (value.decision_manifest_hash !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.decision_manifest_hash)) throw policyError('QIANCHUAN_INVALID_MANIFEST_HASH');
    result.decisionManifestHash = value.decision_manifest_hash;
  }
  if (value.source_position !== undefined) {
    if (!Number.isSafeInteger(value.source_position) || value.source_position < 0) throw policyError('QIANCHUAN_INVALID_SOURCE_POSITION');
    result.sourcePosition = value.source_position;
  }
  return result;
}

export function qianchuanActionFields(fields) {
  if (!fields?.sourceBatchId) return {};
  const specialCode = Object.hasOwn(POLICY_CODES, fields.decisionPolicyVersion) ? POLICY_CODES[fields.decisionPolicyVersion] : null;
  if (!specialCode) throw policyError('UNSUPPORTED_QIANCHUAN_POLICY');
  return {
    audit_object_id: fields.auditObjectId, reject_reason_codes: fields.rejectReasonCodes,
    [`contains_code_${specialCode}`]: fields.containsSpecialReason ?? fields[`containsCode${specialCode}`], decision_group: fields.decisionGroup,
    decision_policy_version: fields.decisionPolicyVersion, source_batch_id: fields.sourceBatchId,
    decision_snapshot_hash: fields.decisionSnapshotHash, source_position: fields.sourcePosition,
    decision_manifest_hash: fields.decisionManifestHash,
  };
}

// Original source order, BEFORE any grouping, sorting, delivery or card split.
// Object reuse wins over reason grouping. Missing object IDs are never grouped together.
export function expectedDecisionGroups(items) {
  const special = (item) => item.containsSpecialReason ?? item.containsCode1000676 ?? item.containsCode1005004;
  const objectGroups = new Map();
  const result = [];
  let nextGroup = 0;
  for (let start = 0; start < items.length;) {
    let end = start + 1;
    if (special(items[start])) {
      while (end < items.length && special(items[end])) end += 1;
    }
    let runGroup;
    for (let index = start; index < end; index += 1) {
      const item = items[index];
      let group = item.auditObjectId ? objectGroups.get(item.auditObjectId) : undefined;
      if (group === undefined) {
        if (special(item) && end - start === 1 && index > 0) group = result[index - 1];
        else if (end - start >= 2) group = runGroup ??= nextGroup++;
        else group = nextGroup++;
      }
      result.push(group);
      if (item.auditObjectId && !objectGroups.has(item.auditObjectId)) objectGroups.set(item.auditObjectId, group);
    }
    start = end;
  }
  return result;
}

export function decisionMember(fields, sourcePosition) {
  return {
    requestId: fields.requestId, auditObjectId: fields.auditObjectId,
    rejectReasonCodes: fields.rejectReasonCodes, containsSpecialReason: fields.containsSpecialReason,
    ...(fields.containsCode1005004 !== undefined ? { containsCode1005004: fields.containsCode1005004 } : {}),
    ...(fields.containsCode1000676 !== undefined ? { containsCode1000676: fields.containsCode1000676 } : {}),
    decisionGroup: fields.decisionGroup, sourcePosition,
    sheetUrl: fields.sheetUrl, sheetId: fields.sheetId, rowIndex: fields.rowIndex,
    assigneeFieldId: fields.assigneeFieldId, assigneeFieldName: fields.assigneeFieldName,
    requestFieldId: fields.requestFieldId, requestFieldName: fields.requestFieldName,
    dateFieldId: fields.dateFieldId, dateFieldName: fields.dateFieldName,
    projectFieldId: fields.projectFieldId, projectFieldName: fields.projectFieldName,
    projectValue: fields.projectValue,
  };
}

export function buildQianchuanSnapshot({ sourceBatchId, policyVersion, upstreamSnapshotHash, sourceSnapshot, members }) {
  if (!Array.isArray(members) || !members.length || members.length > 1000
      || new Set(members.map((item) => item.requestId)).size !== members.length) {
    throw policyError('QIANCHUAN_INVALID_SNAPSHOT');
  }
  if (!/^[a-f0-9]{64}$/.test(upstreamSnapshotHash)) throw policyError('QIANCHUAN_INVALID_SNAPSHOT_HASH');
  if (decisionSnapshotHash(sourceSnapshot) !== upstreamSnapshotHash) throw policyError('QIANCHUAN_SNAPSHOT_HASH_MISMATCH');
  if (new Set(members.map((item) => stableJson([item.sheetUrl, item.sheetId,
    item.assigneeFieldId, item.assigneeFieldName, item.requestFieldId, item.requestFieldName,
    item.dateFieldId, item.dateFieldName]))).size !== 1) throw policyError('QIANCHUAN_MIXED_SHEET_CONTRACT');
  const expected = expectedDecisionGroups(members);
  // decision_group is an upstream DELIVERY BUCKET (e.g. contains_1005004),
  // never an authorization to share an assignee. Compute a separate grouping.
  const planned = members.map((item, index) => ({ ...item, assignmentGroup: `g${expected[index]}` }));
  const snapshot = { contract: QIANCHUAN_CONTRACT, serverPolicy: QIANCHUAN_SERVER_POLICY,
    sourceBatchId, policyVersion, upstreamSnapshotHash, sourceSnapshot: structuredClone(sourceSnapshot), members: planned };
  return { ...snapshot, snapshotHash: createHash('sha256').update(stableJson(snapshot)).digest('hex') };
}

export function assertQianchuanCard(items) {
  const active = items.filter((item) => item.sourceBatchId);
  if (!active.length) return false;
  if (active.length !== items.length || items.length > 20
      || active.some((item) => !item.decisionSnapshotHash || !item.decisionManifestHash || !Number.isSafeInteger(item.sourcePosition))
      || new Set(active.map((item) => `${item.sourceBatchId}:${item.decisionPolicyVersion}:${item.decisionSnapshotHash}:${item.decisionManifestHash}`)).size !== 1) {
    throw policyError('QIANCHUAN_INVALID_CARD_CONTRACT', '千川决策卡缺少统一的完整批次绑定');
  }
  return true;
}

export async function registerQianchuanSource(store, normalized, current) {
  if (!normalized?.qianchuanSnapshot) return;
  if (typeof store.registerQianchuanSource !== 'function') {
    throw policyError('QIANCHUAN_STORE_REQUIRED', '千川分组事务尚未安装，已拒绝旧路径回退');
  }
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(current);
  const result = await store.registerQianchuanSource({ snapshot: normalized.qianchuanSnapshot,
    scope: normalized.fieldsList[0].dispatchScope, dayKey });
  if (!['ACCEPTED', 'REUSED'].includes(result?.outcome)) throw policyError('QIANCHUAN_SOURCE_RECEIPT_INVALID');
}
