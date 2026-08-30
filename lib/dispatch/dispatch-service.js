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
import { LarkApiError } from '../lark/client.js';
import {
  parseCardActionEvent,
  validateDispatchValue,
  parseAllowedChatIds,
  isFeatureEnabled,
  DispatchValidationError,
} from '../lark/card-actions.js';
import { createSupabaseDispatchStore } from './supabase-store.js';
import { parseRoster, secureShuffle, shanghaiDay, nextShanghaiMidnight, dispatchDirection, RosterValidationError } from './roster.js';
import { latestDailyAnchor } from './sheet-anchor.js';
import {
  patchCardForDispatched,
  buildDispatchedCard,
  buildDispatchThreadText,
  buildRosterFormCard,
  buildRosterCompletedCard,
  buildDispatchResultCard,
  formatDispatchTime,
} from '../lark/card-renderer.js';

// Best-effort in-process de-duplication. Serverless instances are ephemeral,
// so the Feishu reply `uuid` below is the real server-side idempotency guard;
// this store only absorbs rapid double clicks within one warm instance.
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

async function p1Dispatch({ event, fields, store, client, now, log, logBase }) {
  const current = now();
  const dayKey = shanghaiDay(current);
  const expiresAt = nextShanghaiMidnight(current);
  const cleanupTask = store.cleanupExpired(current);

  let context = fields;
  let roster = null;
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
    direction = dispatchDirection(context.businessType);
  } else {
    validateSheetTarget(fields);
    const [, state] = await Promise.all([cleanupTask, store.getDailyState(dayKey, current)]);
    if (!state) {
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
    const anchorAssignee = await client.readSheetDispatchRows({
      sheetUrl: fields.sheetUrl,
      sheetId: fields.sheetId,
      dateFieldId: fields.dateFieldId,
      dateFieldName: fields.dateFieldName,
      assigneeFieldId: fields.assigneeFieldId,
      assigneeFieldName: fields.assigneeFieldName,
      projectFieldId: fields.projectValue ? fields.projectFieldId : '',
      projectFieldName: fields.projectValue ? fields.projectFieldName : '',
      selectLatest: (rows) => latestDailyAnchor(rows, {
        targetDay: dayKey, roster: state.roster, projectValue: fields.projectValue,
      }),
    });
    if (anchorAssignee) {
      const existingAssignment = await store.getAssignment(dayKey, fields.requestId);
      if (!existingAssignment) {
        const anchorIndex = state.roster.findIndex((name) => String(name).trim() === anchorAssignee);
        if (anchorIndex >= 0) {
          const cursor = direction === 'forward' ? anchorIndex + 1 : state.roster.length - anchorIndex;
          await store.calibrateCursor({ dayKey, direction, cursor });
        }
      }
    }
  }

  validateSheetTarget(context);
  const assigned = await store.assign({
    dayKey, requestId: context.requestId, direction, roster, expiresAt,
    context: { ...context, originalMessageId: event.formValue ? undefined : event.messageId },
  });
  if (!assigned?.assignee || !Array.isArray(assigned.roster)) throw new Error('Invalid assignment response');

  await client.writeSheetAssignee({
    sheetUrl: context.sheetUrl, sheetId: context.sheetId, rowIndex: context.rowIndex,
    assigneeFieldId: context.assigneeFieldId, assigneeFieldName: context.assigneeFieldName,
    assignee: assigned.assignee,
  });

  const originalMessageId = pending?.original_message_id || assigned.original_message_id || event.messageId;
  const resultCard = buildDispatchResultCard(context, {
    assignee: assigned.assignee, direction, roster: assigned.roster,
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
  if (!event.formValue) {
    try {
      fields = validateDispatchValue(event.value);
    } catch (error) {
      if (error instanceof DispatchValidationError) {
        log('rejected', { event_id: event.eventId, error_code: error.code, duration_ms: duration() });
        return { httpStatus: 200, body: toast('error', error.userMessage), errorCode: error.code };
      }
      throw error;
    }
  }

  const logBase = { event_id: event.eventId };
  if (fields) Object.assign(logBase, {
    request_id: fields.requestId,
    message_id: event.messageId,
    business_type: fields.businessType,
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
      return await p1Dispatch({ event, fields, store: persistentStore, client, now, log, logBase });
    } catch (error) {
      const validation = error instanceof DispatchValidationError || error instanceof RosterValidationError;
      const code = error?.code || 'DISPATCH_FAILED';
      log('failed', {
        ...logBase,
        error_code: code,
        ...(error instanceof LarkApiError ? { http_status: error.httpStatus, endpoint: error.endpoint } : {}),
        duration_ms: duration(),
      });
      return {
        httpStatus: 200,
        body: toast('error', validation ? (error.userMessage || error.message) : '派单失败，请稍后重试或联系值班同学'),
        errorCode: code,
      };
    }
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
    return {
      httpStatus: 200,
      body: toast('error', '派单失败，请稍后重试或联系值班同学'),
      errorCode: code,
    };
  } finally {
    inFlight.delete(fields.requestId);
  }
}
