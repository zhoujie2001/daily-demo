// Business orchestration for BESS auto-dispatch card actions (P0 scope):
// validate -> create thread via reply -> build the updated original card, then
// hand a delayed card-update task back to the HTTP layer. The HTTP layer first
// acknowledges the callback and only then schedules the OpenAPI update.
//
// P0 deliberately does NOT write sheets/Bitable or resolve the assignee
// roster; those arrive in P1. This module never logs tokens or secrets and
// always returns a callback response body (toast) for business errors so the
// Feishu client shows an understandable message instead of a generic failure.

import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { LarkApiError } from '../lark/client.js';
import {
  parseCardActionEvent,
  validateDispatchValue,
  validateBatchDispatchValue,
  validateAdjustStatusValue,
  validateAdjustStatusSubmitValue,
  validateSpecifyAssigneeValue,
  DISPATCH_ACTION,
  BATCH_DISPATCH_ACTION,
  ADJUST_STATUS_ACTION,
  ADJUST_STATUS_SUBMIT_ACTION,
  SPECIFY_ASSIGNEE_ACTION,
  BATCH_STATUS,
  AD_SHEET_ID,
  MAIN_SHEET_ID,
  QIANCHUAN_SHEET_ID,
  LOCAL_PROMO_SHEET_ID,
  LEGACY_QIANCHUAN_SHEET_ID,
  LEGACY_LOCAL_PROMO_SHEET_ID,
  parseAllowedChatIds,
  isFeatureEnabled,
  DispatchValidationError,
} from '../lark/card-actions.js';
import { createSupabaseDispatchStore } from './supabase-store.js';
import { batchDispatchActionValue } from './ingest.js';
import { isAdIsolationScope, resolveDispatchProfile } from './profile.js';
import { parseRoster, resolveShuffleRoster, secureShuffle, shanghaiDay, nextShanghaiMidnight, RosterValidationError } from './roster.js';
import { inspectLatestDailyAnchor, projectMatches, sheetDateDay } from './sheet-anchor.js';
import { readAnchorSnapshot } from './anchor-snapshot.js';
import { ANCHOR_RECOVERY } from './safe-anchor.js';
import {
  patchCardForDispatched,
  buildInitialDispatchCard,
  buildDispatchedCard,
  buildDispatchThreadText,
  buildRosterFormCard,
  buildRosterSavedCard,
  buildRosterCompletedCard,
  buildSpecifyAssigneeFormCard,
  buildSpecifyAssigneeCompletedCard,
  buildAdjustStatusFormCard,
  buildAdjustStatusSuccessCard,
  buildDispatchResultCard,
  buildBatchStatusCard,
  buildBatchDispatchResultCard,
  formatDispatchTime,
} from '../lark/card-renderer.js';

// Single-item actions retain their historical best-effort warm-instance guard.
// Batch actions never use it: they require the store's atomic persistent claim.
const inFlight = new Set();
const completed = new Set();

function normalizeProfileContext(context, chatId) {
  const profile = resolveDispatchProfile({
    dispatchProfile: context?.dispatchProfile,
    businessType: context?.businessType,
    targetCategory: context?.targetCategory,
    sheetId: context?.sheetId,
    dateFieldId: context?.dateFieldId,
    assigneeFieldId: context?.assigneeFieldId,
    chatId,
  });
  if (profile.errorCode) throw new DispatchValidationError(profile.errorCode, profile.errorMessage);
  return {
    ...context,
    targetCategory: context?.targetCategory || profile.resolvedTargetCategory || '',
    dispatchProfile: profile.name,
    dispatchScope: profile.scope,
    dispatchDirection: profile.direction,
  };
}

function normalizeRestoredContext(context, chatId) {
  if (context?.kind === 'batch') {
    if (!Array.isArray(context.items)) {
      throw new DispatchValidationError('INVALID_BATCH_SIZE', '批量派单上下文缺少需求列表');
    }
    return { ...context, items: context.items.map((item) => normalizeProfileContext(item, chatId)) };
  }
  return normalizeProfileContext(context, chatId);
}

export function enforceAssigneeFieldContract(context) {
  if (context?.kind === 'batch') {
    return { ...context, items: context.items.map(enforceAssigneeFieldContract) };
  }
  const targetCategory = String(context?.targetCategory || '').trim().toLowerCase();
  const sheetId = String(context?.sheetId || '').trim();
  // 锚点扫描必须与派单写入严格同列，且由服务端按「表 + 业态」锁定，
  // 避免旧卡或伪造参数把扫描扩大到共同回扫人/领取人等相邻协作列。
  if (['ad', 'game_agent'].includes(targetCategory)) {
    return { ...context, assigneeFieldId: 'B', assigneeFieldName: '姓名' };
  }
  if (sheetId === AD_SHEET_ID && ['qianchuan_ad', 'ehc_emergency_ad'].includes(targetCategory)) {
    return { ...context, assigneeFieldId: 'F', assigneeFieldName: '回扫人' };
  }
  if (sheetId === QIANCHUAN_SHEET_ID && targetCategory === 'qianchuan') {
    return { ...context, assigneeFieldId: 'N', assigneeFieldName: '领取人' };
  }
  if (sheetId === LOCAL_PROMO_SHEET_ID && targetCategory === 'local_promo') {
    return { ...context, assigneeFieldId: 'L', assigneeFieldName: '领取人' };
  }
  if (sheetId === LEGACY_QIANCHUAN_SHEET_ID && targetCategory === 'qianchuan') {
    return { ...context, assigneeFieldId: 'O', assigneeFieldName: '领取人' };
  }
  if (sheetId === LEGACY_LOCAL_PROMO_SHEET_ID && targetCategory === 'local_promo') {
    return { ...context, assigneeFieldId: 'M', assigneeFieldName: '领取人' };
  }
  if (sheetId === 'TQuzLA' && ['qianchuan', 'local_promo'].includes(targetCategory)) {
    return { ...context, assigneeFieldId: 'J', assigneeFieldName: '执行人' };
  }
  if (sheetId === MAIN_SHEET_ID) {
    return { ...context, assigneeFieldId: 'I', assigneeFieldName: '跟进方' };
  }
  return context;
}

function profileScope(context) {
  if (context?.dispatchScope) return context.dispatchScope;
  if (['ad', 'test_default'].includes(context?.dispatchProfile)
      || isAdIsolationScope(context?.dispatchProfile)) {
    throw new DispatchValidationError('MISSING_DERIVED_SCOPE', '派单缺少服务端派生 scope，已停止执行');
  }
  return 'default';
}

function profileDirection(context) {
  const dir = String(context?.dispatchDirection || '').toLowerCase();
  if (dir === 'emergency_forward') return 'emergency_forward';
  if (dir === 'forward' || dir === '正序') return 'forward';
  if (dir === 'reverse' || dir === 'backward' || dir === '倒序') return 'reverse';
  return context?.target_category === 'stock' ? 'reverse' : 'forward';
}

export function enforceSingleBatchScope(items) {
  const scopes = new Set((items || []).map((item) => profileScope(item)));
  if (scopes.size !== 1) {
    throw new DispatchValidationError('MIXED_DISPATCH_SCOPE', '同一批次不能混合不同派单名单（含 AD 大盘与游戏货不对板）');
  }
  return scopes.values().next().value;
}

export function batchDispatchFingerprint(items) {
  const stableItems = items.map((item) => {
    const stableItem = { ...item };
    // Historical derived profiles were deliberately excluded for retry
    // compatibility. Dynamic isolation profile is caller contract and contains
    // the run namespace, so retaining it prevents cross-run batch reuse.
    if (!isAdIsolationScope(item.dispatchScope || item.dispatchProfile)) {
      delete stableItem.dispatchProfile;
      delete stableItem.dispatchScope;
    }
    delete stableItem.dispatchDirection;
    return stableItem;
  });
  return createHash('sha256').update(JSON.stringify(stableItems)).digest('hex');
}

function toast(type, content) {
  return { toast: { type, content } };
}

function safeLog(logger, stage, fields) {
  try {
    const writer = fields?.severity === 'warn' && typeof logger?.warn === 'function'
      ? logger.warn.bind(logger)
      : logger?.info?.bind(logger);
    writer?.(JSON.stringify({ module: 'bess-dispatch', stage, ...fields }));
  } catch {
    // logging must never break the callback
  }
}

function replyUuidFor(requestId) {
  // Feishu uuid allows letters/digits/hyphen/underscore, max 50 chars.
  return `bess-dispatch-${requestId}`.slice(0, 50);
}

function validateSheetTarget(fields) {
  if (!fields.sheetUrl || !fields.sheetId || !fields.rowIndex || (!fields.assigneeFieldId && !fields.assigneeFieldName)) {
    throw new DispatchValidationError('INVALID_SHEET_TARGET', '按钮缺少电子表格地址、工作表、行号或负责人字段配置');
  }
  if (fields.assigneeFieldId && !/^[A-Z]{1,3}$/.test(fields.assigneeFieldId)) {
    throw new DispatchValidationError('INVALID_ASSIGNEE_FIELD', '负责人列字母格式不正确');
  }
}

async function readTargetAndAnchor({
  client, fields, dayKey, roster, store,
}) {
  return readAnchorSnapshot({
    store, dayKey, scope: profileScope(fields),
    inspect: ({ state, assignments }) => inspectTargetAndAnchor({
      client, fields, dayKey, roster: state?.roster || roster || [], store, state, persisted: assignments,
    }),
  });
}

async function inspectTargetAndAnchor({ client, fields, dayKey, roster, store, state, persisted }) {
  const effectiveRoster = roster || [];
  let targetScanComplete = false;
  let resolvedRowIndex = fields.rowIndex;
  if (typeof client.locateSheetRequestRow === 'function') {
    const located = await client.locateSheetRequestRow(fields);
    if (!located?.scanComplete || !Number.isInteger(located.rowIndex)) {
      throw new DispatchValidationError(ANCHOR_RECOVERY.SCAN_INCOMPLETE, '需求 ID 定位扫描不完整，已停止派单');
    }
    targetScanComplete = true;
    // request_id is identity; keep the claimed item immutable and carry the
    // physical row only in this runtime observation.
    resolvedRowIndex = located.rowIndex;
  }
  let valueAtTargetRow = null;
  let anchorResult = {
    anchor: null, previousAssignee: null, hasRelevantAssignment: false, invalidAssignee: null,
  };
  const allowBlankProject = Boolean(fields.projectValue)
    && !['TQuzLA', MAIN_SHEET_ID].includes(fields.sheetId);
  const scope = profileScope(fields);
  const sameScope = (row) => {
    const context = typeof row.request_context === 'string' ? JSON.parse(row.request_context) : row.request_context || {};
    const recordedScope = String(context.dispatchScope || context.rotation_scope || '').trim();
    if (recordedScope && recordedScope !== scope) return false;
    if (String(context.sheetId || context.sheet_id || '') !== String(fields.sheetId)) return false;
    if (!fields.projectValue) {
      // Sheets without a project column are isolated by their concrete sheet and
      // business semantics. Never let a stock/local request inherit a Qianchuan
      // anchor merely because both records omit project_value.
      return String(context.businessType || context.business_type || '').trim()
        === String(fields.businessType || '').trim();
    }
    return projectMatches(context.projectValue || context.project_value, fields.projectValue);
  };
  const scoped = persisted.filter(sameScope);
  const expectedByRow = new Map();
  for (const row of scoped) {
    const context = typeof row.request_context === 'string' ? JSON.parse(row.request_context) : row.request_context || {};
    const rowIndex = Number(context.rowIndex || context.row_index);
    // Rows arrive newest first; an older ledger record must not replace the
    // latest value and turn an automatic row into a false manual edit.
    if (!expectedByRow.has(rowIndex)) expectedByRow.set(rowIndex, String(row.assignee || '').trim());
  }
  const durableAnchor = scoped.find((row) => effectiveRoster.includes(String(row.assignee || '').trim()));
  const durableContext = durableAnchor
    ? (typeof durableAnchor.request_context === 'string'
      ? JSON.parse(durableAnchor.request_context) : durableAnchor.request_context || {})
    : {};
  const durableAnchorRow = Number(durableContext.rowIndex || durableContext.row_index || -1);
  if (isAdIsolationScope(scope)) {
    // Isolation runs may share the production sheet target, but must never use
    // production/manual sheet history as a rotation anchor. Only the scoped DB
    // ledger/cursors are authoritative; the target cell is read solely to avoid
    // overwriting an existing assignment.
    if (typeof client.readSheetAssignee !== 'function') {
      throw new DispatchValidationError(
        'ISOLATION_TARGET_READ_UNAVAILABLE',
        '隔离派单无法安全核验目标负责人，已停止执行',
      );
    }
    valueAtTargetRow = await client.readSheetAssignee({ ...fields, rowIndex: resolvedRowIndex });
    const existingAssignment = await store.getAssignment(dayKey, fields.requestId, scope);
    return {
      valueAtTargetRow: String(valueAtTargetRow || '').trim(),
      existingAssignment,
      state,
      calibrationRequired: false,
      recoveryStatus: targetScanComplete ? ANCHOR_RECOVERY.NO_HISTORY_CONFIRMED : null,
      resolvedRowIndex,
      anchorRow: durableAnchorRow,
      anchor: durableAnchor?.assignee || null,
      previousAssignee: null,
      hasRelevantAssignment: Boolean(durableAnchor),
      invalidAssignee: null,
    };
  }
  let sheetAnchorRow = -1;
  let manualAnchor = null;
  let manualAnchorRow = -1;
  await client.readSheetDispatchRows({
    sheetUrl: fields.sheetUrl,
    sheetId: fields.sheetId,
    dateFieldId: fields.dateFieldId,
    dateFieldName: fields.dateFieldName,
    assigneeFieldId: fields.assigneeFieldId,
    assigneeFieldName: fields.assigneeFieldName,
    projectFieldId: fields.projectValue ? fields.projectFieldId : '',
    projectFieldName: fields.projectValue ? fields.projectFieldName : '',
    selectLatest: (rows, startRow) => {
      const relativeIndex = resolvedRowIndex - startRow;
      if (relativeIndex >= 0 && relativeIndex < rows.length) {
        valueAtTargetRow = String(rows[relativeIndex][1] || '').trim();
      }
      if (rows.length > 0) {
        const rowsThroughTarget = relativeIndex >= 0 ? rows.slice(0, relativeIndex + 1) : rows;
        const candidate = inspectLatestDailyAnchor(rowsThroughTarget, {
          targetDay: dayKey, roster: effectiveRoster, projectValue: fields.projectValue, allowBlankProject,
        });
        // The sheet is the fact source for every non-first batch. Persisted
        // assignments/cursors may be stale (for example after a manual edit or
        // an earlier partial run), so never discard a valid latest sheet anchor
        // merely because some daily DB rows exist.
        if (candidate.anchor) {
          const candidateRow = startRow + Number(candidate.anchorRowOffset ?? -1);
          if (!durableAnchor || candidateRow >= durableAnchorRow) {
            anchorResult = candidate;
            sheetAnchorRow = candidateRow;
          }
        }
        rows.forEach((row, index) => {
          const absoluteRow = startRow + index;
          const assignee = String(row?.[1] || '').trim();
          if (sheetDateDay(row?.[0], dayKey) !== dayKey
              || !projectMatches(row?.[2], fields.projectValue, { allowBlank: allowBlankProject })
              || !effectiveRoster.includes(assignee)) return;
          // Sheets expose values but no trustworthy cell edit time. A roster
          // value absent from, or different to, our persisted row assignment is
          // considered manual. If several such edits exist, highest row wins: a
          // deterministic and explainable fallback, not a claimed timestamp.
          if (expectedByRow.get(absoluteRow) !== assignee && absoluteRow >= manualAnchorRow && absoluteRow <= resolvedRowIndex) {
            manualAnchor = assignee;
            manualAnchorRow = absoluteRow;
          }
        });
      }
      return null;
    },
  });

  const newestKnownRow = Math.max(sheetAnchorRow, durableAnchorRow);
  const automaticAnchor = sheetAnchorRow >= durableAnchorRow
    ? anchorResult.anchor : durableAnchor?.assignee;
  const effectiveAnchor = String(
    manualAnchor && manualAnchorRow >= newestKnownRow ? manualAnchor : automaticAnchor || '',
  ).trim();
  if (effectiveAnchor) {
    anchorResult = {
      anchor: effectiveAnchor, previousAssignee: effectiveAnchor,
      hasRelevantAssignment: true, invalidAssignee: null,
    };
  }
  // Automatic ledger anchors have already advanced the durable cursor. Only a
  // factual manual edit may calibrate it; lifting an old automatic name to the
  // next congruent lap would skip people despite a numerically monotonic cursor.
  const calibrationRequired = Boolean(manualAnchor && manualAnchorRow >= newestKnownRow);
  anchorResult.previousAssignee = calibrationRequired ? effectiveAnchor || null : null;
  const recoveryStatus = effectiveAnchor
    ? ANCHOR_RECOVERY.ANCHOR_FOUND
    : targetScanComplete ? ANCHOR_RECOVERY.NO_HISTORY_CONFIRMED : null;
  const existingAssignment = await store.getAssignment(dayKey, fields.requestId, scope);
  return { valueAtTargetRow, existingAssignment, state, calibrationRequired, recoveryStatus,
    resolvedRowIndex, anchorRow: calibrationRequired ? manualAnchorRow : newestKnownRow, ...anchorResult };
}

