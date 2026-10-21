const CONFIRMED_STATUSES = new Set(['QUEUED', 'RETRY', 'PROCESSING', 'SENT', 'DEAD']);
const UNRESOLVED_STATUSES = new Set(['HANDOFF_PENDING', 'ACCEPTED_UNKNOWN']);

function text(value) { return String(value || ''); }

export function handoffEvidence(handoff = {}) {
  const context = handoff.context || {};
  return {
    operation_id: text(context.operationId),
    fingerprint: text(context.fingerprint),
    registered_at: text(context.registeredAt),
    publish_claimed_at: text(context.publishClaimedAt),
    publish_lease_expires_at: text(context.publishLeaseExpiresAt),
    confirmed_at: text(context.confirmedAt),
    last_reconcile_at: text(context.lastReconcileAt),
    error_code: text(context.errorCode),
    queue_rejection_error: text(context.queueRejectionError),
    authoritative_non_acceptance: context.authoritativeNonAcceptance === true,
    reconcile_attempt: Math.max(0, Number(context.reconcileAttempt || 0)),
  };
}

export function classifyDispatchHandoff(handoff = {}, observedStatus = {}) {
  const context = handoff.context || {};
  const persistedStatus = text(context.status || observedStatus.status).toUpperCase() || 'UNKNOWN';
  const operationId = text(context.operationId);
  const observedOperationId = text(observedStatus.operation_id || operationId);
  const identityMatches = Boolean(operationId) && observedOperationId === operationId;
  const message = context.queueMessage;
  const evidenceValid = Boolean(
    identityMatches
    && text(context.fingerprint)
    && context.card && typeof context.card === 'object'
    && message && typeof message === 'object'
    && text(message.chat_id) === text(handoff.chatId)
    && text(message.batch_id) === text(context.batchId)
    && text(message.operation_id) === operationId
    && text(message.fingerprint) === text(context.fingerprint)
  );

  let classification = 'NEEDS_RECONCILIATION';
  let reason = 'AMBIGUOUS_QUEUE_ACCEPTANCE';
  if (CONFIRMED_STATUSES.has(persistedStatus) && identityMatches) {
    classification = 'CONFIRMED';
    reason = `AUTHORITATIVE_${persistedStatus}`;
  } else if (!UNRESOLVED_STATUSES.has(persistedStatus)) {
    reason = 'UNSUPPORTED_OR_INVALID_STATE';
  } else if (!evidenceValid) {
    reason = 'REPLAY_EVIDENCE_INVALID';
  } else if (persistedStatus === 'HANDOFF_PENDING'
    && !context.publishClaimedAt && !context.publishWorkerToken && !context.publishLeaseExpiresAt) {
    classification = 'SAFE_TO_RETRY';
    reason = 'NO_PUBLISH_ATTEMPT_RECORDED';
  } else if (context.authoritativeNonAcceptance === true) {
    classification = 'SAFE_TO_RETRY';
    reason = 'AUTHORITATIVE_NON_ACCEPTANCE';
  }

  return {
    classification,
    reason,
    status: persistedStatus,
    operation_id: operationId,
    batch_id: text(context.batchId),
    publish_allowed: classification === 'SAFE_TO_RETRY',
    evidence: handoffEvidence(handoff),
  };
}
