export const ANCHOR_RECOVERY = Object.freeze({
  NO_HISTORY_CONFIRMED: 'NO_HISTORY_CONFIRMED',
  ANCHOR_FOUND: 'ANCHOR_FOUND',
  SCAN_INCOMPLETE: 'SCAN_INCOMPLETE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  SCOPE_AMBIGUOUS: 'SCOPE_AMBIGUOUS',
  ROSTER_INCOMPATIBLE: 'ROSTER_INCOMPATIBLE',
  EVIDENCE_CONFLICT: 'EVIDENCE_CONFLICT',
});

const AD_REVIEW_SCOPES = new Set(['ad_review', 'ad_review_a', 'ad_review_b', 'ad_review_c']);

/** Normalize only explicitly declared rotation scopes. Never infer AD by substring. */
export function canonicalRotationScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  if (AD_REVIEW_SCOPES.has(scope)) return 'ad_review';
  if (scope === 'ad_game') return 'ad_game';
  if (['default', 'test_default'].includes(scope)) return scope;
  return '';
}

export function rotationScopesMatch(left, right) {
  const a = canonicalRotationScope(left);
  const b = canonicalRotationScope(right);
  return Boolean(a && b && a === b);
}

function normalizedRoster(roster) {
  return Array.isArray(roster) ? roster.map((name) => String(name || '').trim()).filter(Boolean) : [];
}

/**
 * Decide a recovery result from a complete, request-id-addressed sheet scan and
 * the durable ledger. rowIndex is deliberately not part of identity.
 */
export function decideSafeAnchor({
  requestId, rotationScope, roster, sheetRows = [], ledger = [], scanComplete = false,
}) {
  if (!scanComplete) return { status: ANCHOR_RECOVERY.SCAN_INCOMPLETE };
  const scope = canonicalRotationScope(rotationScope);
  if (!scope) return { status: ANCHOR_RECOVERY.SCOPE_AMBIGUOUS };
  const names = normalizedRoster(roster);
  if (!names.length || new Set(names).size !== names.length) {
    return { status: ANCHOR_RECOVERY.ROSTER_INCOMPATIBLE };
  }
  const targetId = String(requestId || '').trim();
  const matchingTargets = sheetRows.filter((row) => String(row?.requestId || '').trim() === targetId);
  if (matchingTargets.length !== 1) return { status: ANCHOR_RECOVERY.TARGET_NOT_FOUND };
  const target = matchingTargets[0];
  const targetPosition = Number(target.position);
  if (!Number.isFinite(targetPosition)) return { status: ANCHOR_RECOVERY.SCAN_INCOMPLETE };

  const scopedSheet = sheetRows.filter((row) => rotationScopesMatch(row?.rotationScope, scope)
    && Number(row?.position) < targetPosition && String(row?.assignee || '').trim());
  const latestSheet = scopedSheet.sort((a, b) => Number(b.position) - Number(a.position))[0];
  const scopedLedger = ledger.filter((row) => rotationScopesMatch(row?.rotationScope || row?.scope, scope));
  const latestLedger = scopedLedger.sort((a, b) => Number(b.assignmentSeq || b.assignment_seq || 0)
    - Number(a.assignmentSeq || a.assignment_seq || 0))[0];

  for (const evidence of [latestSheet, latestLedger]) {
    if (evidence && !names.includes(String(evidence.assignee || '').trim())) {
      return { status: ANCHOR_RECOVERY.ROSTER_INCOMPATIBLE };
    }
  }
  if (latestSheet && latestLedger) {
    const sheetSeq = Number(latestSheet.assignmentSeq || latestSheet.assignment_seq || 0);
    const ledgerSeq = Number(latestLedger.assignmentSeq || latestLedger.assignment_seq || 0);
    if (sheetSeq && ledgerSeq && sheetSeq === ledgerSeq
      && String(latestSheet.assignee).trim() !== String(latestLedger.assignee).trim()) {
      return { status: ANCHOR_RECOVERY.EVIDENCE_CONFLICT };
    }
    // A sheet without a trustworthy sequence/revision can never roll back the ledger.
    if (!sheetSeq || ledgerSeq > sheetSeq) {
      return { status: ANCHOR_RECOVERY.ANCHOR_FOUND, anchor: latestLedger.assignee,
        source: 'ledger', targetRowIndex: target.rowIndex };
    }
  }
  const latest = latestSheet || latestLedger;
  if (latest) return { status: ANCHOR_RECOVERY.ANCHOR_FOUND, anchor: latest.assignee,
    source: latest === latestSheet ? 'sheet' : 'ledger', targetRowIndex: target.rowIndex };
  return { status: ANCHOR_RECOVERY.NO_HISTORY_CONFIRMED, targetRowIndex: target.rowIndex };
}

export function assertSafeRecovery(result) {
  if ([ANCHOR_RECOVERY.ANCHOR_FOUND, ANCHOR_RECOVERY.NO_HISTORY_CONFIRMED].includes(result?.status)) return result;
  const error = new Error(`安全锚点恢复失败：${result?.status || 'UNKNOWN'}`);
  error.code = result?.status || 'SCAN_INCOMPLETE';
  throw error;
}