function cursorVersion(state, direction) {
  if (direction === 'emergency_forward') return state?.emergency_forward_version;
  return direction === 'forward' ? state?.forward_version : state?.reverse_version;
}

function assertTargetMatchesAssignment({ valueAtTargetRow, existingAssignment }) {
  if (valueAtTargetRow && existingAssignment
      && String(existingAssignment.assignee || '').trim() !== String(valueAtTargetRow).trim()) {
    throw new DispatchValidationError('SHEET_ASSIGNMENT_MISMATCH', '表格负责人与已落库派单不一致，未覆盖；请人工核对后处理');
  }
}

async function calibrateFilledTarget({ store, dayKey, scope, direction, assignee, roster, expectedVersion, expectedCursorVersion }) {
  if (typeof store.calibrateCursor !== 'function') {
    throw new Error('Persistent cursor calibration is unavailable');
  }
  return store.calibrateCursor({
    dayKey, scope, direction, assignee, roster, expectedVersion, expectedCursorVersion,
  });
}

async function calibrateAndAssign({ store, dayKey, scope, requestId, direction, assignee, roster, expiresAt, context, expectedVersion, expectedCursorVersion }) {
  if (typeof store.calibrateAndAssign !== 'function') {
    throw new DispatchValidationError('ATOMIC_ANCHOR_RECOVERY_UNAVAILABLE',
      '当前存储不支持校准与派单原子合并，已停止派单（TODO: 部署安全锚点恢复 RPC）');
  }
  return store.calibrateAndAssign({
    dayKey, scope, requestId, direction, assignee, roster, expiresAt, context,
    expectedVersion, expectedCursorVersion,
  });
}

function applyDirectionalCursorFallback(state, roster, assignments = []) {
  const fallback = { ...(state || {}), roster };
  for (const { direction, assignee } of assignments) {
    const normalizedDir = direction?.toLowerCase();
    if (!['forward', 'reverse', 'backward', 'emergency_forward'].includes(normalizedDir)) continue;
    const index = roster.findIndex((name) => String(name || '').trim() === String(assignee || '').trim());
    if (index < 0) continue;
    if (normalizedDir === 'forward') fallback.forward_cursor = index + 1;
    else if (normalizedDir === 'emergency_forward') fallback.emergency_forward_cursor = index + 1;
    else fallback.reverse_cursor = roster.length - index;
  }
  return fallback;
}

function latestSuccessfulAssignments(fieldsList, results) {
  const fieldsByRequestId = new Map(fieldsList.map((fields) => [fields.requestId, fields]));
  const byDirection = new Map();
  for (const result of results) {
    if (result.status !== 'SUCCESS' || !result.assignee) continue;
    const fields = fieldsByRequestId.get(result.requestId);
    if (!fields) continue;
    const direction = profileDirection(fields);
    byDirection.set(direction, { direction, assignee: result.assignee });
  }
  return [...byDirection.values()];
}

async function refreshDailyStateForCard({
  store, dayKey, scope, current, fallbackState, fallbackRoster, fallbackAssignments,
  log, logBase, flow,
}) {
  try {
    const refreshed = await store.getDailyState(dayKey, scope, current);
    if (refreshed && Array.isArray(refreshed.roster)) return refreshed;
    log('daily_state_refresh_warning', {
      ...logBase, severity: 'warn', flow, error_code: 'DAILY_STATE_NOT_FOUND',
    });
  } catch (error) {
    log('daily_state_refresh_warning', {
      ...logBase, severity: 'warn', flow,
      error_code: error?.code || 'DAILY_STATE_REFRESH_FAILED',
    });
  }

  const roster = Array.isArray(fallbackState?.roster)
    ? fallbackState.roster
    : Array.isArray(fallbackRoster) ? fallbackRoster : [];
  return applyDirectionalCursorFallback(fallbackState, roster, fallbackAssignments);
}

function isAdStatusConfirmationValid(state, scope) {
  if (!['ad_review', 'ad_game'].includes(scope)) return true;
  return state?.status_confirmed === true
    && Number(state.confirmed_roster_revision) === Number(state.roster_revision);
}

async function requireAdStatusConfirmation({ state, scope, event, fields, store, client, now, log, logBase }) {
  if (isAdStatusConfirmationValid(state, scope)) return null;
  const result = await handleAdjustStatus({
    event,
    adjust: {
      dayKey: state?.day_key || shanghaiDay(now()),
      businessType: fields.businessType,
      targetCategory: fields.targetCategory,
      dispatchProfile: fields.dispatchProfile,
      dispatchScope: scope,
      dispatchDirection: fields.dispatchDirection,
      requestId: fields.requestId,
    },
    store, client, now, log, logBase,
  });
  return { ...result, errorCode: 'WAITING_STATUS_CONFIRMATION' };
}

