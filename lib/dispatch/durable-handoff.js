function authoritativeQueueRejection(error) {
  if (error?.accepted_unknown === true) return false;
  if (error?.code === 'QUEUE_REJECTED') return true;
  const status = Number(error?.status || error?.httpStatus || 0);
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function timeoutError() {
  return Object.assign(new Error('Queue publish timed out'), {
    code: 'DISPATCH_QUEUE_TIMEOUT',
    status: 503,
  });
}

/**
 * Durable queue handoff state machine shared by every persistent ingress.
 * Registration is authoritative for conflicts/reuse. Once publish starts, a
 * timeout or confirmation failure is ambiguous acceptance and is never retried
 * by the request path; reconciliation owns the next decision.
 */
export async function runDurableDispatchHandoff({
  store,
  registration,
  publishDispatch,
  publishTimeoutMs = 5_000,
  defer = () => {},
  now = () => new Date(),
}) {
  const {
    chatId, batchId, fingerprint, operationId, card, queueMessage,
  } = registration;
  const handoff = await store.registerDispatchHandoff(registration);

  if (handoff.outcome === 'PAYLOAD_CONFLICT') {
    return { kind: 'CONFLICT', handoff };
  }
  if (['DEAD', 'RECONCILIATION_DEAD'].includes(handoff.status)) {
    return { kind: 'DEAD', handoff };
  }

  let shouldPublish = handoff.outcome === 'ACCEPTED';
  let workerToken = null;
  let publishMessage = handoff.queueMessage || queueMessage;
  if (handoff.status === 'HANDOFF_PENDING' && typeof store.claimDispatchHandoffPublish === 'function') {
    const claim = await store.claimDispatchHandoffPublish({
      chatId, batchId, operationId, fingerprint, card, now: now(),
    });
    shouldPublish = claim.claimed === true;
    if (shouldPublish) {
      workerToken = claim.workerToken;
      publishMessage = claim.queueMessage || publishMessage;
    }
  }

  if (!shouldPublish) return { kind: 'REUSED', handoff };

  const publishPromise = Promise.resolve().then(() => publishDispatch(publishMessage));
  let timer;
  let published;
  try {
    published = await Promise.race([
      publishPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), publishTimeoutMs);
      }),
    ]);
  } catch (error) {
    if (!authoritativeQueueRejection(error)) {
      await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken, now: now() });
      if (error?.code === 'DISPATCH_QUEUE_TIMEOUT') {
        const lateConfirmation = publishPromise
          .then(() => store.confirmDispatchHandoff({
            chatId, batchId, operationId, workerToken, now: now(),
          }))
          .catch(() => {});
        try { defer(lateConfirmation); } catch { /* reconciliation remains authoritative */ }
      }
      return { kind: 'UNKNOWN', handoff, error };
    }

    await store.markDispatchHandoffRejected({
      chatId, batchId, operationId, fingerprint, card, workerToken,
      errorCode: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE', now: now(),
    });
    throw Object.assign(error instanceof Error ? error : new Error('Queue publish failed'), {
      code: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE',
      status: error?.status || 503,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    await store.confirmDispatchHandoff({ chatId, batchId, operationId, workerToken, now: now() });
  } catch (error) {
    await store.markDispatchHandoffUnknown({ chatId, batchId, workerToken, now: now() });
    const delayedConfirmation = Promise.resolve()
      .then(() => store.confirmDispatchHandoff({
        chatId, batchId, operationId, workerToken, now: now(),
      }))
      .catch(() => {});
    try { defer(delayedConfirmation); } catch { /* probe/manual reconciliation retains the evidence */ }
    return { kind: 'UNKNOWN', handoff, published, error };
  }

  return { kind: 'PUBLISHED', handoff, published };
}
