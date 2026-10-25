# Batch cursor snapshot repair (2026-10-25)

## Failure addressed

The sequential batch fallback cached a complete `readTargetAndAnchor` observation
for each item before executing the batch. An earlier item could calibrate a manual
assignee, advance the directional CAS version, and leave later cached observations
stale. The next calibration then rejected the batch's own previous update. One
batch-wide retry repeated the pattern and marked the remaining suffix failed.

The production example was batch `game-bess-a-2e9a674861eb41eeef0bf1ca`: seven
previously successful items advanced to nine, followed by four
`CURSOR_CALIBRATION_CONFLICT` results. Those successes recognized existing sheet
assignees; they were not nine new automatic assignments.

## Repair

- Compare a cached item's roster/cursor decision stamp with the current daily
  state before consuming it. Include all three directional versions, roster
  revision, assignment sequence, roster and off-duty state.
- When the stamp changes, re-read the complete target, anchor and durable ledger.
  Do **not** attach a newer CAS version to an older anchor.
- Use the same fresh observation for the assignee roster, expected roster version
  and expected directional version, including the ordinary assignment path after
  a cached observation has been discarded.
- Reuse the coordinator's existing `decisionRefreshed` handling to invalidate the
  remaining pre-reads. Actual conflicts still trigger at most one batch-wide retry.
- Refresh the roster used by retry preflight rather than passing an unused
  argument to `readPendingTargets`.
- Retain the database CAS, manual-cell protection, replay/claim contracts and batch
  fingerprint. Add a non-sensitive `batch_snapshot_refreshed` event and a specific
  conflict message instead of the generic failure text.

## Regression evidence

New tests use `createMemoryBatchStore`'s real version checks, monotonic cursors and
atomic calibration/assignment model, with a coherent snapshot exposing its durable
assignment facts. External sheet/message APIs are test doubles, not real resources.
The old lightweight fixture's calibration method does not enforce CAS, which is why
existing tests alone could miss this bug.

The initial eight-test red phase failed seven cases before the implementation
change, including the production-shaped seven-success/six-failure recovery.

Fourteen regression cases cover:

- forward, reverse and emergency-forward: thirteen consecutive pre-filled targets;
- those same three directions: alternating manual and empty targets;
- those same three directions: automatic assignment followed by a manual anchor;
- same-batch recovery from seven successful and six failed entries;
- preservation of one batch read, assignment and write for a fresh all-empty batch;
- an actual version change after observation: reject the old CAS, then re-read;
- a changed manual anchor with an unchanged next target cell: re-observe the
  anchor, not merely replace its version;
- persistent concurrent updates: bounded failure and zero sheet writes.

Pre-filled targets are never automatically written. Repeating a fully completed
batch does not recalibrate or create another assignment.

Final local verification:

- full test suite: 897 passed, zero failed or skipped;
- batch dispatch tests: 87 passed;
- ESLint, Vite build and `git diff --check` passed.

## Release boundaries

This is an application-only change. No SQL migration, database permission change,
environment variable or Skill update is required. The previous status-form repair
is retained. Reverting this application commit is the rollback path.

Local tests do not constitute a real Supabase/Lark end-to-end acceptance. The
Sheets GET-to-PUT atomicity limitation is unchanged; this repair does not claim
absolute protection against arbitrary direct human edits in that window.

No production data, roster, cursor or original failed batch was modified during
implementation. Do not automatically replay the production batch. After an
authorized release, read its current sheet/ledger facts and obtain authorization
before recovering unfinished items under the original batch identity.