async function p1Dispatch({ event, fields, store, client, now, log, logBase, config }) {
  const current = now();
  const dayKey = shanghaiDay(current);
  const expiresAt = nextShanghaiMidnight(current);
  const cleanupTask = store.cleanupExpired(current).catch((error) => {
    log('cleanup_failed', {
      ...logBase,
      error_code: error?.code || 'DISPATCH_CLEANUP_FAILED',
    });
  });

  let context = enforceAssigneeFieldContract(fields);
  let scope = profileScope(context);
  let roster = null;
  let state = null;
  let direction;
  let pending = null;
  if (event.formValue) {
    [, pending] = await Promise.all([cleanupTask, store.getPending(event.messageId, current)]);
    if (!pending) {
      const completed = await store.getPending(event.messageId, current, { includeCompleted: true });
      if (completed?.completed_at) {
        return {
          httpStatus: 200,
          body: toast('success', '该名单表单已处理，请勿重复提交'),
          errorCode: 'FORM_ALREADY_PROCESSED',
        };
      }
      return { httpStatus: 200, body: toast('error', '该名单表单已过期，请回到原卡片重新发起'), errorCode: 'PENDING_FORM_NOT_FOUND' };
    }
    if (pending.chat_id && pending.chat_id !== event.chatId) {
      throw new DispatchValidationError('PENDING_CHAT_MISMATCH', '名单表单与当前群聊不匹配，已拒绝处理');
    }
    context = enforceAssigneeFieldContract(normalizeRestoredContext(
      typeof pending.request_context === 'string' ? JSON.parse(pending.request_context) : pending.request_context,
      event.chatId,
    ));
    scope = profileScope(context);

    if (context.kind === 'adjust_status') {
      return handleAdjustStatusSubmit({
        event,
        adjustSubmit: {
          dayKey: context.dayKey,
          businessType: context.businessType,
          targetCategory: context.targetCategory,
          dispatchProfile: context.dispatchProfile,
          dispatchScope: context.dispatchScope,
          dispatchDirection: context.dispatchDirection,
          expectedVersion: context.expectedVersion,
          expectedRosterRevision: context.expectedRosterRevision,
          otherExpectedVersion: context.otherExpectedVersion,
          otherExpectedRosterRevision: context.otherExpectedRosterRevision,
          confirmationOperationId: context.confirmationOperationId,
        },
        store, client, now, log, logBase,
      });
    }

    const parsedRoster = parseRoster(event.formValue.roster_names);
    roster = resolveShuffleRoster(event.formValue) ? secureShuffle(parsedRoster) : parsedRoster;
    if (context.kind === 'specify_assignee_roster') {
      if (typeof store.initializeRoster !== 'function') {
        throw new DispatchValidationError('ROSTER_INITIALIZATION_UNAVAILABLE', '当日在班名单初始化能力尚未配置，已停止指定派单');
      }
      const initializedState = await store.initializeRoster({
        dayKey, scope, roster, expiresAt, current,
      });
      const result = await createSpecifyAssigneeForm({
        event: { ...event, messageId: pending.original_message_id },
        fields: context,
        roster: initializedState.roster,
        store, client, current, log, logBase,
      });
      await store.markPendingCompleted(event.messageId, current);
      return { ...result, updatedCard: buildRosterSavedCard(context) };
    }
    if (context.kind === 'batch') {
      return handleBatchDispatch({
        event: { ...event, messageId: pending.original_message_id },
        batch: context,
        store, client, now, log, logBase, config,
        roster,
        formMessageId: event.messageId,
      });
    }

    direction = profileDirection(context);
  } else {
    validateSheetTarget(fields);
    const [, fetchedState] = await Promise.all([cleanupTask, store.getDailyState(dayKey, scope, current)]);
    state = fetchedState;
    if (!state) {
      const pendingRequestId = fields.requestId;
      const existingPending = typeof store.getPendingByRequest === 'function'
        ? await store.getPendingByRequest(pendingRequestId, event.chatId, current)
        : null;
      if (existingPending) {
        log('roster_form_reused', { ...logBase, form_message_id: existingPending.form_message_id });
        return { httpStatus: 200, body: toast('info', '已存在待填写的名单表单，请在原话题中继续') };
      }
      const formCard = buildRosterFormCard(fields);
      const reply = await client.replyInteractiveCard({
        messageId: event.messageId, card: formCard,
        uuid: `bess-form-${fields.requestId}`.slice(0, 50), replyInThread: true,
      });
      const formMessageId = String(reply.message_id || '').trim();
      if (!formMessageId) throw new Error('Form message id missing');
      await store.savePending({
        form_message_id: formMessageId, request_id: fields.requestId,
        original_message_id: event.messageId, chat_id: event.chatId,
        request_context: fields, expires_at: expiresAt,
      });
      log('roster_form_created', { ...logBase, form_message_id: formMessageId });
      return { httpStatus: 200, body: toast('success', '已创建派单话题，请在话题表单中填写今日在班名单') };
    }
    const confirmationGate = await requireAdStatusConfirmation({
      state, scope, event, fields, store, client, now, log, logBase,
    });
    if (confirmationGate) return confirmationGate;
    direction = profileDirection(fields);
    if ((!fields.dateFieldId && !fields.dateFieldName) || !Array.isArray(state.roster)) {
      throw new DispatchValidationError('INVALID_DATE_FIELD', '按钮缺少日期字段配置，无法安全读取当天人工派单顺序');
    }
    if (fields.dateFieldId && !/^[A-Z]{1,3}$/.test(fields.dateFieldId)) {
      throw new DispatchValidationError('INVALID_DATE_FIELD', '日期列字母格式不正确');
    }
    if (fields.projectValue && !fields.projectFieldId && !fields.projectFieldName) {
      throw new DispatchValidationError('INVALID_PROJECT_FIELD', '按钮缺少项目字段配置，无法区分当前派单业态');
    }
    if (fields.projectFieldId && !/^[A-Z]{1,3}$/.test(fields.projectFieldId)) {
      throw new DispatchValidationError('INVALID_PROJECT_FIELD', '项目列字母格式不正确');
    }
    if (!pending && typeof store.getPending === 'function') {
      pending = await store.getPending(event.messageId, current, { includeCompleted: true }).catch(() => null);
    }
  }

  validateSheetTarget(context);
  if (!state && roster) {
    if (typeof store.initializeRoster !== 'function') {
      throw new DispatchValidationError('ROSTER_INITIALIZATION_UNAVAILABLE', '当日在班名单初始化能力尚未配置，已停止派单');
    }
    await store.initializeRoster({
      dayKey, scope, roster, expiresAt, current,
    });
    const rosterSavedCard = buildRosterSavedCard(context);
    return {
      httpStatus: 200,
      body: {
        ...toast('success', '今日名单已保存，请点击“开始派单”'),
        card: { type: 'raw', data: rosterSavedCard },
      },
      updatedCard: rosterSavedCard,
      afterResponse: async () => {
        if (!event.formValue) return;
        try {
          await client.updateMessageCard(event.messageId, rosterSavedCard);
        } catch (error) {
          log('roster_saved_card_update_failed', { ...logBase, error_code: error?.code || 'CARD_UPDATE_FAILED' });
        }
        await store.markPendingCompleted(event.messageId, now());
      },
    };
  }
  let effectiveRoster = state?.roster || roster;
  let read = await readTargetAndAnchor({
    client, fields: context, dayKey, roster: effectiveRoster, store,
  });
  let resolvedContext = { ...context, rowIndex: read.resolvedRowIndex ?? context.rowIndex };
  let assigned;
  let skipWrite = false;
  let previousAssignee;
  const currentDayKey = dayKey || shanghaiDay(now());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    effectiveRoster = read.state?.roster || effectiveRoster;
    resolvedContext = {
      ...context,
      rowIndex: read.resolvedRowIndex ?? context.rowIndex,
      valueAtTargetRow: read.valueAtTargetRow,
      existingAssignment: read.existingAssignment,
    };
    previousAssignee = read.previousAssignee;
    try {
      // A retry must not reinterpret a manual edit as the successful outcome
      // of an already committed, different assignment.
      assertTargetMatchesAssignment(read);
      let snapshot = read.state;
      let atomicallyAssigned = false;
      if (read.calibrationRequired && read.anchor && !read.existingAssignment
          && (!read.valueAtTargetRow || effectiveRoster.includes(read.valueAtTargetRow))) {
        if (!read.valueAtTargetRow) {
          assigned = await calibrateAndAssign({
            store, dayKey: currentDayKey, scope, requestId: context.requestId,
            direction, assignee: read.anchor, roster: effectiveRoster, expiresAt,
            expectedVersion: snapshot?.version,
            expectedCursorVersion: cursorVersion(snapshot, direction),
            context: { ...resolvedContext, originalMessageId: event.formValue ? undefined : event.messageId },
          });
          atomicallyAssigned = true;
        } else {
          snapshot = await calibrateFilledTarget({
            store, dayKey: currentDayKey, scope, direction, assignee: read.anchor,
            roster: effectiveRoster, expectedVersion: snapshot?.version,
            expectedCursorVersion: cursorVersion(snapshot, direction),
          });
          snapshot ||= await store.getDailyState(currentDayKey, scope, current);
        }
      }
      if (read.valueAtTargetRow) {
        skipWrite = true;
        assigned = {
          assignee: read.valueAtTargetRow, roster: effectiveRoster || [],
          original_message_id: read.existingAssignment?.original_message_id || event.messageId,
          replayed: true,
        };
      } else if (!atomicallyAssigned) {
        assigned = await store.assign({
          dayKey: currentDayKey,
          scope,
          requestId: context.requestId,
          direction,
          roster,
          expiresAt,
          expectedVersion: snapshot?.version,
          expectedCursorVersion: cursorVersion(snapshot, direction),
          context: { ...resolvedContext, originalMessageId: event.formValue ? undefined : event.messageId },
        });
      }
      break;
    } catch (error) {
      if (attempt === 1 || !['ASSIGNMENT_CONFLICT', 'CURSOR_CALIBRATION_CONFLICT'].includes(error?.code)) throw error;
      // Both calibration and assignment conflicts invalidate every observed
      // fact. In particular a newly filled target must never be overwritten.
      read = await readTargetAndAnchor({
        client, fields: context, dayKey, roster: effectiveRoster, store,
      });
    }
  }

  if (!assigned?.assignee || !Array.isArray(assigned.roster)) throw new Error('Invalid assignment response');
  if (!assigned.replayed && previousAssignee
      && String(assigned.assignee).trim() === String(previousAssignee).trim()) {
    throw new DispatchValidationError('DUPLICATE_CONSECUTIVE_ASSIGNEE', '派单结果与上一位负责人重复，已停止写表，请重试');
  }

  if (!skipWrite) {
    try {
      await client.writeSheetAssignee({
        sheetUrl: resolvedContext.sheetUrl, sheetId: resolvedContext.sheetId, rowIndex: resolvedContext.rowIndex,
        assigneeFieldId: resolvedContext.assigneeFieldId, assigneeFieldName: resolvedContext.assigneeFieldName,
        assignee: assigned.assignee,
        requireEmpty: true,
      });
    } catch (error) {
      // The RPC has committed; preserve its truthful ledger/cursor. No success
      // card or pending-completed marker may be emitted before sheet confirmation.
      error.assignmentCommitted = true;
      error.committedAssignee = assigned.assignee;
      throw error;
    }
  }

  const persistedState = await refreshDailyStateForCard({
    store, dayKey: currentDayKey, scope, current: now(),
    fallbackState: state, fallbackRoster: assigned.roster,
    fallbackAssignments: [{ direction, assignee: assigned.assignee }],
    log, logBase, flow: 'single',
  });

  const originalMessageId = pending?.original_message_id || assigned.original_message_id || event.messageId;
  const resultCard = buildDispatchResultCard(context, {
    assignee: assigned.assignee, direction, roster: persistedState.roster,
    offDuty: persistedState.off_duty || [],
    forwardCursor: persistedState.forward_cursor,
    reverseCursor: persistedState.reverse_cursor,
    emergencyForwardCursor: persistedState.emergency_forward_cursor,
    dispatchedAt: formatDispatchTime(current),
  });
  const logUiFailure = (operation, error) => {
    log('ui_update_failed', {
      ...logBase,
      operation,
      error_code: error instanceof LarkApiError ? error.code : 'UI_UPDATE_FAILED',
      ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
    });
  };
  const [original] = await Promise.all([
    client.getMessage(originalMessageId).catch((error) => {
      logUiFailure('get_original_message', error);
      return null;
    }),
    client.replyInteractiveCard({
      messageId: originalMessageId, card: resultCard,
      uuid: `bess-result-${context.requestId}`.slice(0, 50), replyInThread: true,
    }).catch((error) => {
      logUiFailure('reply_result_card', error);
      return null;
    }),
  ]);

  let updatedCard;
  if (original?.msg_type === 'interactive') {
    try {
      const patched = patchCardForDispatched(JSON.parse(original.body?.content || '{}'), {
        requestId: context.requestId, dispatchedAt: formatDispatchTime(current), assignee: assigned.assignee,
      });
      updatedCard = patched.patched ? patched.card : null;
    } catch { updatedCard = null; }
  }
  updatedCard ||= buildDispatchedCard(context, { dispatchedAt: formatDispatchTime(current), assignee: assigned.assignee });

  if (event.formValue || !event.cardUpdateToken) {
    const updateTasks = [
      client.updateMessageCard(originalMessageId, updatedCard).catch((error) => {
        logUiFailure('update_original_card', error);
      }),
    ];
    if ((event.formValue || pending) && event.messageId !== originalMessageId) {
      updateTasks.push(client.updateMessageCard(event.messageId, buildRosterCompletedCard(context, {
        assignee: assigned.assignee,
        direction,
        dispatchedAt: formatDispatchTime(current),
      })).catch((error) => {
        logUiFailure('update_roster_form_card', error);
      }));
    }
    await Promise.all(updateTasks);
    if (pending) await store.markPendingCompleted(event.messageId, current);
  }
  const afterResponse = !event.formValue && event.cardUpdateToken
    ? async () => {
      try {
        await client.delayUpdateMessageCard(event.cardUpdateToken, updatedCard);
      } catch (error) {
        log('card_update_failed', {
          ...logBase,
          error_code: error instanceof LarkApiError ? error.code : 'CARD_UPDATE_FAILED',
        });
      }
    }
    : (event.formValue ? async () => {} : undefined);
  log('assigned', { ...logBase, assignee: assigned.assignee, direction, replayed: Boolean(assigned.replayed) });
  return {
    httpStatus: 200,
    body: toast('success', assigned.replayed ? `该需求已派给 ${assigned.assignee}` : `派单成功：${assigned.assignee}`),
    updatedCard, afterResponse,
  };
}

async function dispatchBatchItem({
  fields, store, client, current, roster, batchRead, expectedVersion, expectedCursorVersion,
  previousAssignee, previousDirection,
}) {
  const dayKey = shanghaiDay(current);
  const scope = profileScope(fields);
  const state = await store.getDailyState(dayKey, scope, current);
  let effectiveRoster = state?.roster || roster;
  if (!Array.isArray(effectiveRoster) || effectiveRoster.length === 0) {
    throw new DispatchValidationError('ROSTER_NOT_INITIALIZED', '今日派单名单尚未初始化');
  }
  const direction = profileDirection(fields);
  if ((!fields.dateFieldId && !fields.dateFieldName)) {
    throw new DispatchValidationError('INVALID_DATE_FIELD', '按钮缺少日期字段配置');
  }
  if (fields.dateFieldId && !/^[A-Z]{1,3}$/.test(fields.dateFieldId)) {
    throw new DispatchValidationError('INVALID_DATE_FIELD', '日期列字母格式不正确');
  }
  if (fields.projectValue && !fields.projectFieldId && !fields.projectFieldName) {
    throw new DispatchValidationError('INVALID_PROJECT_FIELD', '按钮缺少项目字段配置');
  }

  let read = batchRead || await readTargetAndAnchor({
    client, fields, dayKey, roster: effectiveRoster, store,
  });
  let resolvedFields = { ...fields, rowIndex: read.resolvedRowIndex ?? fields.rowIndex };
  validateSheetTarget(resolvedFields);
  // Batch-wide pre-reads are only anchor planning, never proof that a cell is
  // still empty. Read this target at execution time even without a CAS conflict.
  if (typeof client.readSheetAssignee !== 'function') {
    throw new DispatchValidationError('SHEET_TARGET_REVALIDATION_UNAVAILABLE', '目标负责人实时核验尚未配置，已停止写表');
  }
  const liveTarget = await client.readSheetAssignee(resolvedFields);
  let decisionRefreshed = false;
  if (liveTarget !== String(read.valueAtTargetRow || '').trim()) {
    read = await readTargetAndAnchor({ client, fields, dayKey, roster: effectiveRoster, store });
    resolvedFields = { ...fields, rowIndex: read.resolvedRowIndex ?? fields.rowIndex };
    validateSheetTarget(resolvedFields);
    const checkedTarget = await client.readSheetAssignee(resolvedFields);
    if (checkedTarget !== String(read.valueAtTargetRow || '').trim()) {
      throw new DispatchValidationError('SHEET_TARGET_CHANGED', '目标负责人读取期间发生变化，已停止派单，请重试');
    }
    expectedVersion = read.state?.version;
    expectedCursorVersion = cursorVersion(read.state, direction);
    decisionRefreshed = true;
  }
  if (decisionRefreshed || !batchRead) effectiveRoster = read.state?.roster || effectiveRoster;
  let {
    valueAtTargetRow, existingAssignment, anchor, previousAssignee: sheetPrevious, calibrationRequired, state: latestState,
  } = read;
  const effectivePrevious = previousAssignee || sheetPrevious;
  assertTargetMatchesAssignment(read);

  let assigned;
  let skipWrite = false;
  // Sheet/durable anchors are observations. When an empty target needs
  // calibration, the calibration and allocation must commit in one RPC.
  if (!valueAtTargetRow && calibrationRequired && anchor && !existingAssignment) {
    assigned = await calibrateAndAssign({
      store, dayKey, scope, requestId: fields.requestId, direction,
      assignee: anchor, roster: effectiveRoster,
      expiresAt: nextShanghaiMidnight(current), context: { ...resolvedFields },
      expectedVersion: latestState?.version,
      expectedCursorVersion: cursorVersion(latestState, direction),
    });
  }

  if (valueAtTargetRow) {
    const isActuallyInRoster = effectiveRoster.includes(valueAtTargetRow);
    if (!existingAssignment && !isActuallyInRoster) {
      throw new DispatchValidationError('ASSIGNEE_NOT_IN_ROSTER', `目标行负责人 “${valueAtTargetRow}” 不在今日名单中，请人工核对`);
    }

    if (calibrationRequired && anchor && !existingAssignment && isActuallyInRoster) {
      const updatedState = await calibrateFilledTarget({
        store,
        dayKey,
        scope,
        direction,
        assignee: anchor,
        roster: effectiveRoster,
        expectedVersion: latestState?.version,
        expectedCursorVersion: cursorVersion(latestState, direction),
      });
      if (updatedState) latestState = updatedState;
    }
    skipWrite = true;
    assigned = {
      assignee: valueAtTargetRow,
      replayed: true,
      version: latestState?.version,
      forward_version: latestState?.forward_version,
      reverse_version: latestState?.reverse_version,
      assignment_seq: latestState?.assignment_seq,
    };
  }

  if (!assigned) {
    assigned = await store.assign({
      dayKey,
      scope,
      requestId: fields.requestId,
      direction,
      roster: roster || null,
      expiresAt: nextShanghaiMidnight(current),
      expectedVersion: expectedVersion ?? latestState?.version,
      expectedCursorVersion: expectedCursorVersion ?? cursorVersion(latestState, direction),
      context: { ...resolvedFields },
    });
  }

  if (!assigned?.assignee) throw new Error('Invalid assignment response');
  try {
    if (!assigned.replayed && effectivePrevious && (!previousDirection || direction === previousDirection)
        && String(assigned.assignee).trim() === String(effectivePrevious).trim()) {
      throw new DispatchValidationError('DUPLICATE_CONSECUTIVE_ASSIGNEE', '派单结果与上一位负责人重复，已停止写表，请重试');
    }
    if (!skipWrite) {
      await client.writeSheetAssignee({
        sheetUrl: resolvedFields.sheetUrl, sheetId: resolvedFields.sheetId, rowIndex: resolvedFields.rowIndex,
        assigneeFieldId: resolvedFields.assigneeFieldId, assigneeFieldName: resolvedFields.assigneeFieldName,
        assignee: assigned.assignee,
        requireEmpty: true,
      });
    }
  } catch (error) {
    // The durable assignment already advanced its directional cursor. Let the
    // batch coordinator continue from the committed assignee even if the sheet
    // write or post-assignment validation failed.
    error.assignmentCommitted = true;
    error.committedAssignee = assigned.assignee;
    error.resolvedRowIndex = resolvedFields.rowIndex;
    throw error;
  }
  return {
    assignee: assigned.assignee, replayed: Boolean(assigned.replayed),
    version: assigned.version, forward_version: assigned.forward_version,
    reverse_version: assigned.reverse_version,
    emergency_forward_version: assigned.emergency_forward_version, assignment_seq: assigned.assignment_seq,
    decisionRefreshed,
  };
}

