import { dispatchOperationId } from './operation.js';

const UNRESOLVED_STATUSES = Object.freeze(['QUEUED', 'RETRY', 'PROCESSING']);

function clean(value) {
  return String(value || '').trim();
}

export function isUnresolvedDispatchStatus(status) {
  return UNRESOLVED_STATUSES.includes(status?.status);
}

export function isAcceptedQueuedStatus(status, { chatId, batchId } = {}) {
  return status?.accepted === true
    && status.found === false
    && status.status === 'QUEUED'
    && status.transient === true
    && status.operation_id === dispatchOperationId(chatId, batchId);
}

export function toPublicDispatchStatus(status, {
  chatId,
  batchId,
  source,
  httpStatus = 200,
} = {}) {
  const operationId = dispatchOperationId(chatId, batchId);
  const diagnostics = {
    status_source: clean(source) || 'unknown',
    http_status: Number(httpStatus) || 200,
  };

  if (isAcceptedQueuedStatus(status, { chatId, batchId })) {
    return {
      ok: true,
      chat_id: chatId,
      batch_id: batchId,
      ...status,
      status: 'QUEUED',
      transient: true,
      retryable: true,
      retry_after_ms: 2_000,
      source: diagnostics.status_source,
      ...diagnostics,
    };
  }

  if (!status?.found) {
    return {
      ok: true,
      chat_id: chatId,
      batch_id: batchId,
      found: false,
      status: 'NOT_FOUND',
      transient: false,
      retryable: false,
      operation_id: operationId,
      error_code: 'DISPATCH_NOT_FOUND',
      error_detail: 'No durable dispatch ledger row matches chat_id and batch_id.',
      source: diagnostics.status_source,
      ...diagnostics,
    };
  }

  const deadLetter = status.status === 'DEAD';
  const expiredLease = status.status === 'SENDING' && status.retryable === true;
  const unresolved = isUnresolvedDispatchStatus(status);
  const completedAsSkipped = status.status === 'SENT'
    && clean(status.message_id).startsWith('skipped:');
  const publicStatus = expiredLease || deadLetter ? 'FAILED' : unresolved ? 'SENDING' : status.status;
  const publicPayload = completedAsSkipped
    ? Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'message_id'))
    : status;
  const errorCode = clean(status.error_code)
    || (expiredLease ? 'INGEST_LEASE_EXPIRED' : '')
    || (deadLetter ? 'OUTBOX_DELIVERY_FAILED' : '');
  const errorDetail = clean(status.error_detail || status.error_message)
    || (errorCode ? `Dispatch failed with ${errorCode}.` : '');

  return {
    ok: true,
    chat_id: chatId,
    batch_id: batchId,
    ...publicPayload,
    status: publicStatus,
    ...(completedAsSkipped ? {
      skipped: true,
      skip_reason: clean(status.message_id).slice('skipped:'.length),
      skipped_request_ids: status.request_ids || [],
    } : {}),
    ...(errorCode ? { error_code: errorCode, error_detail: errorDetail } : {}),
    ...(deadLetter ? {
      dead_letter: true,
      terminal_reason: errorCode || 'OUTBOX_DELIVERY_FAILED',
    } : {}),
    source: diagnostics.status_source,
    ...diagnostics,
  };
}
