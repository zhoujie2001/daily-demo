// The roster versions and the automatic ledger must describe the same decision.
// Production uses one PostgREST embedded SELECT, joined by (day_key, scope).
// Legacy/test stores use bounded optimistic validation instead of mixing reads.
function decisionStamp(state) {
  if (!state) return 'null';
  return JSON.stringify([
    state.version, state.forward_version, state.reverse_version,
    state.forward_cursor, state.reverse_cursor, state.assignment_seq,
    state.roster, state.off_duty,
  ]);
}

export async function readAnchorSnapshot({ store, dayKey, scope, inspect }) {
  if (typeof store.getDispatchSnapshot === 'function') {
    const snapshot = await store.getDispatchSnapshot(dayKey, scope);
    return inspect(snapshot);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await store.getDailyState(dayKey, scope);
    const beforeStamp = decisionStamp(before);
    const assignments = typeof store.getDailyAssignments === 'function'
      ? await store.getDailyAssignments(dayKey, scope) : [];
    const observation = await inspect({ state: before, assignments });
    const after = await store.getDailyState(dayKey, scope);
    if (beforeStamp === decisionStamp(after)) return observation;
  }
  const error = new Error('派单状态持续被并发更新，已停止使用不一致锚点，请重试');
  error.code = 'ASSIGNMENT_CONFLICT';
  throw error;
}