export function redactLarkApiMessage(value) {
  return String(value || '')
    .slice(0, 500)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|app_secret|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/g, '[REDACTED_PHONE]');
}

function safeBatchFailure(error) {
  if (error?.code === 'SHEET_TARGET_CHANGED' && error.assignmentCommitted) {
    return '目标负责人已变化，未自动覆盖。派单记录已落库，请人工核对表格与账本';
  }
  if (error instanceof DispatchValidationError || error instanceof RosterValidationError) {
    return error.userMessage || error.message;
  }
  if (error?.message === 'ALL_OFF_DUTY' || error?.dbMessage === 'ALL_OFF_DUTY') {
    return '所有人员均已离岗，请手动处理';
  }
  if (error instanceof LarkApiError) return `飞书接口失败（${error.code}）`;
  return '派单失败，请联系值班同学';
}

function batchLease(current, leaseMs) {
  return new Date(current.getTime() + leaseMs).toISOString();
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function upsertBatchResult(results, result) {
  const index = results.findIndex((item) => item.requestId === result.requestId);
  if (index < 0) return [...results, result];
  const next = [...results];
  next[index] = result;
  return next;
}

function batchRetention(current) {
  return new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function batchRowStatus(row) {
  return row?.batch_status || row?.status || BATCH_STATUS.PROCESSING;
}

function batchRowResults(row) {
  return Array.isArray(row?.results) ? row.results : [];
}

async function recordFinalization({ store, event, batch, claimToken, effect, operation, log, logBase }) {
  try {
    await operation();
    await store.markBatchFinalization({
      chatId: event.chatId, batchId: batch.batchId, claimToken, effect, succeeded: true,
    });
    log('batch_finalization_succeeded', { ...logBase, effect });
    return true;
  } catch (error) {
    const errorCode = error?.code || `BATCH_${effect.toUpperCase()}_FAILED`;
    try {
      await store.markBatchFinalization({
        chatId: event.chatId, batchId: batch.batchId, claimToken, effect,
        succeeded: false, errorCode,
      });
    } catch (recordError) {
      log('batch_finalization_record_failed', {
        ...logBase, effect, error_code: recordError?.code || 'BATCH_FINALIZATION_RECORD_FAILED',
      });
    }
    log('batch_finalization_failed', { ...logBase, effect, error_code: errorCode });
    return false;
  }
}

async function handleAdjustStatus({ event, adjust, store, client, now, log, logBase }) {
  const current = now();
  const dayKey = adjust.dayKey || shanghaiDay(current);
  const scope = profileScope(adjust);
  const state = await store.getDailyState(dayKey, scope, current);
  if (!state) {
    return { httpStatus: 200, body: toast('error', '今日派单尚未初始化，无法调整状态') };
  }
  const isAd = ['ad_review', 'ad_game'].includes(scope);
  const otherScope = scope === 'ad_review' ? 'ad_game' : 'ad_review';
  const otherState = isAd ? await store.getDailyState(dayKey, otherScope, current) : null;
  const confirmationOperationId = randomUUID();
  const formCard = buildAdjustStatusFormCard({
    dayKey,
    businessType: adjust.businessType,
    targetCategory: adjust.targetCategory,
    dispatchProfile: adjust.dispatchProfile,
    roster: state.roster,
    offDuty: state.off_duty || [],
    version: state.version,
    isAd,
  });
  const reply = await client.replyInteractiveCard({
    messageId: event.messageId,
    card: formCard,
    // Scope idempotency to one callback event: webhook retries are deduped,
    // while a later user click intentionally creates a fresh form.
    uuid: `bess-status-${event.eventId.slice(-20)}-${state.version}`.slice(0, 50),
    replyInThread: true,
  });
  const formMessageId = String(reply?.message_id || '').trim();
  if (!formMessageId) throw new Error('Status form message id missing');
  await store.savePending({
    form_message_id: formMessageId,
    request_id: `status-${event.eventId}`,
    original_message_id: event.messageId,
    chat_id: event.chatId,
    request_context: {
      kind: 'adjust_status',
      dayKey,
      businessType: adjust.businessType,
      targetCategory: adjust.targetCategory,
      dispatchProfile: adjust.dispatchProfile,
      dispatchScope: adjust.dispatchScope,
      dispatchDirection: adjust.dispatchDirection,
      expectedVersion: state.version,
      expectedRosterRevision: state.roster_revision,
      otherExpectedVersion: otherState?.version,
      otherExpectedRosterRevision: otherState?.roster_revision,
      confirmationOperationId,
    },
    expires_at: nextShanghaiMidnight(current),
  });
  log('status_form_sent', {
    ...logBase,
    message_id: event.messageId,
    form_message_id: formMessageId,
    roster_version: state.version,
  });
  return {
    httpStatus: 200,
    body: toast('success', '人员状态调整表单已发送到当前话题'),
  };
}

async function handleAdjustStatusSubmit({ event, adjustSubmit, store, client, now, log, logBase }) {
  const current = now();
  const formValue = event.formValue;
  const targetName = formValue?.target_name;
  const opType = formValue?.op_type;
  const range = formValue?.range || 'current';
  const reason = formValue?.reason || '未填写原因';

  if (!opType || (!targetName && opType !== 'confirm')) {
    return { httpStatus: 200, body: toast('error', '请选择操作类型；调整离岗状态时还需选择人员') };
  }
  if (!['current', 'other', 'both'].includes(range)) {
    throw new DispatchValidationError('INVALID_STATUS_RANGE', '人员状态调整范围无效');
  }

  const scope = profileScope(adjustSubmit);
  const isAd = ['ad_review', 'ad_game'].includes(scope);
  const otherScope = scope === 'ad_review' ? 'ad_game' : 'ad_review';
  const [state, otherState] = await Promise.all([
    store.getDailyState(adjustSubmit.dayKey, scope, current),
    isAd ? store.getDailyState(adjustSubmit.dayKey, otherScope, current) : null,
  ]);
  if (!state || (isAd && !otherState)) {
    return { httpStatus: 200, body: toast('error', '今日派单状态已过期') };
  }

  const applyOperation = (source) => {
    let offDuty = [...(source.off_duty || [])];
    if (opType === 'leave' && !offDuty.includes(targetName)) offDuty.push(targetName);
    if (opType === 'resume') offDuty = offDuty.filter((name) => name !== targetName);
    return offDuty;
  };
  let replayed = false;
  if (isAd) {
    const selected = range === 'both'
      ? [{ scope, state, expectedVersion: adjustSubmit.expectedVersion, expectedRosterRevision: adjustSubmit.expectedRosterRevision },
        { scope: otherScope, state: otherState, expectedVersion: adjustSubmit.otherExpectedVersion, expectedRosterRevision: adjustSubmit.otherExpectedRosterRevision }]
      : range === 'other'
        ? [{ scope: otherScope, state: otherState, expectedVersion: adjustSubmit.otherExpectedVersion, expectedRosterRevision: adjustSubmit.otherExpectedRosterRevision }]
        : [{ scope, state, expectedVersion: adjustSubmit.expectedVersion, expectedRosterRevision: adjustSubmit.expectedRosterRevision }];
    const updates = selected.map((item) => ({
      scope: item.scope,
      offDuty: applyOperation(item.state),
      expectedVersion: item.expectedVersion,
      expectedRosterRevision: item.expectedRosterRevision,
    }));
    const confirmationOperationId = adjustSubmit.confirmationOperationId || `legacy-${event.messageId}`;
    const submissionHash = createHash('sha256').update(JSON.stringify({
      dayKey: adjustSubmit.dayKey, range, targetName: targetName || '', opType,
      updates: updates.map(({ scope: selectedScope, offDuty }) => ({ scope: selectedScope, offDuty })),
    })).digest('hex');
    const result = await store.updateAdRosterStatuses({
      dayKey: adjustSubmit.dayKey, updates, confirmationOperationId, submissionHash,
      confirmedBy: event.operatorOpenId,
    });
    replayed = result?.replayed === true;
  } else {
    const nextOffDuty = applyOperation(state);
    const desiredAlreadyApplied = JSON.stringify(nextOffDuty) === JSON.stringify(state.off_duty || []);
    if (!desiredAlreadyApplied) {
      await store.updateRosterStatus({
        dayKey: adjustSubmit.dayKey, scope, offDuty: nextOffDuty,
        expectedVersion: adjustSubmit.expectedVersion,
      });
    }
    replayed = desiredAlreadyApplied;
  }

  const displayTarget = targetName || '当前范围全员状态';
  log('status_adjusted', {
    ...logBase, target: targetName || '全员状态', op: opType, replayed, range,
  });
  if (typeof store.markPendingCompleted === 'function') {
    await store.markPendingCompleted(event.messageId, current).catch((error) => log('status_pending_complete_failed', {
      ...logBase,
      target: targetName,
      op: opType,
      error_code: error?.code || 'STATUS_PENDING_COMPLETE_FAILED',
    }));
  }

  const auditMessage = `📌 **人员状态调整**\n操作人：<at user_id="${event.operatorOpenId}"></at>\n人员：${displayTarget}\n操作：${opType === 'leave' ? '临时离岗' : opType === 'resume' ? '恢复接单' : '确认当前状态'}\n原因：${reason}\n时间：${formatDispatchTime(current)}`;

  try {
    await client.replyMessage({
      messageId: event.messageId,
      msgType: 'text',
      content: { text: auditMessage },
      // The form card is already inside the dispatch topic. Starting another
      // thread from a thread reply is rejected by Feishu (LARK_API_230099).
      replyInThread: false,
    });
  } catch (error) {
    // The roster update is already committed. An audit-message failure must
    // not turn a successful business write into a misleading retryable error.
    log('status_audit_reply_failed', {
      ...logBase,
      target: targetName,
      op: opType,
      error_code: error?.code || 'AUDIT_REPLY_FAILED',
      http_status: error?.httpStatus || null,
      endpoint: error?.endpoint || '',
    });
  }

  const successCard = buildAdjustStatusSuccessCard({ targetName: displayTarget, opType, reason });
  const afterResponse = async () => {
    await client.updateMessageCard(event.messageId, successCard).catch((error) => log('status_card_update_failed', {
      ...logBase,
      target: targetName,
      op: opType,
      error_code: error?.code || 'STATUS_CARD_UPDATE_FAILED',
      http_status: error?.httpStatus || null,
      endpoint: error?.endpoint || '',
    }));
  };

  return {
    httpStatus: 200,
    body: {
      ...toast('success', opType === 'confirm'
        ? `${displayTarget}已确认`
        : `人员 ${displayTarget} 状态已更新为 ${opType === 'leave' ? '离岗' : '在岗'}`),
      card: { type: 'raw', data: successCard },
    },
    afterResponse,
  };
}

async function handleBatchDispatch({ event, batch, store, client, now, log, logBase, config, roster, formMessageId }) {
  const requiredMethods = ['claimBatch', 'saveBatchProgress', 'markBatchFinalization', 'saveBatchResultMessage', 'releaseBatchClaim'];
  if (requiredMethods.some((method) => typeof store?.[method] !== 'function')) {
    return {
      httpStatus: 200,
      body: toast('error', '批量派单持久化锁尚未配置，已拒绝执行'),
      errorCode: 'PERSISTENT_BATCH_STORE_REQUIRED',
    };
  }

  const fingerprint = batchDispatchFingerprint(batch.items);
  const current = now();
  const dayKey = shanghaiDay(current);
  const scope = enforceSingleBatchScope(batch.items);
  let state = await store.getDailyState(dayKey, scope, current);
  if (state) {
    const confirmationGate = await requireAdStatusConfirmation({
      state, scope, event, fields: batch.items[0], store, client, now, log, logBase,
    });
    if (confirmationGate) return confirmationGate;
  }
  if (!state && !roster) {
    const pendingRequestId = `batch_${batch.batchId}`;
    const existingPending = typeof store.getPendingByRequest === 'function'
      ? await store.getPendingByRequest(pendingRequestId, event.chatId, current)
      : null;
    if (existingPending) {
      log('roster_form_reused', { ...logBase, batch_id: batch.batchId, form_message_id: existingPending.form_message_id });
      return { httpStatus: 200, body: toast('info', '该批次已有待填写的名单表单，请在原话题中继续') };
    }
    const formCard = buildRosterFormCard(batch.items[0]);
    const reply = await client.replyInteractiveCard({
      messageId: event.messageId, card: formCard,
      uuid: `bess-form-batch-${batch.batchId}`.slice(0, 50), replyInThread: true,
    });
    const formId = String(reply.message_id || '').trim();
    if (!formId) throw new Error('Form message id missing');
    await store.savePending({
      form_message_id: formId, request_id: `batch_${batch.batchId}`,
      original_message_id: event.messageId, chat_id: event.chatId,
      request_context: { ...batch, kind: 'batch' }, expires_at: nextShanghaiMidnight(current),
    });
    log('roster_form_created', { ...logBase, batch_id: batch.batchId, form_message_id: formId });
    return { httpStatus: 200, body: toast('success', '已创建批量派单话题，请在话题表单中填写今日名单') };
  }

    if (!state && roster) {
      if (typeof store.initializeRoster !== 'function') {
        throw new DispatchValidationError('PERSISTENT_ROSTER_STORE_REQUIRED', '今日派单名单持久化尚未配置，已拒绝执行');
      }
      await store.initializeRoster({
        dayKey, scope, roster, expiresAt: nextShanghaiMidnight(current), current,
      });
      const rosterSavedCard = buildRosterSavedCard({ ...batch.items[0], batchId: batch.batchId, items: batch.items, kind: 'batch' });
      return {
        httpStatus: 200,
        body: {
          ...toast('success', '今日名单已保存，请点击“开始派单”'),
          card: { type: 'raw', data: rosterSavedCard },
        },
        updatedCard: rosterSavedCard,
        afterResponse: async () => {
          if (!formMessageId) return;
          try {
            await client.updateMessageCard(formMessageId, rosterSavedCard);
          } catch (error) {
            log('roster_saved_card_update_failed', { ...logBase, error_code: error?.code || 'CARD_UPDATE_FAILED' });
          }
          await store.markPendingCompleted(formMessageId, now());
        },
      };
    }

  // Vercel allows 300s for this function. Stop starting new items before that
  // hard limit and keep the durable lease slightly longer than our own budget.
  const executionMs = positiveDuration(config.batchExecutionDeadlineMs, 240_000);
  const itemStartReserveMs = positiveDuration(config.batchItemStartReserveMs, 30_000);
  const leaseMs = Math.max(300_000, executionMs + 30_000);
  const claimToken = randomUUID();
  const leaseExpiresAt = batchLease(current, leaseMs);
  const claim = await store.claimBatch({
    chatId: event.chatId,
    batchId: batch.batchId,
    fingerprint,
    items: batch.items,
    originalMessageId: event.messageId,
    claimToken,
    now: current,
    leaseExpiresAt,
    expiresAt: batchRetention(current),
  });
  const targetMessageId = String(claim.original_message_id || event.messageId);
  const status = batchRowStatus(claim);
  const results = batchRowResults(claim);

  if (claim.outcome === 'CONFLICT') {
    return {
      httpStatus: 200,
      body: toast('error', '批次 ID 已被其他内容使用，请重新生成批次'),
      errorCode: 'BATCH_ID_CONFLICT',
    };
  }

  const existingCard = buildBatchStatusCard(batch.items, {
    batchId: batch.batchId, status, results, cardTitle: batch.items[0]?.cardTitle,
  });
  if (claim.outcome === 'IN_FLIGHT') {
    return {
      httpStatus: 200,
      body: { ...toast('info', '批量派单处理中，请勿重复点击'), card: { type: 'raw', data: existingCard } },
      updatedCard: existingCard,
      errorCode: 'BATCH_IN_FLIGHT',
    };
  }
  if (claim.outcome === 'COMPLETE') {
    return {
      httpStatus: 200,
      body: { ...toast('success', '该批次已处理'), card: { type: 'raw', data: existingCard } },
      updatedCard: existingCard,
      errorCode: 'BATCH_ALREADY_PROCESSED',
    };
  }
  if (!['CLAIMED', 'RESUMED'].includes(claim.outcome)) {
    throw new Error('Unknown batch claim outcome');
  }

  const processingCard = buildBatchStatusCard(batch.items, {
    batchId: batch.batchId,
    status: status === BATCH_STATUS.PROCESSING ? status : BATCH_STATUS.PROCESSING,
    results,
    cardTitle: batch.items[0]?.cardTitle,
  });

  let started = false;
  const afterResponse = async () => {
    if (started) return;
    started = true;
    let latestResults = [...results];
    let finalStatus = status;
    const deadlineAt = current.getTime() + executionMs;
    const hasRetryableItems = batch.items.some((fields) => (
      latestResults.find((item) => item.requestId === fields.requestId)?.status !== 'SUCCESS'
    ));

    // A previous PARTIAL/FAILED finalization describes stale results once retry
    // starts. Clear those markers so the refreshed card/thread are compensated.
    if (hasRetryableItems) {
      if (claim.card_update_done === true) {
        await store.markBatchFinalization({
          chatId: event.chatId, batchId: batch.batchId, claimToken,
          effect: 'card', succeeded: false, errorCode: 'RETRY_PENDING',
        });
        claim.card_update_done = false;
      }
      if (claim.thread_reply_done === true) {
        await store.markBatchFinalization({
          chatId: event.chatId, batchId: batch.batchId, claimToken,
          effect: 'thread', succeeded: false, errorCode: 'RETRY_PENDING',
        });
        claim.thread_reply_done = false;
      }
    }

    await store.cleanupExpired(current).catch(() => {});

    // Persist the submitted roster before reading/calibrating any pre-filled
    // sheet anchors. Otherwise an all-manual first batch tries to calibrate a
    // daily state that does not exist yet and the roster is never initialized.
    if (!state && roster) {
      if (typeof store.initializeRoster !== 'function') {
        throw new DispatchValidationError('PERSISTENT_ROSTER_STORE_REQUIRED', '今日派单名单持久化尚未配置，已拒绝执行');
      }
      state = await store.initializeRoster({
        dayKey,
        scope,
        roster,
        expiresAt: nextShanghaiMidnight(current),
        current,
      });
    }

    // Snapshot every still-pending target before assigning anything. Mixed
    // qianchuan/local-promo batches use independent directional anchors: the
    // latest forward row anchors qianchuan, while the latest reverse row anchors
    // local promo. The first automatic item in each direction receives that
    // anchor; subsequent items advance the store cursor normally.
    let effectiveRoster = state?.roster || roster;
    const batchDirections = new Set(batch.items.map((fields) => profileDirection(fields)));
    const batchReads = new Map();
    const batchReadErrors = new Map();
    const anchorsByDirection = new Map();
    let anyCalibrationRequired = false;
    const readPendingTargets = async () => {
      anchorsByDirection.clear();
      batchReads.clear();
      batchReadErrors.clear();
      anyCalibrationRequired = false;
      for (const fields of batch.items) {
        const previous = latestResults.find((item) => item.requestId === fields.requestId);
        if (previous?.status === 'SUCCESS') continue;
        try {
          const read = await readTargetAndAnchor({
            client, fields, dayKey, roster: effectiveRoster, store,
          });
          if (read.calibrationRequired) anyCalibrationRequired = true;
          batchReads.set(fields.requestId, read);
          const direction = profileDirection(fields);
          const currentAnchor = anchorsByDirection.get(direction);
          if (read.calibrationRequired && read.anchor
              && (!currentAnchor || read.anchorRow >= currentAnchor.rowIndex)) {
            anchorsByDirection.set(direction, {
              assignee: read.anchor,
              requestId: fields.requestId,
              rowIndex: read.anchorRow,
              state: read.state,
              isInternal: typeof batch.items[0]?.rowIndex === 'number' && read.anchorRow >= batch.items[0].rowIndex,
              hasInternalManual: (currentAnchor?.hasInternalManual) || (read.valueAtTargetRow && read.anchorRow === fields.rowIndex),
            });
          }
        } catch (error) {
          batchReadErrors.set(fields.requestId, error);
        }
      }
      // An unknown manual assignee makes the directional cursor ambiguous. Block
      // every item in that direction before any assignment can advance it.
      const blockedDirections = new Map();
      for (const fields of batch.items) {
        const read = batchReads.get(fields.requestId);
        const manualAssignee = String(read?.valueAtTargetRow || '').trim();
        if (manualAssignee && !read?.existingAssignment && !effectiveRoster.includes(manualAssignee)) {
          blockedDirections.set(profileDirection(fields), new DispatchValidationError(
            'ASSIGNEE_NOT_IN_ROSTER', `目标行负责人 “${manualAssignee}” 不在今日名单中，请人工核对`,
          ));
        }
      }
      for (const fields of batch.items) {
        const directionError = blockedDirections.get(profileDirection(fields));
        if (directionError) batchReadErrors.set(fields.requestId, directionError);
      }
    };
    await readPendingTargets();
    const isMixedDirectionBatch = batchDirections.size > 1;
    const allSameSheet = batch.items.every((item) => item.sheetUrl === batch.items[0]?.sheetUrl);

    // [P2 Optimization: Fast-Path Batch Dispatch]
    // Only attempt fast path for fresh batches with a single direction, same spreadsheet,
    // no snapshot validation errors, and supported methods. A valid manual anchor before
    // the all-empty target range is calibrated once before the atomic batch assignment.
    let skipIndividualLoop = false;
    if (latestResults.length === 0 && !isMixedDirectionBatch && allSameSheet
        && batchReadErrors.size === 0
        && typeof store.assignBatch === 'function'
        && typeof client.getSheetValuesBatch === 'function'
        && typeof client.writeSheetValuesBatch === 'function') {
      try {
        // Keep the claimed action immutable for a stable batch fingerprint. The
        // physical sheet row is runtime evidence resolved from request_id.
        const resolvedItems = batch.items.map((item) => {
          const read = batchReads.get(item.requestId);
          const resolved = { ...item, rowIndex: read?.resolvedRowIndex ?? item.rowIndex };
          validateSheetTarget(resolved);
          return resolved;
        });
        const columns = await Promise.all(resolvedItems.map((item) => client.resolveSheetColumn({
          sheetUrl: item.sheetUrl, sheetId: item.sheetId, fieldId: item.assigneeFieldId, fieldName: item.assigneeFieldName,
        })));
        const ranges = resolvedItems.map((item, i) => `${item.sheetId}!${columns[i]}${item.rowIndex}:${columns[i]}${item.rowIndex}`);
        const batchValues = await client.getSheetValuesBatch({ sheetUrl: resolvedItems[0].sheetUrl, ranges });
        const conflicts = [];
        for (let i = 0; i < batch.items.length; i += 1) {
          const val = String(batchValues[i]?.[0]?.[0] || '').trim();
          if (val) conflicts.push({
            requestId: batch.items[i].requestId, requestName: batch.items[i].requestName,
            status: 'FAILED', message: `表格行已存在负责人：${val}`, errorCode: 'SHEET_TARGET_NOT_EMPTY',
          });
        }
        if (conflicts.length > 0) {
          log('batch_fast_path_fallback', { ...logBase, reason: 'precheck_conflict', conflict_count: conflicts.length });
        } else {
          const direction = profileDirection(batch.items[0]);
          if (anyCalibrationRequired) {
            const calibration = anchorsByDirection.get(direction);
            if (!calibration?.assignee) {
              throw new DispatchValidationError(
                'BATCH_CALIBRATION_ANCHOR_MISSING', '批量派单需要校准游标，但未找到有效负责人锚点',
              );
            }
            const calibratedState = await calibrateFilledTarget({
              store,
              dayKey,
              scope,
              direction,
              assignee: calibration.assignee,
              roster: effectiveRoster,
              expectedVersion: state?.version,
              expectedCursorVersion: cursorVersion(state, direction),
            });
            state = calibratedState || await store.getDailyState(dayKey, scope, now()) || state;
            for (const read of batchReads.values()) {
              if (read.anchor === calibration.assignee) read.calibrationRequired = false;
            }
            log('batch_fast_path_calibrated', {
              ...logBase, direction, anchor_row: calibration.rowIndex,
            });
          }
          const batchAssignments = await store.assignBatch({
            dayKey,
            scope,
            requestIds: batch.items.map((i) => i.requestId),
            direction,
            roster: (latestResults.length === 0 && roster) ? roster : null,
            expiresAt: nextShanghaiMidnight(current),
            contexts: resolvedItems, expectedVersion: state?.version,
            expectedCursorVersion: cursorVersion(state, direction),
          });
          const valueRanges = batchAssignments.map((assigned, i) => ({ range: ranges[i], values: [[assigned.assignee]] }));
          try {
            await client.writeSheetValuesBatch({ sheetUrl: resolvedItems[0].sheetUrl, valueRanges });
            latestResults = batchAssignments.map((assigned, i) => ({
              requestId: assigned.request_id, requestName: batch.items[i].requestName, businessType: batch.items[i].businessType,
              status: 'SUCCESS', assignee: assigned.assignee, replayed: assigned.replayed,
              assignmentSeq: assigned.assignment_seq,
              cursorVersion: cursorVersion(assigned, direction),
              source: assigned.replayed ? 'replay' : 'auto',
            }));
            const last = batchAssignments[batchAssignments.length - 1];
            state = {
              ...state, version: last.version, forward_version: last.forward_version, reverse_version: last.reverse_version,
              emergency_forward_version: last.emergency_forward_version,
              roster: last.roster || state?.roster,
            };
            skipIndividualLoop = true;
            log('batch_fast_path_success', { ...logBase, count: latestResults.length });
          } catch (writeErr) {
            log('batch_fast_path_write_failed', { ...logBase, error: writeErr.message });
            // DB already committed assignments; individual loop will replay them and retry sheet writes.
          }
        }
      } catch (fastPathErr) {
        log('batch_fast_path_aborted', { ...logBase, error: fastPathErr.message, code: fastPathErr.code });
        // Fallback to individual loop for safety.
      }
    }

      for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!skipIndividualLoop) {
        const lastCalibratedAnchor = new Map();
        let conflictOccurred = false;
        for (const fields of batch.items) {
          const previous = latestResults.find((item) => item.requestId === fields.requestId);
          if (previous?.status === 'SUCCESS') continue;

          if (now().getTime() + itemStartReserveMs >= deadlineAt) {
            await store.saveBatchProgress({
              chatId: event.chatId, batchId: batch.batchId, claimToken,
              status: BATCH_STATUS.PROCESSING, results: latestResults,
              leaseExpiresAt: batchLease(now(), leaseMs),
            });
            const retryCard = buildBatchStatusCard(batch.items, {
              batchId: batch.batchId,
              status: BATCH_STATUS.PROCESSING,
              results: latestResults,
              cardTitle: batch.items[0]?.cardTitle,
              resumable: true,
              retryAction: batchDispatchActionValue(batch.batchId, batch.items),
            });
            await client.updateMessageCard(targetMessageId, retryCard).catch((error) => log('batch_pause_card_failed', {
              ...logBase, error_code: error?.code || 'BATCH_PAUSE_CARD_FAILED',
            }));
            await store.releaseBatchClaim({
              chatId: event.chatId, batchId: batch.batchId, claimToken, releasedAt: now(),
            }).catch((error) => log('batch_claim_release_failed', {
              ...logBase, error_code: error?.code || 'BATCH_CLAIM_RELEASE_FAILED',
            }));
            log('batch_paused', {
              ...logBase,
              success_count: latestResults.filter((item) => item.status === 'SUCCESS').length,
              remaining_count: batch.items.length - latestResults.filter((item) => item.status === 'SUCCESS').length,
            });
            return;
          }

          let result;
          let direction = '';
          try {
            const batchReadError = batchReadErrors.get(fields.requestId);
            if (batchReadError) throw batchReadError;
            const itemRoster = (latestResults.length === 0 && roster) ? roster : null;
            direction = profileDirection(fields);
            const br = batchReads.get(fields.requestId);
            let itemRead = br ? { ...br } : null;
            if (itemRead && itemRead.anchor && itemRead.anchor === lastCalibratedAnchor.get(direction)) {
              itemRead.calibrationRequired = false;
            }

            const assigned = await dispatchBatchItem({
              fields, store, client, current: now(), roster: itemRoster,
              batchRead: itemRead,
              expectedVersion: state?.version,
              expectedCursorVersion: cursorVersion(state, direction),
              previousAssignee: latestResults.length > 0 ? latestResults[latestResults.length - 1].assignee : null,
              previousDirection: latestResults.length > 0 ? profileDirection(batch.items[batch.items.findIndex(i => i.requestId === latestResults[latestResults.length - 1].requestId)]) : null,
            });

            if (assigned.decisionRefreshed) {
              batchReads.clear();
              state = await store.getDailyState(dayKey, scope, now());
            }
            if (assigned.version !== undefined) state = {
              ...(state || {}),
              version: assigned.version,
              forward_version: assigned.forward_version ?? state?.forward_version,
              reverse_version: assigned.reverse_version ?? state?.reverse_version,
              emergency_forward_version: assigned.emergency_forward_version ?? state?.emergency_forward_version,
            };
            if (assigned.status === 'SUCCESS' || assigned.replayed) {
              lastCalibratedAnchor.set(direction, assigned.assignee || itemRead?.anchor);
            }
            result = {
              requestId: fields.requestId, requestName: fields.requestName,
              businessType: fields.businessType,
              status: 'SUCCESS', assignee: assigned.assignee, replayed: assigned.replayed,
              assignmentSeq: assigned.assignment_seq,
              cursorVersion: cursorVersion(assigned, direction),
              source: assigned.replayed ? 'replay' : 'auto',
            };
          } catch (error) {
            if (['ASSIGNMENT_CONFLICT', 'CURSOR_CALIBRATION_CONFLICT'].includes(error?.code)) {
              if (attempt < 1) {
                conflictOccurred = true;
                break;
              }
              // Last attempt failed with conflict; stop the batch to prevent bypassing guards
              const itemsToFail = batch.items.slice(batch.items.findIndex(i => i.requestId === fields.requestId));
              for (const f of itemsToFail) {
                latestResults = upsertBatchResult(latestResults, {
                  requestId: f.requestId, requestName: f.requestName, businessType: f.businessType,
                  status: 'FAILED', message: safeBatchFailure(error), errorCode: error.code,
                });
              }
              break;
            }
            const failedRowIndex = error?.resolvedRowIndex
              ?? batchReads.get(fields.requestId)?.resolvedRowIndex
              ?? fields.rowIndex;
            if (error?.assignmentCommitted || ['SHEET_TARGET_CHANGED', 'SHEET_ASSIGNMENT_MISMATCH'].includes(error?.code)) {
              batchReads.clear();
            }
            log('batch_item_failed', {
              ...logBase,
              request_id: fields.requestId,
              error_code: error?.code || 'DISPATCH_FAILED',
              http_status: error?.httpStatus || null,
              method: error?.method || '',
              endpoint: error?.endpoint || '',
              sheet_id: fields.sheetId,
              range: failedRowIndex ? `${fields.sheetId}!row:${failedRowIndex}` : '',
              api_code: error?.apiCode ?? null,
              api_message: redactLarkApiMessage(error?.apiMessage),
              lark_log_id: error?.logId || '',
            });
            result = {
              requestId: fields.requestId, requestName: fields.requestName,
              status: 'FAILED', message: safeBatchFailure(error), errorCode: error?.code || 'DISPATCH_FAILED',
            };
          }
          latestResults = upsertBatchResult(latestResults, result);
          await store.saveBatchProgress({
            chatId: event.chatId, batchId: batch.batchId, claimToken,
            status: BATCH_STATUS.PROCESSING, results: latestResults,
            leaseExpiresAt: batchLease(now(), leaseMs),
          });
        }

        if (conflictOccurred) {
          batchReads.clear();
          state = await store.getDailyState(dayKey, scope, now());
          const retryRoster = state?.roster || effectiveRoster;
          await readPendingTargets(retryRoster);
          continue;
        }
      }
      break;
    }
    const succeeded = latestResults.filter((item) => item.status === 'SUCCESS').length;
    finalStatus = succeeded === batch.items.length
      ? BATCH_STATUS.SUCCESS : succeeded === 0 ? BATCH_STATUS.FAILED : BATCH_STATUS.PARTIAL;
    await store.saveBatchProgress({
      chatId: event.chatId, batchId: batch.batchId, claimToken,
      status: finalStatus, results: latestResults, leaseExpiresAt: batchLease(now(), leaseMs),
    });

    const persistedState = await refreshDailyStateForCard({
      store, dayKey, scope, current: now(),
      fallbackState: state, fallbackRoster: effectiveRoster,
      fallbackAssignments: latestSuccessfulAssignments(batch.items, latestResults),
      log, logBase, flow: 'batch',
    });

    const dispatchedAt = formatDispatchTime(now());
    const retryableFinal = finalStatus === BATCH_STATUS.FAILED || finalStatus === BATCH_STATUS.PARTIAL;
    const finalCard = buildBatchStatusCard(batch.items, {
      batchId: batch.batchId, status: finalStatus, results: latestResults,
      cardTitle: batch.items[0]?.cardTitle,
      resumable: retryableFinal,
      retryAction: retryableFinal ? batchDispatchActionValue(batch.batchId, batch.items) : undefined,
    });
    const threadCard = buildBatchDispatchResultCard(batch.items, {
      batchId: batch.batchId,
      status: finalStatus,
      results: latestResults,
      roster: persistedState.roster,
      offDuty: persistedState.off_duty || [],
      forwardCursor: persistedState.forward_cursor,
      reverseCursor: persistedState.reverse_cursor,
    emergencyForwardCursor: persistedState.emergency_forward_cursor,
      direction: profileDirection(batch.items[0]),
      dispatchedAt,
      cardTitle: batch.items[0]?.cardTitle,
    });
    const digest = createHash('sha256')
      .update(`${event.chatId}:${batch.batchId}`)
      .digest('hex')
      .slice(0, 24);

    const cardDone = claim.card_update_done === true || await recordFinalization({
      store, event, batch, claimToken, effect: 'card', log, logBase,
      operation: () => client.updateMessageCard(targetMessageId, finalCard),
    });
    let threadDone = claim.thread_reply_done === true;
    if (!threadDone) {
      const previousResultMessageId = String(claim.result_message_id || '').trim();
      try {
        if (previousResultMessageId) {
          await client.updateMessageCard(previousResultMessageId, threadCard);
        } else {
          const reply = await client.replyInteractiveCard({
            messageId: targetMessageId, card: threadCard,
            uuid: `bess-batch-result-${digest}`, replyInThread: true,
          });
          const messageId = String(reply?.message_id || '').trim();
          if (!messageId) throw new Error('Batch result message id missing');
          await store.saveBatchResultMessage({
            chatId: event.chatId, batchId: batch.batchId, claimToken, messageId,
          });
          claim.result_message_id = messageId;
        }
        await store.markBatchFinalization({
          chatId: event.chatId, batchId: batch.batchId, claimToken,
          effect: 'thread', succeeded: true,
        });
        threadDone = true;
      } catch (updateError) {
        log('batch_result_update_failed', {
          ...logBase, result_message_id: previousResultMessageId,
          error_code: updateError?.code || 'BATCH_RESULT_UPDATE_FAILED',
        });
        try {
          const replacementCard = buildBatchDispatchResultCard(batch.items, {
            batchId: batch.batchId, status: finalStatus, results: latestResults,
            roster: persistedState.roster,
            offDuty: persistedState.off_duty || [],
            forwardCursor: persistedState.forward_cursor,
            reverseCursor: persistedState.reverse_cursor,
    emergencyForwardCursor: persistedState.emergency_forward_cursor,
            direction: profileDirection(batch.items[0]), dispatchedAt,
            cardTitle: batch.items[0]?.cardTitle,
            replacementNotice: '这是最新最终结果；此前的话题结果卡已失效，请以本卡为准',
          });
          const replacement = await client.replyInteractiveCard({
            messageId: targetMessageId, card: replacementCard,
            uuid: `bess-batch-final-${digest}-${claimToken.slice(0, 8)}`.slice(0, 50),
            replyInThread: true,
          });
          const messageId = String(replacement?.message_id || '').trim();
          if (!messageId) throw new Error('Replacement result message id missing');
          await store.saveBatchResultMessage({
            chatId: event.chatId, batchId: batch.batchId, claimToken, messageId,
          });
          claim.result_message_id = messageId;
          await store.markBatchFinalization({
            chatId: event.chatId, batchId: batch.batchId, claimToken,
            effect: 'thread', succeeded: true,
          });
          threadDone = true;
        } catch (replacementError) {
          await store.markBatchFinalization({
            chatId: event.chatId, batchId: batch.batchId, claimToken,
            effect: 'thread', succeeded: false,
            errorCode: replacementError?.code || 'BATCH_RESULT_REPLACEMENT_FAILED',
          }).catch(() => {});
          log('batch_finalization_failed', {
            ...logBase, effect: 'thread',
            error_code: replacementError?.code || 'BATCH_RESULT_REPLACEMENT_FAILED',
          });
        }
      }
    }

    await store.releaseBatchClaim({
      chatId: event.chatId, batchId: batch.batchId, claimToken, releasedAt: now(),
    }).catch((error) => log('batch_claim_release_failed', {
      ...logBase, error_code: error?.code || 'BATCH_CLAIM_RELEASE_FAILED',
    }));

    if (formMessageId && formMessageId !== targetMessageId) {
      const formCard = finalStatus === BATCH_STATUS.SUCCESS
        ? buildRosterCompletedCard(batch.items[0], {
          assignee: latestResults[0]?.assignee,
          direction: profileDirection(batch.items[0]),
          dispatchedAt,
        })
        : buildBatchStatusCard(batch.items, {
          batchId: batch.batchId,
          status: finalStatus,
          results: latestResults,
          cardTitle: finalStatus === BATCH_STATUS.FAILED ? '名单已保存，批量派单失败' : '名单已保存，批量派单部分失败',
          resumable: true,
          retryAction: batchDispatchActionValue(batch.batchId, batch.items),
        });
      await client.updateMessageCard(formMessageId, formCard).catch((error) => log('ui_update_failed', {
        ...logBase,
        operation: 'update_roster_form_card',
        error_code: error?.code || 'UI_UPDATE_FAILED',
        http_status: error?.httpStatus || null,
        endpoint: error?.endpoint || '',
      }));
      if (finalStatus === BATCH_STATUS.SUCCESS) {
        await store.markPendingCompleted(formMessageId, now()).catch((error) => log('pending_complete_failed', {
          ...logBase, error_code: error?.code || 'PENDING_COMPLETE_FAILED',
        }));
      }
    }

    log('batch_completed', {
      ...logBase, batch_status: finalStatus,
      success_count: latestResults.filter((item) => item.status === 'SUCCESS').length,
      failed_count: latestResults.filter((item) => item.status === 'FAILED').length,
      card_update_done: cardDone,
      thread_reply_done: threadDone,
    });
  };

  return {
    httpStatus: 200,
    body: { ...toast('info', claim.outcome === 'RESUMED' ? '正在恢复批量派单并补偿未完成结果' : '批量派单请求已受理，正在逐项处理'), card: { type: 'raw', data: processingCard } },
    updatedCard: processingCard,
    afterResponse,
  };
}

