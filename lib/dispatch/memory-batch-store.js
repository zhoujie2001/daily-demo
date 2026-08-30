// In-memory implementation of the durable batch-lock contract. Intended for
// local tests only; production must use the Supabase-backed implementation.
function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createMemoryBatchStore({ now = () => new Date() } = {}) {
  const batches = new Map();
  const keyFor = (chatId, batchId) => `${chatId}:${batchId}`;

  function owned({ chatId, batchId, claimToken }) {
    const row = batches.get(keyFor(chatId, batchId));
    if (!row || row.claim_token !== claimToken) {
      const error = new Error('批次处理权已失效');
      error.code = 'BATCH_CLAIM_LOST';
      throw error;
    }
    return row;
  }

  return {
    async claimBatch({ chatId, batchId, fingerprint, items, originalMessageId, claimToken, leaseExpiresAt, expiresAt }) {
      const key = keyFor(chatId, batchId);
      let row = batches.get(key);
      if (!row) {
        row = {
          chat_id: chatId,
          batch_id: batchId,
          fingerprint,
          items: clone(items),
          original_message_id: originalMessageId,
          status: 'PROCESSING',
          results: [],
          claim_token: claimToken,
          lease_expires_at: leaseExpiresAt,
          expires_at: expiresAt,
          card_update_done: false,
          thread_reply_done: false,
        };
        batches.set(key, row);
        return { ...clone(row), outcome: 'CLAIMED', batch_status: row.status };
      }
      if (row.fingerprint !== fingerprint) {
        return { ...clone(row), outcome: 'CONFLICT', batch_status: row.status };
      }
      if (row.status === 'SUCCESS' && row.card_update_done && row.thread_reply_done) {
        return { ...clone(row), outcome: 'COMPLETE', batch_status: row.status };
      }
      if (new Date(row.lease_expires_at).getTime() > now().getTime()) {
        return { ...clone(row), outcome: 'IN_FLIGHT', batch_status: row.status };
      }
      row.claim_token = claimToken;
      row.lease_expires_at = leaseExpiresAt;
      row.expires_at = expiresAt;
      return { ...clone(row), outcome: 'RESUMED', batch_status: row.status };
    },

    async saveBatchProgress({ chatId, batchId, claimToken, status, results, leaseExpiresAt }) {
      const row = owned({ chatId, batchId, claimToken });
      row.status = status;
      row.results = clone(results);
      row.lease_expires_at = leaseExpiresAt;
      return clone(row);
    },

    async markBatchFinalization({ chatId, batchId, claimToken, effect, succeeded, errorCode = '' }) {
      const row = owned({ chatId, batchId, claimToken });
      const prefix = effect === 'card' ? 'card_update' : effect === 'thread' ? 'thread_reply' : '';
      if (!prefix) {
        const error = new Error('批次收尾副作用类型无效');
        error.code = 'INVALID_BATCH_EFFECT';
        throw error;
      }
      row[`${prefix}_done`] = Boolean(succeeded);
      row[`${prefix}_error`] = succeeded ? null : String(errorCode || 'UNKNOWN').slice(0, 100);
      return clone(row);
    },

    async releaseBatchClaim({ chatId, batchId, claimToken, releasedAt = now() }) {
      const row = owned({ chatId, batchId, claimToken });
      row.lease_expires_at = releasedAt.toISOString();
      return clone(row);
    },

    // Test/debug helper; callers must not mutate the returned value.
    getBatch(chatId, batchId) {
      return clone(batches.get(keyFor(chatId, batchId)) || null);
    },
  };
}
