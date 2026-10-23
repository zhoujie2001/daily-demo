import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';
import {
  ANCHOR_RECOVERY, canonicalRotationScope, decideSafeAnchor, rotationScopesMatch,
} from '../lib/dispatch/safe-anchor.js';

const roster = ['甲', '乙', '丙'];
const target = { requestId: 'target', rowIndex: 99, position: 4, rotationScope: 'ad_review_c' };

test('AD review A/B/C 明确共池，ad_game 隔离，包含 AD 的未知字符串不匹配', () => {
  assert.equal(canonicalRotationScope('ad_review_a'), 'ad_review');
  assert.equal(rotationScopesMatch('ad_review_a', 'ad_review_c'), true);
  assert.equal(rotationScopesMatch('ad_review_b', 'ad_game'), false);
  assert.equal(rotationScopesMatch('not_ad_review', 'ad_review'), false);
});

test('目标按 request_id 重定位，rowIndex 变化仅作为返回提示', () => {
  const result = decideSafeAnchor({ requestId: 'target', rotationScope: 'ad_review', roster,
    scanComplete: true, sheetRows: [
      { requestId: 'old', position: 1, rowIndex: 10, rotationScope: 'ad_review_a', assignee: '甲' },
      target,
    ] });
  assert.deepEqual(result, { status: ANCHOR_RECOVERY.ANCHOR_FOUND, anchor: '甲', source: 'sheet', targetRowIndex: 99 });
});

test('较旧或无 revision 的表格证据不得回退较新账本', () => {
  const result = decideSafeAnchor({ requestId: 'target', rotationScope: 'ad_review', roster,
    scanComplete: true, sheetRows: [
      { requestId: 'old', position: 1, rotationScope: 'ad_review_b', assignee: '甲' }, target,
    ], ledger: [{ scope: 'ad_review', assignee: '丙', assignmentSeq: 8 }] });
  assert.equal(result.status, ANCHOR_RECOVERY.ANCHOR_FOUND);
  assert.equal(result.anchor, '丙');
  assert.equal(result.source, 'ledger');
});

test('扫描不完整、目标找不到、scope 模糊、roster 不兼容、证据冲突均阻断', () => {
  assert.equal(decideSafeAnchor({ scanComplete: false }).status, ANCHOR_RECOVERY.SCAN_INCOMPLETE);
  assert.equal(decideSafeAnchor({ requestId: 'missing', rotationScope: 'ad_review', roster, scanComplete: true }).status,
    ANCHOR_RECOVERY.TARGET_NOT_FOUND);
  assert.equal(decideSafeAnchor({ requestId: 'target', rotationScope: 'contains_ad', roster, scanComplete: true,
    sheetRows: [target] }).status, ANCHOR_RECOVERY.SCOPE_AMBIGUOUS);
  assert.equal(decideSafeAnchor({ requestId: 'target', rotationScope: 'ad_review', roster: ['甲', '甲'],
    scanComplete: true, sheetRows: [target] }).status, ANCHOR_RECOVERY.ROSTER_INCOMPATIBLE);
  assert.equal(decideSafeAnchor({ requestId: 'target', rotationScope: 'ad_review', roster, scanComplete: true,
    sheetRows: [{ requestId: 'old', position: 1, rotationScope: 'ad_review', assignee: '甲', assignmentSeq: 7 }, target],
    ledger: [{ scope: 'ad_review', assignee: '乙', assignmentSeq: 7 }] }).status, ANCHOR_RECOVERY.EVIDENCE_CONFLICT);
});

test('完整扫描确认无历史时返回 NO_HISTORY_CONFIRMED，而不是把 cursor=0 当证据', () => {
  assert.deepEqual(decideSafeAnchor({ requestId: 'target', rotationScope: 'ad_game', roster,
    scanComplete: true, sheetRows: [{ ...target, rotationScope: 'ad_game' }] }),
  { status: ANCHOR_RECOVERY.NO_HISTORY_CONFIRMED, targetRowIndex: 99 });
});


test('校准与分配共用原子入口：CAS 冲突不占位，成功重放不重复推进', async () => {
  const store = createMemoryBatchStore();
  await store.initializeRoster({ dayKey: '2026-10-23', roster, expiresAt: '2026-10-24T16:00:00Z' });
  await assert.rejects(store.calibrateAndAssign({ dayKey: '2026-10-23', requestId: 'r1', direction: 'forward',
    assignee: '乙', roster, expectedVersion: 1, expectedCursorVersion: 99 }),
  (error) => error.code === 'CURSOR_CALIBRATION_CONFLICT');
  assert.equal((await store.getDailyState('2026-10-23')).forward_cursor, 0);
  const first = await store.calibrateAndAssign({ dayKey: '2026-10-23', requestId: 'r1', direction: 'forward',
    assignee: '乙', roster, expectedVersion: 1, expectedCursorVersion: 1, context: {} });
  assert.equal(first.assignee, '丙');
  const cursor = (await store.getDailyState('2026-10-23')).forward_cursor;
  const replay = await store.calibrateAndAssign({ dayKey: '2026-10-23', requestId: 'r1', direction: 'forward',
    assignee: '甲', roster, expectedVersion: 999, expectedCursorVersion: 999, context: {} });
  assert.equal(replay.assignee, '丙');
  assert.equal((await store.getDailyState('2026-10-23')).forward_cursor, cursor);
});

test('生产迁移提供单 RPC 事务，并在 request 锁后先处理幂等重放', () => {
  const sql = readFileSync(new URL('../db/migrations/20261023_safe_anchor_recovery.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.bess_calibrate_and_assign_next/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*select assignment\.\*[\s\S]*if found/i);
  assert.match(sql, /bess_calibrate_cursor[\s\S]*bess_assign_next/i);
  assert.match(sql, /revoke all[\s\S]*grant execute[\s\S]*service_role/i);
});
