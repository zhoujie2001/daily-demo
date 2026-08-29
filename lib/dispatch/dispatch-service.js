// Business orchestration for BESS auto-dispatch card actions (P0 scope):
// validate -> create thread via reply -> build the updated original card and
// return it in the callback response for an immediate update within Feishu's
// three-second card callback deadline.
//
// P0 deliberately does NOT write sheets/Bitable or resolve the assignee
// roster; those arrive in P1. This module never logs tokens or secrets and
// always returns a callback response body (toast) for business errors so the
// Feishu client shows an understandable message instead of a generic failure.

import { LarkApiError } from '../lark/client.js';
import {
  parseCardActionEvent,
  validateDispatchValue,
  parseAllowedChatIds,
  isFeatureEnabled,
  DispatchValidationError,
} from '../lark/card-actions.js';
import {
  patchCardForDispatched,
  buildDispatchedCard,
  buildDispatchThreadText,
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

// Returns { httpStatus, body, errorCode? }. Business outcomes always use
// HTTP 200 with an error toast (non-2xx makes the Feishu client show a
// generic interaction error); protocol-level rejection stays in callback.js.
export async function handleDispatchEvent(body, {
  client,
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
  const logBase = { event_id: event.eventId };

  // Card actions without a dispatch value are acknowledged with no side
  // effects (e.g. future unrelated buttons on the same card).
  if (!event.value) {
    return { httpStatus: 200, body: {} };
  }

  let fields;
  try {
    fields = validateDispatchValue(event.value);
  } catch (error) {
    if (error instanceof DispatchValidationError) {
      log('rejected', { ...logBase, error_code: error.code, duration_ms: duration() });
      return { httpStatus: 200, body: toast('error', error.userMessage), errorCode: error.code };
    }
    throw error;
  }

  Object.assign(logBase, {
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

    if (!updatedCard) {
      updatedCard = buildDispatchedCard(fields, { dispatchedAt });
    }
    responseBody.card = { type: 'raw', data: updatedCard };

    // For card.action.trigger, returning response.card is the documented
    // immediate-update mechanism. Do not add a second OpenAPI PATCH to this
    // critical path: waiting for it can push the callback past Feishu's
    // three-second deadline (client error 200341), even when the thread reply
    // itself has already succeeded.
    completed.add(fields.requestId);
    log('succeeded', {
      ...logBase,
      card_response_included: true,
      card_update_mode: 'callback_response',
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