async function readSpecifiedTargetAssignee({ client, fields }) {
  const column = String(fields.assigneeFieldId || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(column)) {
    throw new DispatchValidationError('INVALID_ASSIGNEE_FIELD', '负责人列配置缺失或格式不正确');
  }
  const rows = await client.getSheetValues({
    sheetUrl: fields.sheetUrl,
    range: `${fields.sheetId}!${column}${fields.rowIndex}:${column}${fields.rowIndex}`,
  });
  return String(rows?.[0]?.[0] || '').trim();
}

async function createSpecifyAssigneeForm({ event, fields, roster, store, client, current, log, logBase }) {
  const existingPending = typeof store.getPendingByRequest === 'function'
    ? await store.getPendingByRequest(`specify_${fields.requestId}`, event.chatId, current)
    : null;
  if (existingPending) {
    return { httpStatus: 200, body: toast('info', '已存在待填写的指定人员表单，请在原话题中继续') };
  }
  const reply = await client.replyInteractiveCard({
    messageId: event.messageId,
    card: buildSpecifyAssigneeFormCard(fields, roster),
    uuid: `bess-specify-${fields.requestId}`.slice(0, 50),
    replyInThread: true,
  });
  const formMessageId = String(reply.message_id || '').trim();
  if (!formMessageId) throw new Error('Specify-assignee form message id missing');
  await store.savePending({
    form_message_id: formMessageId,
    request_id: `specify_${fields.requestId}`,
    original_message_id: event.messageId,
    chat_id: event.chatId,
    request_context: { ...fields, kind: 'specify_assignee' },
    expires_at: nextShanghaiMidnight(current),
  });
  log('specify_form_created', { ...logBase, form_message_id: formMessageId });
  return { httpStatus: 200, body: toast('success', '已创建指定人员表单，请在话题中填写负责人真实姓名') };
}

