import assert from 'node:assert/strict';
import test from 'node:test';
import { LarkClient } from '../lib/lark/client.js';
import { handleDispatchEvent } from '../lib/dispatch/dispatch-service.js';
import { createMemoryBatchStore } from '../lib/dispatch/memory-batch-store.js';

// Exercise the real Lark adapter and strict-CAS store together. Every external
// endpoint is a local stub; no credentials, live sheet, or network are used.
async function scenario({ count = 20, values = [], direction = 'forward', rowCount = 15013,
  firstRow = 14891, history = true, ad = false, beforeRead, beforeAssign, afterAssign, beforeWrite, responseShape, writeFailure } = {}) {
  const current = new Date('2026-10-25T07:00:00Z');
  const dayKey = '2026-10-25';
  const scope = ad ? 'ad_review' : 'default';
  const requestColumn = ad ? 'C' : 'X';
  const dateColumn = ad ? 'J' : 'H';
  const assigneeColumn = ad ? 'B' : 'J';
  const roster = ['A', 'B', 'C', 'D', 'E'];
  const cells = new Map();
  const cell = (column, row) => cells.get(`${column}${row}`) ?? '';
  const set = (column, row, value) => cells.set(`${column}${row}`, value);
  const project = direction === 'reverse' ? '本地推' : '千川';
  set(requestColumn, 1, '需求ID');
  if (history) {
    set(dateColumn, firstRow - 1, dayKey);
    set(assigneeColumn, firstRow - 1, direction === 'reverse' ? 'A' : 'E');
    if (!ad) set('C', firstRow - 1, project);
  }
  const items = Array.from({ length: count }, (_, index) => {
    const row = firstRow + index;
    set(requestColumn, row, `probe_${index}`);
    set(dateColumn, row, dayKey);
    if (!ad) set('C', row, project);
    set(assigneeColumn, row, values[index] || '');
    return { schema_version: 1, action: 'bess_auto_dispatch', request_id: `probe_${index}`,
      request_name: `test_${index}`, business_type: ad ? 'AD' : project,
      target_category: ad ? 'ad' : direction === 'reverse' ? 'local_promo' : 'qianchuan',
      sheet_url: 'https://example.feishu.cn/wiki/wiki_token', sheet_id: 'sheetA', row_index: row,
      request_field_id: requestColumn, date_field_id: dateColumn, assignee_field_id: assigneeColumn,
      project_field_id: ad ? '' : 'C', project_value: ad ? '' : project };
  });
  const calls = [];
  const client = new LarkClient({ appId: 'test_app', appSecret: 'test_secret',
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      const call = { path: endpoint.pathname, method: options.method,
        ranges: endpoint.searchParams.get('ranges')?.split(','),
        body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      let data;
      if (call.path.endsWith('/tenant_access_token/internal')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'test_token', expire: 7200 }) };
      }
      if (call.path.endsWith('/get_node')) data = { node: { obj_type: 'sheet', obj_token: 'sheet_token' } };
      else if (call.path.endsWith('/sheets/query')) {
        data = { sheets: [{ sheet_id: 'sheetA', grid_properties: { row_count: rowCount, column_count: 24 } }] };
      } else if (call.path.endsWith('/values_batch_get')) {
        await beforeRead?.({ call, calls, cell, set });
        data = { valueRanges: call.ranges.map((range) => {
          const match = range.match(/!([A-Z]+)(\d+):\1(\d+)$/);
          assert.ok(match, range);
          return { range, revision: 1, values: Array.from({ length: Number(match[3]) - Number(match[2]) + 1 },
            (_, offset) => [cell(match[1], Number(match[2]) + offset)]) };
        }) };
        data = responseShape?.({ call, data }) || data;
      } else if (call.path.endsWith('/values_batch_update')) {
        await beforeWrite?.({ call, calls, cell, set });
        for (const entry of call.body.valueRanges) {
          const match = entry.range.match(/!([A-Z]+)(\d+):/);
          set(match[1], Number(match[2]), entry.values[0][0]);
        }
        if (writeFailure) throw new Error('response lost after remote commit');
        data = { responses: call.body.valueRanges.map(({ range }) => ({ updatedRange: range, updatedCells: 1 })) };
      } else if (call.path.includes('/values/')) {
        const range = decodeURIComponent(call.path.split('/values/')[1]);
        const match = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        assert.ok(match, range);
        if (match[1] === match[3]) {
          data = { valueRange: { values: Array.from({ length: Number(match[4]) - Number(match[2]) + 1 },
            (_, offset) => [cell(match[1], Number(match[2]) + offset)]) } };
        } else {
          // Used only by the header-discovery regression.
          data = { valueRange: { values: [Array.from({ length: 24 }, (_, index) => index === 23 ? '需求ID' : '')] } };
        }
      } else throw new Error(`Unexpected endpoint: ${call.path}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
    } });
  client.getMessage = async () => null;
  client.updateMessageCard = async () => {};
  client.replyInteractiveCard = async () => ({ message_id: 'test_result' });
  const store = createMemoryBatchStore({ now: () => current });
  await store.initializeRoster({ dayKey, scope, roster, expiresAt: '2026-10-25T16:00:00Z' });
  const facts = async () => {
    const state = await store.getDailyState(dayKey, scope);
    return Object.entries(state.assignments || {}).map(([id, assignment]) => ({ ...assignment,
      request_id: id, id: assignment.assignment_seq, request_context: assignment.context,
      day_key: dayKey, scope })).sort((a, b) => b.id - a.id);
  };
  let databaseReads = 0;
  store.getDispatchSnapshot = async () => {
    databaseReads += 1;
    return { state: await store.getDailyState(dayKey, scope), assignments: await facts() };
  };
  store.getDailyAssignments = facts;
  store.getAssignment = async (_day, id) => (await facts()).find((row) => row.request_id === id) || null;
  const assignments = [];
  const originalAssign = store.assignBatch.bind(store);
  store.assignBatch = async (args) => {
    assignments.push(structuredClone(args));
    await beforeAssign?.({ args, cell, set, store });
    const result = await originalAssign(args);
    await afterAssign?.({ args, result, cell, set, store });
    return result;
  };
  const logs = [];
  const execute = async (batchId = 'shared_preflight') => {
    const response = await handleDispatchEvent({ header: { event_id: `event_${batchId}` }, event: {
      operator: { open_id: 'test_operator' }, context: { open_chat_id: 'test_chat', open_message_id: 'test_card' },
      action: { tag: 'button', value: { schema_version: 1, action: 'bess_batch_auto_dispatch', batch_id: batchId, items } },
    } }, { store, client, config: { allowedChatIds: 'test_chat' }, now: () => current,
      logger: { info: (line) => logs.push(JSON.parse(line)) } });
    assert.ok(response.afterResponse || ['BATCH_ALREADY_PROCESSED', 'BATCH_IN_FLIGHT'].includes(response.errorCode), JSON.stringify(response.body));
    await response.afterResponse?.();
    return store.getBatch('test_chat', batchId);
  };
  return { client, store, items, cells, cell, set, calls, assignments, facts, execute, logs,
    databaseReads: () => databaseReads, firstRow, dayKey, scope, current };
}

const fullReads = (s) => s.calls.filter((call) => call.ranges?.some((range) => /1:[A-Z]+5000$/.test(range)));
const writes = (s) => s.calls.filter((call) => call.path.endsWith('/values_batch_update'));

test('20 targets on a 15,013-row sheet: one shared complete scan, one CAS batch, one batch write', async () => {
  const s = await scenario();
  const batch = await s.execute();
  assert.equal(batch.status, 'SUCCESS', JSON.stringify(batch.results));
  assert.equal(batch.results.length, 20);
  assert.equal(fullReads(s).length, 1);
  assert.equal(fullReads(s)[0].ranges.length, 16, 'four columns, four chunks, one HTTP request');
  assert.equal(s.assignments.length, 1);
  assert.equal(s.assignments[0].requestIds.length, 20);
  assert.equal(writes(s).length, 1);
  assert.equal(writes(s)[0].body.valueRanges.length, 20);
  assert.equal(s.calls.filter((call) => call.path.endsWith('/get_node')).length, 1, 'reuse the same resolved spreadsheet token through write and verification');
  assert.equal(s.calls.filter((call) => call.path.endsWith('/sheets/query')).length, 1);
  assert.ok(s.databaseReads() <= 3);
  assert.ok(s.logs.some((line) => line.stage === 'batch_preflight' && line.mode === 'shared' && line.target_count === 20));
  const writesBeforeReplay = writes(s).length;
  await s.execute();
  assert.equal(writes(s).length, writesBeforeReplay);
  assert.equal(s.assignments.length, 1);
});

for (const direction of ['forward', 'reverse']) {
  test(`${direction}: split at a filled middle row, preserve it and rotate the next segment from that anchor`, async () => {
    const s = await scenario({ count: 7, direction, values: ['', '', 'D', '', '', '', ''] });
    const result = await s.execute();
    assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
    assert.equal(s.cell('J', s.firstRow + 2), 'D');
    assert.equal(result.results[2].replayed, true);
    assert.equal(writes(s).length, 2);
    assert.deepEqual(s.assignments.map((args) => args.requestIds.length), [2, 4]);
    assert.deepEqual(result.results.map((row) => row.assignee), direction === 'forward'
      ? ['A', 'B', 'D', 'E', 'A', 'B', 'C'] : ['E', 'D', 'D', 'C', 'B', 'A', 'E']);
    assert.equal((await s.facts()).length, 6, 'the prefilled row must not receive an automatic decision');
    assert.equal(fullReads(s).length, 1, 'own cursor commits must not trigger repeated full scans');
  });
}

test('unknown manual assignee blocks the direction before any batch allocation', async () => {
  const s = await scenario({ values: ['', '', 'OUTSIDE'] });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.ok(result.results.every((row) => row.errorCode === 'ASSIGNEE_NOT_IN_ROSTER'));
  assert.equal(s.assignments.length, 0);
  assert.equal(writes(s).length, 0);
});

test('request-id relocation ignores stale card row indexes and rejects duplicates', async () => {
  const s = await scenario({ count: 2 });
  s.items.forEach((item) => { item.row_index = null; });
  assert.equal((await s.execute()).status, 'SUCCESS');
  assert.deepEqual(s.assignments[0].contexts.map((item) => item.rowIndex), [s.firstRow, s.firstRow + 1]);
  const duplicate = await scenario({ count: 2 });
  duplicate.set('X', 50, 'probe_0');
  const result = await duplicate.execute();
  assert.equal(result.results[0].errorCode, 'TARGET_NOT_FOUND');
  assert.equal(duplicate.cell('J', duplicate.firstRow), '');
  assert.ok(!duplicate.assignments.some((args) => args.requestIds.includes('probe_0')));
});

test('manual fill between preflight and execution forces a full refresh before allocation', async () => {
  let injected = false;
  const s = await scenario({ count: 4, beforeRead: ({ call, set }) => {
    if (!injected && call.ranges?.length === 4 && !call.ranges.some((range) => /1:[A-Z]+5000$/.test(range))) {
      injected = true;
      set('J', 14892, 'C');
    }
  } });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.equal(s.cell('J', s.firstRow + 1), 'C');
  assert.deepEqual(result.results.map((row) => row.assignee), ['A', 'C', 'D', 'E']);
  assert.equal(fullReads(s).length, 2);
});

test('manual fill after decision commit: zero batch writes and no subsequent segment allocation', async () => {
  const s = await scenario({ count: 4, afterAssign: ({ set }) => { set('J', 14892, 'MANUAL'); } });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(s.cell('J', s.firstRow + 1), 'MANUAL');
  assert.equal(writes(s).length, 0);
  assert.equal(s.assignments.length, 1);
  assert.equal((await s.facts()).length, 4, 'committed decisions remain auditable');
  assert.ok(result.results.every((row) => row.errorCode === 'SHEET_TARGET_CHANGED'));
});

test('remote write committed but response lost: authoritative readback confirms without a second write', async () => {
  const s = await scenario({ count: 3, writeFailure: true });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.equal(writes(s).length, 1);
  assert.equal(s.assignments.length, 1);
  assert.ok(s.logs.some((line) => line.stage === 'batch_segment_write_reconciled'));
});

for (const shape of ['missing', 'reordered', 'mixed-revision']) {
  test(`shared scan ${shape}: incomplete or incoherent evidence cannot reach assignment`, async () => {
    const s = await scenario({ responseShape: ({ data }) => {
      if (shape === 'missing') data.valueRanges.pop();
      if (shape === 'reordered') data.valueRanges.reverse();
      if (shape === 'mixed-revision') data.valueRanges[0].revision = 2;
      return data;
    } });
    const result = await s.execute();
    assert.equal(result.status, 'FAILED');
    assert.equal(s.assignments.length, 0);
    assert.equal(writes(s).length, 0);
  });
}

test('one header discovery serves all 20 request-id field lookups', async () => {
  const s = await scenario();
  s.items.forEach((item) => { delete item.request_field_id; });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.equal(s.calls.filter((call) => call.path.includes('/values/sheetA!A1')).length, 1);
});

test('request budget comparison uses the same 15k sheet and real adapter, not a synthetic sleep', async (t) => {
  const optimized = await scenario();
  const legacy = await scenario();
  legacy.client.readDispatchSheetSnapshot = undefined;
  assert.equal((await legacy.execute('legacy_compare')).status, 'SUCCESS');
  assert.equal((await optimized.execute('optimized_compare')).status, 'SUCCESS');
  assert.ok(legacy.calls.length > 300, String(legacy.calls.length));
  assert.ok(optimized.calls.length < 15, String(optimized.calls.length));
  const preflight = (s) => s.logs.find((line) => line.stage === 'batch_preflight').duration_ms;
  t.diagnostic(JSON.stringify({ environment: 'local_stub_not_live_latency', rows: 15013, targets: 20,
    legacy_http_requests: legacy.calls.length, optimized_http_requests: optimized.calls.length,
    legacy_preflight_cpu_ms: preflight(legacy), optimized_preflight_cpu_ms: preflight(optimized) }));
});

test('no historical anchor: full prefix remains verified instead of assuming a short window is complete', async () => {
  const s = await scenario({ history: false });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS');
  assert.equal(fullReads(s).length, 2, 'one complete observation and one complete-prefix guard');
  assert.equal(s.assignments.length, 1);
  assert.equal(writes(s).length, 1);
});

test('a genuine CAS conflict re-reads the sheet before retrying the same batch', async () => {
  let injected = false;
  const s = await scenario({ count: 4, beforeAssign: async ({ store, set }) => {
    if (injected) return;
    injected = true;
    set('J', 14892, 'C');
    const state = await store.getDailyState('2026-10-25', 'default');
    await store.calibrateCursor({ dayKey: '2026-10-25', scope: 'default', direction: 'forward',
      assignee: 'B', roster: state.roster, expectedVersion: state.version, expectedCursorVersion: state.forward_version });
  } });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.equal(s.cell('J', 14892), 'C');
  assert.equal((await s.facts()).length, 3);
  assert.equal(fullReads(s).length, 2);
  assert.equal(result.results[1].replayed, true);
});

test('persistent CAS conflicts remain bounded and cannot become unconditional writes', async () => {
  const s = await scenario({ beforeAssign: async ({ store }) => {
    const state = await store.getDailyState('2026-10-25', 'default');
    await store.calibrateCursor({ dayKey: '2026-10-25', scope: 'default', direction: 'forward',
      assignee: 'B', roster: state.roster, expectedVersion: state.version, expectedCursorVersion: state.forward_version });
  } });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(s.assignments.length, 2);
  assert.equal((await s.facts()).length, 0);
  assert.equal(writes(s).length, 0);
});

test('decision RPC response loss keeps the original decisions and stops later scope segments', async () => {
  let injected = false;
  const s = await scenario({ values: ['', '', 'D'], afterAssign: () => {
    if (injected) return;
    injected = true;
    const error = new Error('database response lost after commit');
    error.code = 'DISPATCH_DB_TIMEOUT';
    throw error;
  } });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal((await s.facts()).length, 2);
  assert.equal(s.assignments.length, 1);
  assert.equal(writes(s).length, 0);
  assert.ok(result.results.every((row) => row.errorCode === 'DISPATCH_DB_TIMEOUT'));
  const recovered = await s.execute();
  assert.equal(recovered.status, 'SUCCESS', JSON.stringify(recovered.results));
  assert.equal((await s.facts()).length, 19, 'one manual row plus nineteen unique automatic decisions');
});

test('row moved after the shared scan: old positions cannot reach a batch write', async () => {
  let injected = false;
  const s = await scenario({ count: 2, beforeRead: ({ call, cell, set }) => {
    if (!injected && call.ranges?.length === 4 && !call.ranges.some((range) => /1:[A-Z]+5000$/.test(range))) {
      injected = true;
      for (const col of ['X', 'H', 'C', 'J']) {
        for (let row = 14892; row >= 14891; row -= 1) set(col, row + 1, cell(col, row));
        set(col, 14891, '');
      }
    }
  } });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.deepEqual(s.assignments[0].contexts.map((item) => item.rowIndex), [14892, 14893]);
  assert.equal(s.cell('J', 14891), '');
  assert.equal(s.items[0].row_index, 14891, 'immutable action identity must not be rewritten');
});

test('row moved after decisions: no writes, even though the ledger is already committed', async () => {
  const s = await scenario({ count: 2, afterAssign: ({ set }) => { set('X', 14891, 'different_requirement'); } });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(writes(s).length, 0);
  assert.equal((await s.facts()).length, 2);
});

test('failed final confirmation cannot report SUCCESS or start the next manual-boundary segment', async () => {
  const s = await scenario({ values: ['', '', 'D'], beforeWrite: ({ call }) => {
    // Simulate a partial application by silently removing one update.
    call.body.valueRanges.pop();
  } });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(s.assignments.length, 1);
  assert.equal((await s.facts()).length, 2);
  assert.equal(s.cell('J', 14893), 'D');
});

test('AD review production column contract: B assignee, C request ID and J date use isolated ad_review CAS', async () => {
  const s = await scenario({ ad: true, values: ['', '', 'D'] });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.equal(s.cell('B', 14893), 'D');
  assert.equal((await s.facts()).length, 19);
  assert.ok(s.assignments.every((args) => args.scope === 'ad_review'));
  assert.equal(fullReads(s).length, 1);
  assert.equal(writes(s).length, 2);
  assert.ok(writes(s).every((call) => call.body.valueRanges.every(({ range }) => /!B\d+:B\d+$/.test(range))));
});

test('equal manual names at different rows are distinct anchors after intervening automatic assignments', async () => {
  const s = await scenario({ count: 4, values: ['D', '', 'D', ''] });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.deepEqual(result.results.map((row) => row.assignee), ['D', 'E', 'D', 'E']);
  assert.equal((await s.facts()).length, 2);
  assert.equal(fullReads(s).length, 1);
});

test('all thirteen manual rows retain strict CAS and never allocate or write a sheet cell', async () => {
  const values = Array.from({ length: 13 }, (_, index) => ['A', 'B', 'C', 'D', 'E'][index % 5]);
  const s = await scenario({ count: 13, values });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.ok(result.results.every((row) => row.replayed));
  assert.equal(s.assignments.length, 0);
  assert.equal(writes(s).length, 0);
  assert.equal(fullReads(s).length, 1);
});

test('paused segmented batch resumes the same identity and never reallocates its confirmed first segment', async () => {
  let s;
  let interrupted = false;
  s = await scenario({ values: ['', '', 'D'], afterAssign: () => {
    if (interrupted) return;
    interrupted = true;
    s.current.setTime(s.current.getTime() + 211000);
  } });
  const paused = await s.execute();
  assert.equal(paused.status, 'PROCESSING');
  assert.equal(paused.results.length, 2);
  assert.equal(s.assignments.length, 1);
  const recovered = await s.execute();
  assert.equal(recovered.status, 'SUCCESS', JSON.stringify(recovered.results));
  assert.equal(recovered.results.length, 20);
  assert.equal((await s.facts()).length, 19);
  assert.equal(s.assignments.length, 2);
  assert.ok(s.assignments[1].requestIds.every((id) => !['probe_0', 'probe_1'].includes(id)));
});

test('snapshot database outage still finalizes the claim without writing or allocating', async () => {
  const s = await scenario({ count: 3 });
  s.store.getDispatchSnapshot = async () => { const error = new Error('database unavailable'); error.code = 'DISPATCH_DB_TIMEOUT'; throw error; };
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.ok(result.results.every((row) => row.errorCode === 'DISPATCH_DB_TIMEOUT'));
  assert.equal(writes(s).length, 0);
  assert.equal(s.assignments.length, 0);
  assert.ok(new Date(result.lease_expires_at) <= s.current);
});

test('unknown calibration receipt stops before any segment can allocate', async () => {
  const s = await scenario({ count: 3 });
  const calibrate = s.store.calibrateCursor.bind(s.store);
  s.store.calibrateCursor = async (args) => {
    await calibrate(args);
    const error = new Error('calibration response lost');
    error.code = 'DISPATCH_DB_TIMEOUT';
    throw error;
  };
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(writes(s).length, 0);
  assert.equal(s.assignments.length, 0);
});

test('replay of a committed empty target plus new targets never consumes the first cursor twice', async () => {
  const s = await scenario({ count: 3 });
  await s.store.assign({ dayKey: s.dayKey, scope: s.scope, requestId: 'probe_0', direction: 'forward',
    context: { sheetId: 'sheetA', sheetUrl: s.items[0].sheet_url, businessType: '千川', projectValue: '千川', rowIndex: s.firstRow } });
  const result = await s.execute();
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result.results));
  assert.deepEqual(result.results.map((row) => row.assignee), ['A', 'B', 'C']);
  assert.equal(result.results[0].replayed, true);
  assert.equal((await s.store.getDailyState(s.dayKey, s.scope)).assignment_seq, 3);
});

test('concurrent callbacks on the same batch still perform one allocation and one write', async () => {
  const s = await scenario({ count: 3 });
  await Promise.all([s.execute(), s.execute()]);
  assert.equal(s.store.getBatch('test_chat', 'shared_preflight').status, 'SUCCESS');
  assert.equal(s.assignments.length, 1);
  assert.equal(writes(s).length, 1);
  assert.equal((await s.facts()).length, 3);
});

test('oversized physical sheet stays fail-closed before requesting cell data', async () => {
  const s = await scenario({ rowCount: 20001 });
  const result = await s.execute();
  assert.equal(result.status, 'FAILED');
  assert.equal(fullReads(s).length, 0);
  assert.equal(writes(s).length, 0);
  assert.equal(s.assignments.length, 0);
});
