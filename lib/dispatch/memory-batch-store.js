// In-memory implementation of the durable batch-lock contract. Intended for
// local tests only; production must use the Supabase-backed implementation.
import { createQianchuanMemoryStore } from './qianchuan-memory.js';
function directionFields(direction) {
  if (direction === 'forward') return { cursor: 'forward_cursor', version: 'forward_version', reverse: false };
  if (direction === 'emergency_forward') return { cursor: 'emergency_forward_cursor', version: 'emergency_forward_version', reverse: false };
  if (direction === 'reverse') return { cursor: 'reverse_cursor', version: 'reverse_version', reverse: true };
  const error = new Error('INVALID_DIRECTION');
  error.code = 'INVALID_DIRECTION';
  throw error;
}

function assignmentVersions(state) {
  return {
    version: state.version,
    forward_version: state.forward_version,
    reverse_version: state.reverse_version,
    emergency_forward_version: state.emergency_forward_version,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function liftCursor(cursor, residue, count) {
  const current = Number(cursor || 0);
  const currentResidue = current % count;
  return current + ((residue - currentResidue + count) % count);
}

function assertReplayContextCompatible(existingContext = {}, nextContext = {}) {
  for (const field of ['sheetId', 'targetCategory']) {
    const existing = String(existingContext?.[field] || '').trim();
    const incoming = String(nextContext?.[field] || '').trim();
    if (existing && incoming && existing !== incoming) {
      const error = new Error(`IDEMPOTENCY_CONTEXT_MISMATCH:${field}`);
      error.code = 'IDEMPOTENCY_CONTEXT_MISMATCH';
      throw error;
    }
  }
}

export function createMemoryBatchStore({ now = () => new Date() } = {}) {
  const batches = new Map();
  const dailyStates = new Map();
  const pendingForms = new Map();
  const confirmationOperations = new Map();
  const keyFor = (chatId, batchId) => `${chatId}:${batchId}`;
  const stateKeyFor = (dayKey, scope = 'default') => `${dayKey}:${scope}`;

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
    ...createQianchuanMemoryStore({
      getState: (day, scope) => dailyStates.get(stateKeyFor(day, scope)),
      putState: (day, scope, state) => dailyStates.set(stateKeyFor(day, scope), state),
      assertClaim: (args) => {
        const claim = owned(args);
        if (claim.status !== 'PROCESSING' || new Date(claim.lease_expires_at) <= now()) {
          throw Object.assign(new Error('BATCH_CLAIM_LOST'), { code: 'BATCH_CLAIM_LOST' });
        }
        return claim;
      },
    }),
    async cleanupExpired() {
      // Mock cleanup: not needed for tests
    },
    async getDailyState(dayKey, scope = 'default') {
      return clone(dailyStates.get(stateKeyFor(dayKey, scope)) || null);
    },
    async getAssignment() {
      // Mock implementation: minimal if needed for tests
      return null;
    },
    async getDailyAssignments() {
      return [];
    },
    async savePending(pending) {
      pendingForms.set(pending.form_message_id, clone({ ...pending, completed_at: pending.completed_at || null }));
      return clone(pendingForms.get(pending.form_message_id));
    },
    async getPending(formMessageId, current = now(), { includeCompleted = false } = {}) {
      const pending = pendingForms.get(formMessageId);
      if (!pending) return null;
      if (new Date(pending.expires_at) <= current) return null;
      if (!includeCompleted && pending.completed_at) return null;
      return clone(pending);
    },
    async getPendingByRequest(requestId, chatId, current = now()) {
      for (const pending of pendingForms.values()) {
        if (pending.request_id === requestId && pending.chat_id === chatId
          && !pending.completed_at && new Date(pending.expires_at) > current) return clone(pending);
      }
      return null;
    },
    async markPendingCompleted(formMessageId, completedAt = now(), requestContext = undefined) {
      const pending = pendingForms.get(formMessageId);
      if (!pending) return null;
      pending.completed_at = completedAt.toISOString();
      if (requestContext !== undefined) pending.request_context = clone(requestContext);
      return clone(pending);
    },
    async calibrateCursor({ dayKey, scope = 'default', direction, assignee, roster, expectedVersion, expectedCursorVersion }) {
      const state = dailyStates.get(stateKeyFor(dayKey, scope));
      if (!state) throw new Error('DAILY_STATE_NOT_FOUND');
      const { version: versionField, cursor: cursorField, reverse } = directionFields(direction);
      if (expectedVersion !== undefined && Number(state.version) !== Number(expectedVersion)) {
        const error = new Error('CAS_ROSTER_VERSION_MISMATCH');
        error.code = 'CURSOR_CALIBRATION_CONFLICT';
        throw error;
      }
      if (expectedCursorVersion !== undefined && Number(state[versionField]) !== Number(expectedCursorVersion)) {
        const error = new Error('CAS_DIRECTION_VERSION_MISMATCH');
        error.code = 'CURSOR_CALIBRATION_CONFLICT';
        throw error;
      }
      if (JSON.stringify(state.roster) !== JSON.stringify(roster)) {
        const error = new Error('ROSTER_CHANGED');
        error.code = 'ROSTER_CHANGED';
        throw error;
      }
      const index = roster.indexOf(assignee);
      if (index < 0) throw new Error('ASSIGNEE_NOT_IN_ROSTER');
      const count = roster.length;
      const residue = reverse ? (count - index) % count : (index + 1) % count;
      state[cursorField] = liftCursor(state[cursorField], residue, count);
      state[versionField] += 1;
      state.updated_at = now().toISOString();
      return clone(state);
    },
    async calibrateAndAssign(args) {
      const key = stateKeyFor(args.dayKey, args.scope);
      const before = clone(dailyStates.get(key));
      if (!before) throw new Error('DAILY_STATE_NOT_FOUND');
      if (before.assignments?.[args.requestId]) return this.assign(args);
      try {
        await this.calibrateCursor(args);
        const calibrated = dailyStates.get(key);
        const versionField = directionFields(args.direction).version;
        return await this.assign({
          ...args,
          expectedVersion: calibrated.version,
          expectedCursorVersion: calibrated[versionField],
        });
      } catch (error) {
        dailyStates.set(key, before);
        throw error;
      }
    },
    async updateRosterStatus({ dayKey, scope = 'default', offDuty, expectedVersion }) {
      const state = dailyStates.get(stateKeyFor(dayKey, scope));
      if (!state) throw new Error('DAILY_STATE_NOT_FOUND');
      if (Number(state.version || 1) !== Number(expectedVersion)) {
        const error = new Error('人员状态已被并发更新');
        error.code = 'STATUS_UPDATE_CONFLICT';
        throw error;
      }
      state.off_duty = clone(offDuty);
      state.version = (state.version || 1) + 1;
      state.forward_version = (state.forward_version || 1) + 1;
      state.reverse_version = (state.reverse_version || 1) + 1;
      state.emergency_forward_version = (state.emergency_forward_version || 1) + 1;
      state.updated_at = now().toISOString();
      return clone(state);
    },
    async updateAdRosterStatuses({ dayKey, updates, confirmationOperationId, submissionHash, confirmedBy }) {
      const operationKey = confirmationOperationId;
      const previous = confirmationOperations.get(operationKey);
      if (previous) {
        if (previous.submission_hash !== submissionHash) {
          const error = new Error('CONFIRMATION_OPERATION_MISMATCH');
          error.code = 'CONFIRMATION_OPERATION_MISMATCH';
          throw error;
        }
        return clone({ ...previous.result, replayed: true });
      }
      const states = updates.map((update) => dailyStates.get(stateKeyFor(dayKey, update.scope)));
      if (states.some((state, index) => !state
        || Number(state.version) !== Number(updates[index].expectedVersion)
        || Number(state.roster_revision) !== Number(updates[index].expectedRosterRevision))) {
        const error = new Error('AD_STATUS_UPDATE_CONFLICT');
        error.code = 'STATUS_UPDATE_CONFLICT';
        throw error;
      }
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        const update = updates[index];
        if (update.offDuty.some((name) => !state.roster.includes(name))) {
          const error = new Error('off-duty person is not in roster');
          error.code = 'INVALID_STATUS_UPDATE';
          throw error;
        }
      }
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        state.off_duty = clone(updates[index].offDuty);
        state.status_confirmed = true;
        state.confirmed_roster_revision = state.roster_revision;
        state.status_confirmed_at = now().toISOString();
        state.status_confirmed_by = confirmedBy;
        state.version += 1;
        state.forward_version += 1;
        state.reverse_version += 1;
        state.emergency_forward_version += 1;
        state.updated_at = now().toISOString();
      }
      const result = { states: states.map(clone), replayed: false };
      confirmationOperations.set(operationKey, { submission_hash: submissionHash, result: clone(result) });
      return result;
    },
    async initializeRoster({ dayKey, scope = 'default', roster, expiresAt }) {
      const scopes = ['ad_review', 'ad_game', 'ad_emergency'].includes(scope)
        ? ['ad_review', 'ad_game', 'ad_emergency'] : [scope];
      const existingAd = scopes.length === 3
        ? scopes.map((item) => dailyStates.get(stateKeyFor(dayKey, item))).filter(Boolean)
        : [];
      if (existingAd.some((state) => JSON.stringify(state.roster) !== JSON.stringify(roster))) {
        const error = new Error('AD 双名单与提交顺序不一致');
        error.code = 'ROSTER_CHANGED';
        throw error;
      }
      for (const targetScope of scopes) {
        const key = stateKeyFor(dayKey, targetScope);
        if (!dailyStates.has(key)) {
          dailyStates.set(key, {
            day_key: dayKey,
            scope: targetScope,
            roster: clone(roster),
            forward_cursor: 0,
            reverse_cursor: 0,
            emergency_forward_cursor: 0,
            off_duty: [],
            version: 1,
            forward_version: 1,
            reverse_version: 1,
            emergency_forward_version: 1,
            roster_revision: 1,
            status_confirmed: true,
            confirmed_roster_revision: 1,
            status_confirmed_at: null,
            status_confirmed_by: null,
            assignment_seq: 0,
            expires_at: expiresAt,
          });
        }
      }
      return clone(dailyStates.get(stateKeyFor(dayKey, scope)));
    },
    async replaceAdRosters({ dayKey, roster, expectedReviewVersion, expectedGameVersion, expectedEmergencyVersion }) {
      const review = dailyStates.get(stateKeyFor(dayKey, 'ad_review'));
      const game = dailyStates.get(stateKeyFor(dayKey, 'ad_game'));
      const emergency = dailyStates.get(stateKeyFor(dayKey, 'ad_emergency'));
      if (!review || !game || !emergency
          || review.version !== expectedReviewVersion || game.version !== expectedGameVersion
          || emergency.version !== expectedEmergencyVersion) {
        const error = new Error('AD 三份名单更新冲突');
        error.code = 'AD_ROSTER_UPDATE_CONFLICT';
        throw error;
      }
      for (const state of [review, game, emergency]) {
        state.roster = clone(roster);
        state.off_duty = state.off_duty.filter((name) => roster.includes(name));
        state.version += 1;
        state.forward_version += 1;
        state.reverse_version += 1;
        state.emergency_forward_version += 1;
        state.roster_revision = (state.roster_revision || 1) + 1;
        state.status_confirmed = true;
        state.confirmed_roster_revision = state.roster_revision;
        state.updated_at = now().toISOString();
      }
      return [clone(emergency), clone(game), clone(review)];
    },
    async assignSpecific({ dayKey, scope = 'default', requestId, assignee, context }) {
      const state = dailyStates.get(stateKeyFor(dayKey, scope));
      if (!state) throw new Error('DAILY_STATE_NOT_FOUND');
      if (!state.assignments) state.assignments = {};
      const existing = state.assignments[requestId];
      if (existing) return {
        assignee: existing.assignee, replayed: true, ...assignmentVersions(state),
        assignment_seq: existing.assignment_seq,
      };
      state.assignments[requestId] = {
        assignee, direction: 'specified', context: clone(context || {}), assignment_seq: null,
      };
      return {
        assignee, replayed: false, ...assignmentVersions(state),
        assignment_seq: null,
      };
    },
    async assign({ dayKey, scope = 'default', requestId, direction, roster, expiresAt, context = {}, expectedVersion, expectedCursorVersion }) {
      const results = await this.assignBatch({
        dayKey, scope, requestIds: [requestId], direction, roster, expiresAt, contexts: [context], expectedVersion, expectedCursorVersion,
      });
      return results[0];
    },
    async assignBatch({ dayKey, scope = 'default', requestIds, direction, roster, expiresAt, contexts = [], expectedVersion, expectedCursorVersion }) {
      const stateKey = stateKeyFor(dayKey, scope);
      let state = dailyStates.get(stateKey);
      if (!state && roster) {
        state = {
          day_key: dayKey, scope, roster: clone(roster), forward_cursor: 0, reverse_cursor: 0,
          emergency_forward_cursor: 0, off_duty: [], version: 1,
          forward_version: 1, reverse_version: 1, emergency_forward_version: 1,
          roster_revision: 1, status_confirmed: true,
          confirmed_roster_revision: 1,
          assignment_seq: 0, expires_at: expiresAt,
        };
        dailyStates.set(stateKey, state);
      }

      const replayIndices = [];
      const anyNew = requestIds.some((id, idx) => {
        const isReplay = state && state.assignments && state.assignments[id];
        if (isReplay) {
          assertReplayContextCompatible(state.assignments[id].context, contexts[idx]);
          replayIndices.push(idx);
        }
        return !isReplay;
      });

      if (anyNew && !state) throw new Error('DAILY_STATE_NOT_FOUND');
      if (!state) throw new Error('DAILY_STATE_NOT_FOUND');

      const { version: versionField, cursor: cursorField, reverse } = directionFields(direction);
      if (anyNew) {
        if (expectedVersion !== undefined && Number(state.version) !== Number(expectedVersion)) {
          const error = new Error('CAS_ROSTER_VERSION_MISMATCH');
          error.code = 'ASSIGNMENT_CONFLICT';
          throw error;
        }
        if (expectedCursorVersion !== undefined && Number(state[versionField]) !== Number(expectedCursorVersion)) {
          const error = new Error('CAS_DIRECTION_VERSION_MISMATCH');
          error.code = 'ASSIGNMENT_CONFLICT';
          throw error;
        }
      }

      if (!state.assignments) state.assignments = {};
      const batchResults = [];
      const names = state.roster;
      const off = state.off_duty || [];
      const count = names.length;
      let currentCursor = Number(state[cursorField] || 0);

      for (let j = 0; j < requestIds.length; j += 1) {
        const requestId = requestIds[j];
        const context = contexts[j] || {};

        if (replayIndices.includes(j)) {
          const existing = state.assignments[requestId];
          batchResults.push({
            request_id: requestId, assignee: existing.assignee, roster: clone(names), direction: existing.direction,
            replayed: true, ...assignmentVersions(state), assignment_seq: existing.assignment_seq,
          });
          continue;
        }

        let consumed = 0;
        let idx = reverse
          ? count - 1 - (currentCursor % count)
          : currentCursor % count;
        let assigned = null;
        for (; consumed < count; consumed += 1) {
          const name = names[idx];
          if (!off.includes(name)) { assigned = name; break; }
          idx = reverse ? (idx - 1 + count) % count : (idx + 1) % count;
        }
        if (!assigned) {
          const error = new Error('ALL_OFF_DUTY');
          error.code = 'P0001';
          throw error;
        }

        currentCursor = currentCursor + consumed + 1;
        state.assignment_seq += 1;
        const assignment = {
          request_id: requestId, assignee: assigned, direction, assignment_seq: state.assignment_seq,
          context: clone(context), replayed: false, roster: clone(names),
        };
        state.assignments[requestId] = assignment;
        batchResults.push(assignment);
      }

      if (currentCursor !== Number(state[cursorField] || 0)) {
        state[cursorField] = currentCursor;
        state[versionField] += 1;
        state.updated_at = now().toISOString();
      }

      return batchResults.map((r) => ({
        ...r,
        ...assignmentVersions(state),
      }));
    },
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
          result_message_id: '',
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

    async saveBatchResultMessage({ chatId, batchId, claimToken, messageId }) {
      const row = owned({ chatId, batchId, claimToken });
      row.result_message_id = String(messageId || '').trim();
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
