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
  DISPATCH_ACTION,
  BATCH_DISPATCH_ACTION,
  ADJUST_STATUS_ACTION,
  ADJUST_STATUS_SUBMIT_ACTION,
  BATCH_STATUS,
  parseAllowedChatIds,
  isFeatureEnabled,
  DispatchValidationError,
} from '../lark/card-actions.js';
import { createSupabaseDispatchStore } from './supabase-store.js';
import { batchDispatchActionValue } from './ingest.js';
import { parseRoster, secureShuffle, shanghaiDay, nextShanghaiMidnight, dispatchDirection, RosterValidationError } from './roster.js';
import { inspectLatestDailyAnchor, projectMatches, sheetDateDay } from './sheet-anchor.js';
import {
  patchCardForDispatched,
  buildInitialDispatchCard,
  buildDispatchedCard,
  buildDispatchThreadText,
  buildRosterFormCard,
  buildRosterCompletedCard,
  buildAdjustStatusFormCard,
  buildDispatchResultCard,
  buildBatchStatusCard,
  buildBatchDispatchResultCard,
  formatDispatchTime,
} from '../lark/card-renderer.js';

// Single-item actions retain their historical best-effort warm-instance guard.
// Batch actions never use it: they require the store's atomic persistent claim.
const inFlight = new Set();
const completed = new Set();

function toast(type, content) {
  return { toast: { type, content } };
}

function safeLog(logger, stage, fields) {
  try {
    logger.info(JSON.stringify({ module: 'bess-dispatch', stage, ...fields }));
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

async function readTargetAndAnchor({ client, fields, dayKey, roster, store }) {
  let valueAtTargetRow = null;
  let anchorResult = {
    anchor: null, previousAssignee: null, hasRelevantAssignment: false, invalidAssignee: null,
  };
  const allowBlankProject = Boolean(fields.projectValue) && fields.sheetId !== 'TQuzLA';
  const persisted = typeof store.getDailyAssignments === 'function'
    ? await store.getDailyAssignments(dayKey) : [];
  const sameScope = (row) => {
    const context = typeof row.request_context === 'string' ? JSON.parse(row.request_context) : row.request_context || {};
    if (String(context.sheetId || context.sheet_id || '') !== String(fields.sheetId)) return false;
    if (!fields.projectValue) return true;
    return projectMatches(context.projectValue || context.project_value, fields.projectValue);
  };
  const scoped = persisted.filter(sameScope);
  const expectedByRow = new Map(scoped.map((row) => {
    const context = typeof row.request_context === 'string' ? JSON.parse(row.request_context) : row.request_context || {};
    return [Number(context.rowIndex || context.row_index), String(row.assignee || '').trim()];
  }));
  const durableAnchor = scoped.find((row) => roster.includes(String(row.assignee || '').trim()));
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
      const relativeIndex = fields.rowIndex - startRow;
      if (relativeIndex >= 0 && relativeIndex < rows.length) {
        valueAtTargetRow = String(rows[relativeIndex][1] || '').trim();
      }
      if (rows.length > 0) {
        const candidate = inspectLatestDailyAnchor(rows, {
          targetDay: dayKey, roster, projectValue: fields.projectValue, allowBlankProject,
        });
        if (candidate.anchor && persisted.length === 0) anchorResult = candidate;
        rows.forEach((row, index) => {
          const absoluteRow = startRow + index;
          const assignee = String(row?.[1] || '').trim();
          if (sheetDateDay(row?.[0], dayKey) !== dayKey
              || !projectMatches(row?.[2], fields.projectValue, { allowBlank: allowBlankProject })
              || !roster.includes(assignee)) return;
          // Sheets expose values but no trustworthy cell edit time. A roster
          // value absent from, or different to, our persisted row assignment is
          // considered manual. If several such edits exist, highest row wins: a
          // deterministic and explainable fallback, not a claimed timestamp.
          if (expectedByRow.get(absoluteRow) !== assignee && absoluteRow >= manualAnchorRow) {
            manualAnchor = assignee;
            manualAnchorRow = absoluteRow;
          }
        });
      }
      return manualAnchor || durableAnchor?.assignee || anchorResult.anchor;
    },
  });

  const effectiveAnchor = manualAnchor || String(durableAnchor?.assignee || '').trim() || anchorResult.anchor;
  if (effectiveAnchor) {
    anchorResult = {
      anchor: effectiveAnchor, previousAssignee: effectiveAnchor,
      hasRelevantAssignment: true, invalidAssignee: null,
    };
  }
  const existingAssignment = await store.getAssignment(dayKey, fields.requestId);
  return { valueAtTargetRow, existingAssignment, ...anchorResult };
}

