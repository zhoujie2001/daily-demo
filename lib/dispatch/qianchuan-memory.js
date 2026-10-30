// Test implementation only. Production uses the atomic PostgreSQL RPCs.
import { stableJson, policyError, assertQianchuanCard } from './qianchuan-policy.js';

export function createQianchuanMemoryStore({ getState, putState, assertClaim }) {
  const sources = new Map();
  const key = (scope, id) => `${scope}:${id}`;
  const copy = (v) => structuredClone(v);
  return {
    async registerQianchuanSource({ scope, dayKey, snapshot }) {
      if (!['default', 'test_default'].includes(scope)) throw policyError('QIANCHUAN_INVALID_MANIFEST');
      const existing = sources.get(key(scope, snapshot.sourceBatchId));
      if (existing && (existing.dayKey !== dayKey || stableJson(existing.snapshot) !== stableJson(snapshot))) {
        throw policyError('QIANCHUAN_SOURCE_CONFLICT');
      }
      if (!existing) sources.set(key(scope, snapshot.sourceBatchId), {
        dayKey, snapshot: copy(snapshot), groupPlan: null, pendingIds: [], confirmedIds: [], writer: null, writeBindings: {},
      });
      return { outcome: existing ? 'REUSED' : 'ACCEPTED' };
    },
    async getQianchuanSource({ scope, sourceBatchId }) {
      return copy(sources.get(key(scope, sourceBatchId)) || null);
    },
    async assignQianchuanBatch(args) {
      const { dayKey, scope, items, observations, anchorAssignee = '', expectedVersion,
        expectedCursorVersion } = args;
      const claim = assertClaim(args);
      assertQianchuanCard(items);
      const sourceKey = key(scope, items[0].sourceBatchId);
      const original = sources.get(sourceKey);
      if (!original || original.dayKey !== dayKey || original.snapshot.snapshotHash !== items[0].decisionManifestHash) {
        throw policyError('QIANCHUAN_SOURCE_CONFLICT');
      }
      const source = copy(original);
      const state = copy(getState(dayKey, scope));
      if (!state || !Array.isArray(state.roster) || !state.roster.length) throw policyError('DAILY_STATE_NOT_FOUND');
      const writer = `${args.chatId}:${args.batchId}`;
      if ((source.pendingIds.length && source.writer !== writer)
          || source.pendingIds.some((id) => !items.some((item) => item.requestId === id))) {
        throw policyError('QIANCHUAN_WRITE_RECONCILIATION_REQUIRED');
      }
      const members = source.snapshot.members;
      if (!Array.isArray(observations) || observations.length !== members.length
          || observations.some((row, i) => row.requestId !== members[i].requestId
            || !Number.isSafeInteger(row.rowIndex) || row.rowIndex < 1 || typeof row.assignee !== 'string')) {
        throw policyError('QIANCHUAN_OBSERVATION_INVALID');
      }
      for (const item of items) {
        const member = members[item.sourcePosition];
        if (!member || ['requestId', 'auditObjectId', 'decisionGroup', 'sheetUrl', 'sheetId', 'assigneeFieldId']
          .some((field) => member[field] !== item[field])
          || stableJson(member.rejectReasonCodes) !== stableJson(item.rejectReasonCodes)
          || item.decisionSnapshotHash !== source.snapshot.upstreamSnapshotHash
          || item.decisionPolicyVersion !== source.snapshot.policyVersion || item.dispatchScope !== scope
          || item.targetCategory !== 'qianchuan' || item.dispatchDirection !== 'forward'
          || !claim.items.some((c) => c.requestId === item.requestId && c.decisionManifestHash === item.decisionManifestHash)) {
          throw policyError('QIANCHUAN_MEMBER_CONFLICT');
        }
      }
      state.assignments ||= {};
      const anyNew = items.some((item) => !state.assignments[item.requestId]);
      if (anyNew && (state.version !== expectedVersion || state.forward_version !== expectedCursorVersion)) {
        throw policyError('ASSIGNMENT_CONFLICT');
      }
      let cursor = Number(state.forward_cursor || 0);
      const count = state.roster.length;
      const manualGroups = new Map();
      members.forEach((member, index) => {
        const manual = observations[index].assignee.trim();
        if (!manual) return;
        if (!state.roster.includes(manual)) throw policyError('ASSIGNEE_NOT_IN_ROSTER');
        if (manualGroups.has(member.assignmentGroup) && manualGroups.get(member.assignmentGroup) !== manual) {
          throw policyError('QIANCHUAN_MANUAL_GROUP_CONFLICT');
        }
        manualGroups.set(member.assignmentGroup, manual);
      });
      if (!source.groupPlan) {
        source.groupPlan = {};
        if (anchorAssignee) {
          const index = state.roster.indexOf(anchorAssignee);
          if (index < 0) throw policyError('ASSIGNEE_NOT_IN_ROSTER');
          cursor += ((index + 1) % count - cursor % count + count) % count;
        }
        for (const member of members) {
          if (source.groupPlan[member.assignmentGroup]) continue;
          const manual = manualGroups.get(member.assignmentGroup);
          let assignee = manual;
          if (manual) {
            const residue = (state.roster.indexOf(manual) + 1) % count;
            cursor += (residue - cursor % count + count) % count;
          } else {
            let steps = 0;
            while (steps < count && (state.off_duty || []).includes(state.roster[cursor % count])) { cursor += 1; steps += 1; }
            if (steps === count) throw policyError('ALL_OFF_DUTY');
            assignee = state.roster[cursor % count]; cursor += 1;
          }
          source.groupPlan[member.assignmentGroup] = { assignee, consumesTurn: !manual };
        }
      }
      for (const member of members) {
        const person = source.groupPlan[member.assignmentGroup].assignee;
        if (!state.roster.includes(person) || (state.off_duty || []).includes(person)) throw policyError('QIANCHUAN_GROUP_ASSIGNEE_UNAVAILABLE');
        if (manualGroups.has(member.assignmentGroup) && manualGroups.get(member.assignmentGroup) !== person) {
          throw policyError('QIANCHUAN_MANUAL_GROUP_CONFLICT');
        }
      }
      const results = items.map((item) => {
        const member = members[item.sourcePosition];
        if (observations[item.sourcePosition].rowIndex !== item.rowIndex) throw policyError('QIANCHUAN_OBSERVATION_INVALID');
        const assignee = source.groupPlan[member.assignmentGroup].assignee;
        const old = state.assignments[item.requestId];
        if (old && (old.assignee !== assignee || old.context?.decisionManifestHash !== item.decisionManifestHash)) {
          throw policyError('QIANCHUAN_MEMBER_CONFLICT');
        }
        if (!old) {
          state.assignment_seq += 1;
          state.assignments[item.requestId] = { assignee, assignment_seq: state.assignment_seq,
            direction: 'forward', context: copy(item) };
        }
        // Mutable attempt target, not a mutation of the frozen decision context.
        source.writeBindings[item.requestId] = { rowIndex: item.rowIndex, claimToken: args.claimToken, writer };
        return { request_id: item.requestId, assignee, replayed: Boolean(old),
          assignment_seq: state.assignments[item.requestId].assignment_seq, assignment_group: member.assignmentGroup };
      });
      if (cursor !== Number(state.forward_cursor || 0)) state.forward_version += 1;
      state.forward_cursor = cursor;
      source.pendingIds = items.filter((item) => !source.confirmedIds.includes(item.requestId)).map((item) => item.requestId);
      source.writer = source.pendingIds.length ? writer : null;
      putState(dayKey, scope, state);
      sources.set(sourceKey, source);
      return results.map((result) => ({ ...result, roster: copy(state.roster), version: state.version,
        forward_version: state.forward_version, reverse_version: state.reverse_version }));
    },
    async confirmQianchuanWrites(args) {
      const claim = assertClaim(args);
      const { scope, sourceBatchId, manifestHash, receipts, dayKey } = args;
      const source = sources.get(key(scope, sourceBatchId));
      const state = getState(dayKey, scope);
      if (!source || source.dayKey !== dayKey || source.snapshot.snapshotHash !== manifestHash
          || (source.pendingIds.length && source.writer !== `${args.chatId}:${args.batchId}`)
          || !receipts.length || new Set(receipts.map((r) => r.requestId)).size !== receipts.length
          || receipts.some((row) => !source.snapshot.members.some((m) => m.requestId === row.requestId)
            || state?.assignments?.[row.requestId]?.assignee !== row.assignee
            || source.writeBindings?.[row.requestId]?.rowIndex !== row.rowIndex
            || source.writeBindings?.[row.requestId]?.claimToken !== args.claimToken
            || source.writeBindings?.[row.requestId]?.writer !== `${args.chatId}:${args.batchId}`
            || state.assignments[row.requestId].context?.decisionManifestHash !== manifestHash
            || !claim.items.some((c) => c.requestId === row.requestId && c.decisionManifestHash === manifestHash))) {
        throw policyError('QIANCHUAN_RECEIPT_CONFLICT');
      }
      source.confirmedIds = [...new Set([...source.confirmedIds, ...receipts.map((r) => r.requestId)])];
      source.pendingIds = source.pendingIds.filter((id) => !source.confirmedIds.includes(id));
      if (!source.pendingIds.length) source.writer = null;
      return { confirmed: true };
    },
  };
}