async function handleSpecifyAssignee({ event, fields, store, client, now, log, logBase }) {
  validateSheetTarget(fields);
  const current = now();
  const dayKey = shanghaiDay(current);
  const scope = profileScope(fields);
  const [state, existingAssignment, currentAssignee] = await Promise.all([
    store.getDailyState(dayKey, scope, current),
    typeof store.getAssignment === 'function'
      ? store.getAssignment(dayKey, fields.requestId, scope)
      : null,
    readSpecifiedTargetAssignee({ client, fields }),
  ]);
  const lockedAssignee = String(currentAssignee || '').trim();
  if (lockedAssignee) {
    throw new DispatchValidationError('ASSIGNEE_ALREADY_SET', `该需求已派给 ${lockedAssignee}，指定人员不可用`);
  }
  const reservedAssignee = String(existingAssignment?.assignee || '').trim();
  const roster = Array.isArray(state?.roster)
    ? state.roster.filter((name) => !Array.isArray(state.off_duty) || !state.off_duty.includes(name))
    : [];
  const formFields = reservedAssignee ? { ...fields, reservedAssignee } : fields;
  if (!state) {
    const requestId = `roster_specify_${fields.requestId}`;
    const existingPending = typeof store.getPendingByRequest === 'function'
      ? await store.getPendingByRequest(requestId, event.chatId, current)
      : null;
    if (existingPending) {
      return { httpStatus: 200, body: toast('info', '已存在待填写的名单表单，请在原话题中继续') };
    }
    const reply = await client.replyInteractiveCard({
      messageId: event.messageId,
      card: buildRosterFormCard(fields),
      uuid: `bess-specify-roster-${fields.requestId}`.slice(0, 50),
      replyInThread: true,
    });
    const formMessageId = String(reply.message_id || '').trim();
    if (!formMessageId) throw new Error('Specify roster form message id missing');
    await store.savePending({
      form_message_id: formMessageId,
      request_id: requestId,
      original_message_id: event.messageId,
      chat_id: event.chatId,
      request_context: { ...fields, kind: 'specify_assignee_roster' },
      expires_at: nextShanghaiMidnight(current),
    });
    log('specify_roster_form_created', { ...logBase, form_message_id: formMessageId });
    return { httpStatus: 200, body: toast('success', '请先填写该业态今日在班人员名单，提交后将继续指定负责人') };
  }
  if (roster.length === 0 && !reservedAssignee) {
    throw new DispatchValidationError('NO_ON_DUTY_ASSIGNEE', '该业态今日没有可指定的在班人员');
  }
  return createSpecifyAssigneeForm({
    event, fields: formFields, roster: reservedAssignee ? [reservedAssignee] : roster,
    store, client, current, log, logBase,
  });
}