async function calibrateFilledTarget({ store, dayKey, assignee, roster }) {
  if (typeof store.calibrateCursor !== 'function') {
    throw new Error('Persistent cursor calibration is unavailable');
  }
  await store.calibrateCursor({ dayKey, assignee, roster });
}

async function p1Dispatch({ event, fields, store, client, now, log, logBase, config }) {
  const current = now();
  const dayKey = shanghaiDay(current);
  const expiresAt = nextShanghaiMidnight(current);
  const cleanupTask = store.cleanupExpired(current);

  let context = fields;
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
    context = typeof pending.request_context === 'string' ? JSON.parse(pending.request_context) : pending.request_context;
    roster = secureShuffle(parseRoster(event.formValue.roster_names));

    if (context.kind === 'batch') {
      return handleBatchDispatch({
        event: { ...event, messageId: pending.original_message_id },
        batch: context,
        store, client, now, log, logBase, config,
        roster,
        formMessageId: event.messageId,
      });
    }

    direction = dispatchDirection(context.businessType);
  } else {
    validateSheetTarget(fields);
    const [, fetchedState] = await Promise.all([cleanupTask, store.getDailyState(dayKey, current)]);
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
    direction = dispatchDirection(fields.businessType);
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
  }

  validateSheetTarget(context);
  const effectiveRoster = roster || state?.roster;
  const {
    valueAtTargetRow, existingAssignment, anchor, previousAssignee,
  } = await readTargetAndAnchor({
    client, fields: context, dayKey, roster: effectiveRoster, store,
  });
  context.valueAtTargetRow = valueAtTargetRow;
  context.existingAssignment = existingAssignment;

  let assigned;
  let skipWrite = false;
  const currentDayKey = dayKey || shanghaiDay(now());

  if (context.valueAtTargetRow) {
    if (effectiveRoster.includes(context.valueAtTargetRow)) {
      await calibrateFilledTarget({
        store, dayKey: currentDayKey, assignee: context.valueAtTargetRow, roster: effectiveRoster,
      });
    }
    skipWrite = true;
    assigned = {
      assignee: context.valueAtTargetRow,
      roster: effectiveRoster || [],
      original_message_id: context.existingAssignment?.original_message_id || event.messageId,
      replayed: true,
    };
  }

  if (!assigned) {
    assigned = await store.assign({
      dayKey: currentDayKey, requestId: context.requestId, direction, roster, expiresAt,
      context: {
        ...context,
        anchor_assignee: anchor || undefined,
        originalMessageId: event.formValue ? undefined : event.messageId,
      },
    });
  }

  if (!assigned?.assignee || !Array.isArray(assigned.roster)) throw new Error('Invalid assignment response');
  if (!assigned.replayed && previousAssignee
      && String(assigned.assignee).trim() === String(previousAssignee).trim()) {
    throw new DispatchValidationError('DUPLICATE_CONSECUTIVE_ASSIGNEE', '派单结果与上一位负责人重复，已停止写表，请重试');
  }

  if (!skipWrite) {
    await client.writeSheetAssignee({
      sheetUrl: context.sheetUrl, sheetId: context.sheetId, rowIndex: context.rowIndex,
      assigneeFieldId: context.assigneeFieldId, assigneeFieldName: context.assigneeFieldName,
      assignee: assigned.assignee,
    });
  }

  const originalMessageId = pending?.original_message_id || assigned.original_message_id || event.messageId;
  const resultCard = buildDispatchResultCard(context, {
    assignee: assigned.assignee, direction, roster: assigned.roster,
    offDuty: state?.off_duty || [],
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
    if (event.formValue && event.messageId !== originalMessageId) {
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
    : undefined;
  log('assigned', { ...logBase, assignee: assigned.assignee, direction, replayed: Boolean(assigned.replayed) });
  return {
    httpStatus: 200,
    body: toast('success', assigned.replayed ? `该需求已派给 ${assigned.assignee}` : `派单成功：${assigned.assignee}`),
    updatedCard, afterResponse,
  };
}

async function dispatchBatchItem({ fields, store, client, current, roster }) {
  validateSheetTarget(fields);
  const dayKey = shanghaiDay(current);
  const state = await store.getDailyState(dayKey, current);
  const effectiveRoster = state?.roster || roster;
  if (!Array.isArray(effectiveRoster) || effectiveRoster.length === 0) {
    throw new DispatchValidationError('ROSTER_NOT_INITIALIZED', '今日派单名单尚未初始化');
  }
  const direction = dispatchDirection(fields.businessType);
  if ((!fields.dateFieldId && !fields.dateFieldName)) {
    throw new DispatchValidationError('INVALID_DATE_FIELD', '按钮缺少日期字段配置');
  }
  if (fields.dateFieldId && !/^[A-Z]{1,3}$/.test(fields.dateFieldId)) {
    throw new DispatchValidationError('INVALID_DATE_FIELD', '日期列字母格式不正确');
  }
  if (fields.projectValue && !fields.projectFieldId && !fields.projectFieldName) {
    throw new DispatchValidationError('INVALID_PROJECT_FIELD', '按钮缺少项目字段配置');
  }

  const {
    valueAtTargetRow, anchor, previousAssignee,
  } = await readTargetAndAnchor({
    client, fields, dayKey, roster: effectiveRoster, store,
  });

  let assigned;
  let skipWrite = false;
  if (valueAtTargetRow) {
    if (effectiveRoster.includes(valueAtTargetRow)) {
      await calibrateFilledTarget({ store, dayKey, assignee: valueAtTargetRow, roster: effectiveRoster });
    }
    skipWrite = true;
    assigned = {
      assignee: valueAtTargetRow,
      replayed: true,
    };
  }

  if (!assigned) {
    assigned = await store.assign({
      dayKey, requestId: fields.requestId, direction, roster: roster || null,
      expiresAt: nextShanghaiMidnight(current),
      context: { ...fields, anchor_assignee: anchor || undefined },
    });
  }

  if (!assigned?.assignee) throw new Error('Invalid assignment response');
  if (!assigned.replayed && previousAssignee
      && String(assigned.assignee).trim() === String(previousAssignee).trim()) {
    throw new DispatchValidationError('DUPLICATE_CONSECUTIVE_ASSIGNEE', '派单结果与上一位负责人重复，已停止写表，请重试');
  }
  if (!skipWrite) {
    await client.writeSheetAssignee({
      sheetUrl: fields.sheetUrl, sheetId: fields.sheetId, rowIndex: fields.rowIndex,
      assigneeFieldId: fields.assigneeFieldId, assigneeFieldName: fields.assigneeFieldName,
      assignee: assigned.assignee,
    });
  }
  return { assignee: assigned.assignee, replayed: Boolean(assigned.replayed) };
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

async function handleAdjustStatus({ adjust, store, now }) {
  const current = now();
  const dayKey = adjust.dayKey || shanghaiDay(current);
  const state = await store.getDailyState(dayKey, current);
  if (!state) {
    return { httpStatus: 200, body: toast('error', '今日派单尚未初始化，无法调整状态') };
  }
  const formCard = buildAdjustStatusFormCard({
    dayKey,
    businessType: adjust.businessType,
    roster: state.roster,
    offDuty: state.off_duty || [],
    version: state.version,
  });
  return {
    httpStatus: 200,
    body: { card: { type: 'raw', data: formCard } },
  };
}

async function handleAdjustStatusSubmit({ event, adjustSubmit, store, client, now, log, logBase }) {
  const current = now();
  const formValue = event.formValue;
  const targetName = formValue?.target_name;
  const opType = formValue?.op_type;
  const reason = formValue?.reason || '未填写原因';

  if (!targetName || !opType) {
    return { httpStatus: 200, body: toast('error', '请选择人员和操作类型') };
  }

  const state = await store.getDailyState(adjustSubmit.dayKey, current);
  if (!state) {
    return { httpStatus: 200, body: toast('error', '今日派单状态已过期') };
  }

  let nextOffDuty = [...(state.off_duty || [])];
  if (opType === 'leave') {
    if (!nextOffDuty.includes(targetName)) nextOffDuty.push(targetName);
  } else {
    nextOffDuty = nextOffDuty.filter((name) => name !== targetName);
  }

  await store.updateRosterStatus({
    dayKey: adjustSubmit.dayKey,
    offDuty: nextOffDuty,
    expectedVersion: adjustSubmit.expectedVersion,
  });

  const auditMessage = `📌 **人员状态调整**\n操作人：<at user_id="${event.operatorOpenId}"></at>\n人员：${targetName}\n操作：${opType === 'leave' ? '临时离岗' : '恢复接单'}\n原因：${reason}\n时间：${formatDispatchTime(current)}`;

  await client.replyMessage({
    messageId: event.messageId,
    msgType: 'text',
    content: { text: auditMessage },
    replyInThread: true,
  });

  log('status_adjusted', { ...logBase, target: targetName, op: opType });

  return {
    httpStatus: 200,
    body: toast('success', `人员 ${targetName} 状态已更新为 ${opType === 'leave' ? '离岗' : '在岗'}`),
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

  const fingerprint = createHash('sha256').update(JSON.stringify(batch.items)).digest('hex');
  const current = now();
  const dayKey = shanghaiDay(current);
  const state = await store.getDailyState(dayKey, current);
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
      try {
        const itemRoster = (latestResults.length === 0 && roster) ? roster : null;
        const assigned = await dispatchBatchItem({ fields, store, client, current: now(), roster: itemRoster });
        result = {
          requestId: fields.requestId, requestName: fields.requestName,
          status: 'SUCCESS', assignee: assigned.assignee, replayed: assigned.replayed,
        };
      } catch (error) {
        log('batch_item_failed', {
          ...logBase,
          request_id: fields.requestId,
          error_code: error?.code || 'DISPATCH_FAILED',
          http_status: error?.httpStatus || null,
          method: error?.method || '',
          endpoint: error?.endpoint || '',
          sheet_id: fields.sheetId,
          range: fields.rowIndex ? `${fields.sheetId}!row:${fields.rowIndex}` : '',
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
    const succeeded = latestResults.filter((item) => item.status === 'SUCCESS').length;
    finalStatus = succeeded === batch.items.length
      ? BATCH_STATUS.SUCCESS : succeeded === 0 ? BATCH_STATUS.FAILED : BATCH_STATUS.PARTIAL;
    await store.saveBatchProgress({
      chatId: event.chatId, batchId: batch.batchId, claimToken,
      status: finalStatus, results: latestResults, leaseExpiresAt: batchLease(now(), leaseMs),
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
      roster: state?.roster || roster,
      offDuty: state?.off_duty || [],
      direction: dispatchDirection(batch.items[0]?.businessType),
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
            roster: state?.roster || roster,
            direction: dispatchDirection(batch.items[0]?.businessType), dispatchedAt,
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
          direction: dispatchDirection(batch.items[0].businessType),
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

  try {
    if (event.value?.action === BATCH_DISPATCH_ACTION) {
      batch = validateBatchDispatchValue(event.value);
    } else if (event.value?.action === ADJUST_STATUS_ACTION) {
      adjust = validateAdjustStatusValue(event.value);
    } else if (event.value?.action === ADJUST_STATUS_SUBMIT_ACTION) {
      adjustSubmit = validateAdjustStatusSubmitValue(event.value);
    } else if (event.value?.action === DISPATCH_ACTION) {
      fields = validateDispatchValue(event.value);
    }
  } catch (error) {
    if (error instanceof DispatchValidationError) {
      log('rejected', { event_id: event.eventId, error_code: error.code, duration_ms: duration() });
      return { httpStatus: 200, body: toast('error', error.userMessage), errorCode: error.code };
    }
    throw error;
  }

  const logBase = { event_id: event.eventId };
  if (fields) Object.assign(logBase, {
    request_id: fields.requestId,
    message_id: event.messageId,
    business_type: fields.businessType,
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
      if (adjustSubmit || (event.formValue && event.actionTag === 'adjust_status_form')) {
        return await handleAdjustStatusSubmit({
          event, adjustSubmit, store: persistentStore, client, now, log, logBase, config,
        });
      }
      return await p1Dispatch({ event, fields, store: persistentStore, client, now, log, logBase, config });
    } catch (error) {
      const validation = error instanceof DispatchValidationError || error instanceof RosterValidationError;
      const isAllOff = error?.message === 'ALL_OFF_DUTY' || error?.dbMessage === 'ALL_OFF_DUTY';
      const code = isAllOff ? 'ALL_OFF_DUTY' : (error?.code || 'DISPATCH_FAILED');

      log('failed', {
        ...logBase,
        error_code: code,
        ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
        duration_ms: duration(),
      });

      const userMessage = isAllOff ? '所有人员均已离岗，请手动处理' : (validation ? (error.userMessage || error.message) : '派单失败，请稍后重试或联系值班同学');
      const failureBody = toast('error', userMessage);
      // Explicitly return an enabled original action on failure. Feishu may keep
      // the clicked button in its loading/disabled state unless the callback
      // supplies a replacement card.
      if (fields && event.value) {
        const failureCard = buildInitialDispatchCard(fields, event.value);
        if (isAllOff) {
          // Disable button if all are off duty
          const button = failureCard.body.elements.find((el) => el.tag === 'button');
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
        errorCode: isAllOff ? 'ALL_OFF_DUTY' : code,
      };
    }
  }
  if (batch) {
    return { httpStatus: 200, body: toast('error', '批量派单数据库尚未配置'), errorCode: 'DISPATCH_DB_NOT_CONFIGURED' };
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
