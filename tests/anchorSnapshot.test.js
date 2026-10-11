import assert from 'node:assert/strict';
import test from 'node:test';
import { readAnchorSnapshot } from '../lib/dispatch/anchor-snapshot.js';

test('atomic snapshot does not split the ledger and state into independent reads', async () => {
  const snapshot = { state: { version: 2 }, assignments: [{ assignee: 'B' }] };
  const store = {
    async getDispatchSnapshot(dayKey, scope) {
      assert.equal(dayKey, '2026-10-11');
      assert.equal(scope, 'ad_game');
      return snapshot;
    },
    async getDailyState() { assert.fail('must not split the snapshot'); },
    async getDailyAssignments() { assert.fail('must not split the snapshot'); },
  };
  assert.equal(await readAnchorSnapshot({ store, dayKey: '2026-10-11', scope: 'ad_game',
    inspect: (value) => value }), snapshot);
});

test('legacy snapshot discards a concurrent roster/cursor/ledger observation, including in-place mutations', async () => {
  const state = { version: 1, forward_version: 1, roster: ['A', 'B', 'C'], forward_cursor: 1 };
  let reads = 0;
  const store = {
    async getDailyState() { return state; },
    async getDailyAssignments() {
      reads += 1;
      if (reads === 1) {
        state.forward_version = 3;
        state.forward_cursor = 3;
        state.roster = ['C', 'B', 'A'];
        return [{ assignee: 'A' }];
      }
      return [{ assignee: 'C' }];
    },
  };
  const observed = await readAnchorSnapshot({ store, dayKey: '2026-10-11', scope: 'default',
    inspect: (value) => value });
  assert.equal(reads, 2);
  assert.equal(observed.assignments[0].assignee, 'C');
  assert.deepEqual(observed.state.roster, ['C', 'B', 'A']);
});

test('continuously changing snapshots fail closed after three bounded observations', async () => {
  let version = 0;
  let inspections = 0;
  const store = {
    async getDailyState() { return { version: version += 1 }; },
    async getDailyAssignments() { return []; },
  };
  await assert.rejects(readAnchorSnapshot({ store, dayKey: '2026-10-11', scope: 'default',
    inspect: (snapshot) => { inspections += 1; return snapshot; } }), { code: 'ASSIGNMENT_CONFLICT' });
  assert.equal(inspections, 3);
  assert.equal(version, 6);
});

test('atomic snapshot failures never fall back to inconsistent split reads', async () => {
  const store = {
    async getDispatchSnapshot() { throw new Error('schema cache unavailable'); },
    async getDailyState() { assert.fail('unsafe fallback'); },
  };
  await assert.rejects(readAnchorSnapshot({ store, inspect: (value) => value }), /schema cache unavailable/);
});