async function updateSpecifiedOriginalCard({ client, pending, fields, formMessageId, completedAt, assignee, log, logBase }) {
  try {
    const original = await client.getMessage(pending.original_message_id);
    let originalCard = null;
    try {
      originalCard = typeof original?.body?.content === 'string'
        ? JSON.parse(original.body.content) : original?.body?.content || null;
    } catch {
      originalCard = null;
    }
    if (originalCard) {
      const patched = patchCardForDispatched(originalCard, {
        requestId: fields.requestId,
        threadMessageId: formMessageId,
        dispatchedAt: completedAt,
        assignee,
        assignmentMode: 'specified',
      });
      if (patched.patched) await client.updateMessageCard(pending.original_message_id, patched.card);
    }
  } catch (error) {
    log('specify_original_card_update_failed', { ...logBase, error_code: error?.code || 'CARD_UPDATE_FAILED' });
  }
}

async function handleSpecifyAssigneeSubmit({ event, store, client, now, log, logBase }) {
  const current = now();
  const pending = await store.getPending(event.messageId, current, { includeCompleted: true });
  if (!pending) {
    return { httpStatus: 200, body: toast('error', '指定人员表单已过期，请回到原卡片重新发起'), errorCode: 'PENDING_FORM_NOT_FOUND' };
  }
  if (pending.chat_id && pending.chat_id !== event.chatId) {
    throw new DispatchValidationError('PENDING_CHAT_MISMATCH', '指定人员表单与当前群聊不匹配，已拒绝处理');
  }
  const fields = normalizeProfileContext(typeof pending.request_context === 'string'
    ? JSON.parse(pending.request_context) : pending.request_context, event.chatId);
  if (fields?.kind !== 'specify_assignee') {
    throw new DispatchValidationError('INVALID_PENDING_KIND', '该表单不是指定人员表单');
  }
  if (pending.completed_at) {
    const assignee = String(fields.specifiedAssignee || '').trim();
    if (assignee) {
      await updateSpecifiedOriginalCard({
        client, pending, fields, formMessageId: event.messageId,
        completedAt: formatDispatchTime(new Date(pending.completed_at)), assignee, log, logBase,
      });
    }
    return { httpStatus: 200, body: toast('success', assignee ? `该需求已指定给 ${assignee}` : '该需求已完成指定，请勿重复提交'), errorCode: 'ALREADY_SPECIFIED' };
  }
  validateSheetTarget(fields);
  const assignees = parseRoster(event.formValue?.assignee_name);
  if (assignees.length !== 1) {
    throw new DispatchValidationError('INVALID_ASSIGNEE', '每次只能指定一位负责人真实姓名');
  }
  const assignee = assignees[0];
  const scope = profileScope(fields);
  const state = await store.getDailyState(shanghaiDay(current), scope, current);
  const reservedAssignee = String(fields.reservedAssignee || '').trim();
  const isReservationRecovery = reservedAssignee && reservedAssignee === assignee;
  if (!isReservationRecovery && (!Array.isArray(state?.roster) || !state.roster.includes(assignee)
      || (Array.isArray(state.off_duty) && state.off_duty.includes(assignee)))) {
    throw new DispatchValidationError('ASSIGNEE_NOT_ON_DUTY', '所选人员不在该业态今日在班名单中，请重新发起指定');
  }
  const column = String(fields.assigneeFieldId || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(column)) {
    throw new DispatchValidationError('INVALID_ASSIGNEE_FIELD', '负责人列配置缺失或格式不正确');
  }
  const readCurrentAssignee = async () => {
    const rows = await client.getSheetValues({
      sheetUrl: fields.sheetUrl,
      range: `${fields.sheetId}!${column}${fields.rowIndex}:${column}${fields.rowIndex}`,
    });
    return String(rows?.[0]?.[0] || '').trim();
  };
  const currentAssignee = await readCurrentAssignee();
  if (currentAssignee && currentAssignee !== assignee) {
    throw new DispatchValidationError('ASSIGNEE_ALREADY_SET', `该需求已有负责人 ${currentAssignee}，为避免覆盖已停止操作`);
  }
  if (typeof store.assignSpecific !== 'function') {
    throw new DispatchValidationError('SPECIFIC_ASSIGNMENT_UNAVAILABLE', '指定人员原子锁尚未配置，已停止写入');
  }
  const reservation = await store.assignSpecific({
    dayKey: shanghaiDay(current), scope, requestId: fields.requestId, assignee,
    context: { ...fields, assignmentMode: 'specified', operatorOpenId: event.operatorOpenId },
  });
  if (String(reservation.assignee || '').trim() !== assignee) {
    throw new DispatchValidationError('ASSIGNEE_ALREADY_SET', `该需求已被并发指定给 ${reservation.assignee}，未覆盖原结果`);
  }
  const lockedAssignee = await readCurrentAssignee();
  if (lockedAssignee && lockedAssignee !== assignee) {
    throw new DispatchValidationError('ASSIGNEE_ALREADY_SET', `该需求已有负责人 ${lockedAssignee}，为避免覆盖已停止操作`);
  }
  if (!lockedAssignee) {
    await client.writeSheetAssignee({ ...fields, assignee });
  }

  // A specified assignment has the same authority as a manual sheet anchor:
  // reset only this business direction so the next automatic assignment starts
  // from the selected person's successor. Keep the form retryable if calibration
  // fails; assignSpecific is idempotent and the sheet value is verified above.
  await calibrateFilledTarget({
    store,
    dayKey: shanghaiDay(current),
    scope,
    direction: profileDirection(fields),
    assignee,
    roster: state.roster,
    expectedVersion: state.version,
    expectedCursorVersion: cursorVersion(state, profileDirection(fields)),
  });

  const completedContext = { ...fields, specifiedAssignee: assignee };
  await store.markPendingCompleted(event.messageId, current, completedContext);

  const completedAt = formatDispatchTime(current);
  await updateSpecifiedOriginalCard({
    client, pending, fields: completedContext, formMessageId: event.messageId,
    completedAt, assignee, log, logBase,
  });
  log('specified', { ...logBase, request_id: fields.requestId, assignee });
  const card = buildSpecifyAssigneeCompletedCard(fields, { assignee, completedAt });
  return {
    httpStatus: 200,
    body: { ...toast('success', `已指定负责人：${assignee}`), card: { type: 'raw', data: card } },
    updatedCard: card,
  };
}

// Returns { httpStatus, body, errorCode? }. Business outcomes always use
// HTTP 200 with an error toast (non-2xx makes the Feishu client show a
// generic interaction error); protocol-level rejection stays in callback.js.
export async function handleDispatchEvent(body, {
  client,
  store,
  config = {},
  now = () => new Date(),
  logger = console,
} = {}) {
  const startedAt = Date.now();
  const duration = () => Date.now() - startedAt;
  const log = (stage, extra = {}) => safeLog(logger, stage, extra);

  if (!isFeatureEnabled(config.featureEnabled)) {
    log('skipped', { reason: 'FEATURE_DISABLED' });
    return { httpStatus: 200, body: toast('info', '自动派单功能暂未开启'), errorCode: 'FEATURE_DISABLED' };
  }

  const event = parseCardActionEvent(body);

  // Card actions without a dispatch value/form are acknowledged with no side effects.
  if (!event.value && !event.formValue) {
    return { httpStatus: 200, body: {} };
  }

  let fields = null;
  let batch = null;
  let adjust = null;
  let adjustSubmit = null;
  let specify = null;

  try {
    const validationContext = { chatId: event.chatId };
    if (event.value?.action === BATCH_DISPATCH_ACTION) {
      batch = enforceAssigneeFieldContract(validateBatchDispatchValue(event.value, validationContext));
      enforceSingleBatchScope(batch.items);
    } else if (event.value?.action === ADJUST_STATUS_ACTION) {
      adjust = validateAdjustStatusValue(event.value, validationContext);
    } else if (event.value?.action === ADJUST_STATUS_SUBMIT_ACTION) {
      adjustSubmit = validateAdjustStatusSubmitValue(event.value, validationContext);
    } else if (event.value?.action === SPECIFY_ASSIGNEE_ACTION) {
      specify = validateSpecifyAssigneeValue(event.value, validationContext);
    } else if (!event.formValue) {
      fields = validateDispatchValue(event.value, validationContext);
    }
  } catch (error) {
    if (error instanceof DispatchValidationError) {
      log('rejected', { event_id: event.eventId, error_code: error.code, duration_ms: duration() });
      return { httpStatus: 200, body: toast('error', error.userMessage), errorCode: error.code };
    }
    throw error;
  }

  const logBase = { event_id: event.eventId };
  if (fields || specify) Object.assign(logBase, {
    request_id: (fields || specify).requestId,
    message_id: event.messageId,
    business_type: (fields || specify).businessType,
  });
  if (batch) Object.assign(logBase, {
    batch_id: batch.batchId,
    request_count: batch.items.length,
    message_id: event.messageId,
  });
  if (adjust || adjustSubmit) Object.assign(logBase, {
    business_type: adjust?.businessType || adjustSubmit?.businessType,
    day_key: adjust?.dayKey || adjustSubmit?.dayKey,
  });

  if (!event.operatorOpenId) {
    log('rejected', { ...logBase, error_code: 'MISSING_OPERATOR', duration_ms: duration() });
    return { httpStatus: 200, body: toast('error', '无法识别操作人，请稍后重试'), errorCode: 'MISSING_OPERATOR' };
  }
  if (!event.messageId) {
    log('rejected', { ...logBase, error_code: 'MISSING_MESSAGE_ID', duration_ms: duration() });
    return {
      httpStatus: 200,
      body: toast('error', '无法定位原卡片消息，请在最新监控卡片上操作'),
      errorCode: 'MISSING_MESSAGE_ID',
    };
  }

  const allowedChatIds = parseAllowedChatIds(config.allowedChatIds);
  if (allowedChatIds.length === 0) {
    log('rejected', { ...logBase, error_code: 'CHAT_ALLOWLIST_NOT_CONFIGURED', duration_ms: duration() });
    return {
      httpStatus: 200,
      body: toast('error', '自动派单暂未配置可用群聊，请联系值班同学'),
      errorCode: 'CHAT_ALLOWLIST_NOT_CONFIGURED',
    };
  }
  if (!allowedChatIds.includes(event.chatId)) {
    log('rejected', { ...logBase, error_code: 'CHAT_NOT_ALLOWED', duration_ms: duration() });
    return { httpStatus: 200, body: toast('error', '当前群未开启自动派单'), errorCode: 'CHAT_NOT_ALLOWED' };
  }

  // P1 is enabled whenever a store is injected or Supabase credentials exist.
  // The no-database branch below preserves the existing P0 local/test behavior.
  let persistentStore = store;
  if (!persistentStore && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    persistentStore = createSupabaseDispatchStore();
  }
  if (persistentStore) {
    try {
      if (!client) throw new Error('Lark client not configured');
      if (event.formValue?.assignee_name !== undefined) {
        return await handleSpecifyAssigneeSubmit({
          event, store: persistentStore, client, now, log, logBase, config,
        });
      }
      if (specify) {
        return await handleSpecifyAssignee({
          event, fields: specify, store: persistentStore, client, now, log, logBase, config,
        });
      }
      if (batch) {
        return await handleBatchDispatch({
          event, batch, store: persistentStore, client, now, log, logBase, config,
        });
      }
      if (adjust) {
        return await handleAdjustStatus({
          event, adjust, store: persistentStore, client, now, log, logBase, config,
        });
      }
      if (adjustSubmit) {
        return await handleAdjustStatusSubmit({
          event, adjustSubmit, store: persistentStore, client, now, log, logBase, config,
        });
      }
      return await p1Dispatch({ event, fields, store: persistentStore, client, now, log, logBase, config });
    } catch (error) {
      const validation = error instanceof DispatchValidationError || error instanceof RosterValidationError;
      const isAllOff = error?.message === 'ALL_OFF_DUTY' || error?.dbMessage === 'ALL_OFF_DUTY';
      const code = isAllOff ? 'WAITING_NO_AVAILABLE_ASSIGNEE' : (error?.code || 'DISPATCH_FAILED');

      log('failed', {
        ...logBase,
        error_code: code,
        ...(error.assignmentCommitted ? { assignment_committed: true } : {}),
        ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
        duration_ms: duration(),
      });

      const userMessage = isAllOff ? '所有人员均已离岗，派单已进入等待；请通过人员状态入口恢复至少一人'
        : validation ? (error.userMessage || error.message)
          : error.assignmentCommitted
            ? (code === 'SHEET_TARGET_CHANGED' ? safeBatchFailure(error)
              : '派单记录已落库，表格写回未确认；请人工核对，勿重复派单')
            : '派单失败，请稍后重试或联系值班同学';
      const failureBody = toast('error', userMessage);
      // Explicitly return an enabled original action on failure. Feishu may keep
      // the clicked button in its loading/disabled state unless the callback
      // supplies a replacement card.
      if (fields && event.value) {
        const failureCard = isAllOff ? buildRosterSavedCard(fields) : buildInitialDispatchCard(fields, event.value);
        if (isAllOff) {
          failureCard.header.title.content = '等待可派人员';
          failureCard.body.elements[0].content = `**${fields.requestName}**\n所有人员均已离岗，未创建派单记录。请先点击“调整人员状态”恢复至少一人，再重试原派单请求。`;
          const button = failureCard.body.elements.find((el) => el.tag === 'button' && el.text?.content?.includes('开始自动派单'));
          if (button) {
            button.disabled = true;
            button.disabled_tips = { tag: 'plain_text', content: '今日所有人员均已离岗' };
          }
        }
        failureBody.card = { type: 'raw', data: failureCard };
      }
      return {
        httpStatus: 200,
        body: failureBody,
        errorCode: isAllOff ? 'WAITING_NO_AVAILABLE_ASSIGNEE' : code,
      };
    }
  }
  if (batch) {
    return { httpStatus: 200, body: toast('error', '批量派单数据库尚未配置'), errorCode: 'DISPATCH_DB_NOT_CONFIGURED' };
  }
  if (specify) {
    return { httpStatus: 200, body: toast('error', '指定人员数据库尚未配置'), errorCode: 'DISPATCH_DB_NOT_CONFIGURED' };
  }
  if (event.formValue) {
    return { httpStatus: 200, body: toast('error', '派单数据库尚未配置'), errorCode: 'DISPATCH_DB_NOT_CONFIGURED' };
  }
  if (completed.has(fields.requestId)) {
    log('replayed', { ...logBase, duration_ms: duration() });
    return { httpStatus: 200, body: toast('success', '该需求已派单，请勿重复点击'), errorCode: 'ALREADY_DISPATCHED' };
  }
  if (inFlight.has(fields.requestId)) {
    log('in_flight', { ...logBase, duration_ms: duration() });
    return { httpStatus: 200, body: toast('info', '派单处理中，请勿重复点击'), errorCode: 'IN_FLIGHT' };
  }
  inFlight.add(fields.requestId);

  try {
    if (!client) {
      throw new Error('Lark client not configured');
    }

    const dispatchedAt = formatDispatchTime(now());
    const threadText = buildDispatchThreadText(fields, { dispatchedAt });

    // Reply (thread creation) and original-card fetch are independent; run
    // them in parallel to stay inside Feishu's 3s callback window. A card
    // fetch failure must not fail the whole dispatch.
    const [threadData, originalMessage] = await Promise.all([
      client.replyMessage({
        messageId: event.messageId,
        msgType: 'text',
        content: { text: threadText },
        uuid: replyUuidFor(fields.requestId),
        replyInThread: true,
      }),
      client.getMessage(event.messageId).catch((error) => {
        log('card_fetch_failed', {
          ...logBase,
          error_code: error instanceof LarkApiError ? error.code : 'CARD_FETCH_FAILED',
          error_message: error instanceof Error ? error.message : String(error),
          duration_ms: duration(),
        });
        return null;
      }),
    ]);

    const threadMessageId = String(threadData?.message_id || '').trim();
    log('thread_created', { ...logBase, thread_message_id: threadMessageId, duration_ms: duration() });

    let responseBody = toast('success', '派单话题已创建，请在话题内跟进');
    let updatedCard = null;
    let cardBuildMode = 'generated_fallback';

    if (originalMessage && originalMessage.msg_type === 'interactive' && originalMessage.body?.content) {
      let originalCard = null;
      try {
        originalCard = JSON.parse(originalMessage.body.content);
      } catch {
        log('card_patch_unavailable', { ...logBase, reason: 'INVALID_CARD_CONTENT', duration_ms: duration() });
      }
      if (originalCard?.schema === '2.0') {
        const result = patchCardForDispatched(originalCard, {
          requestId: fields.requestId,
          threadMessageId,
          dispatchedAt,
        });
        if (result.patched) {
          updatedCard = result.card;
          cardBuildMode = 'patched_original';
        } else {
          log('card_patch_unavailable', { ...logBase, reason: 'DISPATCH_BUTTON_NOT_FOUND', duration_ms: duration() });
        }
      } else if (originalCard) {
        // Feishu's message-read API returns interactive cards as a compact,
        // display-only object ({ title, elements }) rather than the original
        // Card JSON. It cannot be patched safely, so use the callback fields.
        log('card_patch_unavailable', { ...logBase, reason: 'COMPACT_CARD_CONTENT', duration_ms: duration() });
      }
    } else {
      log('card_patch_unavailable', {
        ...logBase,
        reason: originalMessage ? 'NON_INTERACTIVE_MESSAGE' : 'MESSAGE_UNAVAILABLE',
        duration_ms: duration(),
      });
    }

    if (!updatedCard && fields.batchCard) {
      completed.add(fields.requestId);
      log('succeeded', {
        ...logBase,
        card_response_included: false,
        card_update_mode: 'batch_preserved_without_patch',
        duration_ms: duration(),
      });
      return { httpStatus: 200, body: responseBody };
    }
    if (!updatedCard) {
      updatedCard = buildDispatchedCard(fields, { dispatchedAt });
    }
    if (event.cardUpdateToken) {
      const afterResponse = async () => {
        try {
          await client.delayUpdateMessageCard(event.cardUpdateToken, updatedCard);
          log('card_update_succeeded', {
            ...logBase,
            card_update_mode: 'delayed_card_update',
            card_build_mode: cardBuildMode,
            duration_ms: duration(),
          });
        } catch (error) {
          log('card_update_failed', {
            ...logBase,
            error_code: error instanceof LarkApiError ? error.code : 'CARD_UPDATE_FAILED',
            error_message: error instanceof Error ? error.message : String(error),
            duration_ms: duration(),
          });
        }
      };

      completed.add(fields.requestId);
      log('succeeded', {
        ...logBase,
        card_response_included: false,
        card_update_mode: 'delayed_card_update',
        card_build_mode: cardBuildMode,
        duration_ms: duration(),
      });
      return { httpStatus: 200, body: responseBody, afterResponse, updatedCard };
    }

    // Old or malformed callbacks may omit event.token. Preserve the documented
    // immediate-update response as a compatibility fallback.
    responseBody.card = { type: 'raw', data: updatedCard };
    completed.add(fields.requestId);
    log('succeeded', {
      ...logBase,
      card_response_included: true,
      card_update_mode: 'callback_response_fallback',
      card_build_mode: cardBuildMode,
      duration_ms: duration(),
    });
    return { httpStatus: 200, body: responseBody };
  } catch (error) {
    const code = error instanceof LarkApiError ? error.code : 'DISPATCH_FAILED';
    log('failed', {
      ...logBase,
      error_code: code,
      error_message: error instanceof Error ? error.message : String(error),
      duration_ms: duration(),
    });
    const failureBody = toast('error', '派单失败，请稍后重试或联系值班同学');
    failureBody.card = { type: 'raw', data: buildInitialDispatchCard(fields, event.value) };
    return {
      httpStatus: 200,
      body: failureBody,
      errorCode: code,
    };
  } finally {
    inFlight.delete(fields.requestId);
  }
}
