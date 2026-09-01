import assert from 'node:assert/strict';
import test from 'node:test';
import { LarkClient, LarkApiError } from '../lib/lark/client.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(String(url)), options });
    return handler(calls[calls.length - 1]);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('tenant_access_token 缓存：只请求一次且携带 app_id/app_secret', async () => {
  const stub = stubFetch(() => jsonResponse(200, { code: 0, tenant_access_token: 't-abc', expire: 7200 }));
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const token1 = await client.getTenantAccessToken();
    const token2 = await client.getTenantAccessToken();
    assert.equal(token1, 't-abc');
    assert.equal(token2, 't-abc');
    const tokenCalls = stub.calls.filter((call) => call.url.pathname.endsWith('/tenant_access_token/internal'));
    assert.equal(tokenCalls.length, 1);
    const body = JSON.parse(tokenCalls[0].options.body);
    assert.equal(body.app_id, 'cli_x');
    assert.equal(body.app_secret, 'sec');
    assert.ok(!('Authorization' in tokenCalls[0].options.headers));
  } finally {
    stub.restore();
  }
});

test('缺少凭证时 fail-closed 抛出 MISSING_APP_CREDENTIALS', async () => {
  const client = new LarkClient({ appId: '', appSecret: '' });
  await assert.rejects(() => client.getTenantAccessToken(), (error) => {
    assert.ok(error instanceof LarkApiError);
    assert.equal(error.code, 'MISSING_APP_CREDENTIALS');
    return true;
  });
});

test('replyMessage 显式创建话题并在请求体携带 uuid', async () => {
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    assert.match(call.url.pathname, /\/im\/v1\/messages\/om_card_1\/reply$/);
    assert.equal(call.url.searchParams.get('uuid'), null);
    assert.equal(call.options.headers.Authorization, 'Bearer t-1');
    const body = JSON.parse(call.options.body);
    assert.equal(body.msg_type, 'text');
    assert.match(body.content, /需求 ID/);
    assert.equal(body.reply_in_thread, true);
    assert.equal(body.uuid, 'bess-dispatch-706001');
    return jsonResponse(200, { code: 0, data: { message_id: 'om_reply_1' } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const data = await client.replyMessage({
      messageId: 'om_card_1',
      msgType: 'text',
      content: { text: '需求 ID：706001' },
      uuid: 'bess-dispatch-706001',
    });
    assert.equal(data.message_id, 'om_reply_1');
  } finally {
    stub.restore();
  }
});

test('getMessage 解析 data.items[0]', async () => {
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    assert.match(call.url.pathname, /\/im\/v1\/messages\/om_card_1$/);
    return jsonResponse(200, { code: 0, data: { items: [{ message_id: 'om_card_1', msg_type: 'interactive' }] } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const message = await client.getMessage('om_card_1');
    assert.equal(message.msg_type, 'interactive');
  } finally {
    stub.restore();
  }
});

test('OpenAPI 业务错误码转为 LarkApiError', async () => {
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    return jsonResponse(200, { code: 230001, msg: 'bad request' });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    await assert.rejects(() => client.getMessage('om_card_1'), (error) => {
      assert.ok(error instanceof LarkApiError);
      assert.equal(error.code, 'LARK_API_230001');
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('HTTP 错误保留飞书业务码、状态码、端点与 log_id', async () => {
  const stub = stubFetch(() => jsonResponse(400, {
    code: 99991668,
    msg: 'Invalid access token for authorization.',
    error: { log_id: 'log_123' },
  }));
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    await assert.rejects(() => client.getTenantAccessToken(), (error) => {
      assert.equal(error.code, 'LARK_API_99991668');
      assert.equal(error.httpStatus, 400);
      assert.equal(error.endpoint, '/open-apis/auth/v3/tenant_access_token/internal');
      assert.equal(error.apiCode, 99991668);
      assert.equal(error.apiMessage, 'Invalid access token for authorization.');
      assert.equal(error.logId, 'log_123');
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('HTTP 5xx 与超时分别映射错误码', async () => {
  const stub500 = stubFetch(() => ({ ok: false, status: 500, async text() { return '{}'; } }));
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    await assert.rejects(() => client.getTenantAccessToken(), (error) => {
      assert.equal(error.code, 'LARK_API_HTTP_ERROR');
      return true;
    });
  } finally {
    stub500.restore();
  }

  const stubSlow = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    // Never resolves on its own; settle once the client aborts the request.
    return new Promise((resolve, reject) => {
      call.options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  });
  try {
    const client = new LarkClient({
      appId: 'cli_x',
      appSecret: 'sec',
      baseUrl: 'https://open.feishu.test',
      timeoutMs: 50,
    });
    await assert.rejects(() => client.replyMessage({
      messageId: 'om_card_1',
      msgType: 'text',
      content: { text: 'x' },
    }), (error) => {
      assert.equal(error.code, 'LARK_API_TIMEOUT');
      return true;
    });
  } finally {
    stubSlow.restore();
  }
});


test('delayUpdateMessageCard 使用回调 token 调用延时更新接口', async () => {
  const card = { schema: '2.0', config: { update_multi: true }, body: { elements: [] } };
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    assert.equal(call.options.method, 'POST');
    assert.equal(call.url.pathname, '/open-apis/interactive/v1/card/update');
    assert.equal(call.options.headers.Authorization, 'Bearer t-1');
    assert.deepEqual(JSON.parse(call.options.body), { token: 'c-update-1', card });
    return jsonResponse(200, { code: 0, msg: 'ok' });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    await client.delayUpdateMessageCard('c-update-1', card);
  } finally {
    stub.restore();
  }
});


test('updateMessageCard 使用 PATCH interactive 消息格式更新原卡片', async () => {
  const card = { schema: '2.0', body: { elements: [] } };
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    assert.equal(call.options.method, 'PATCH');
    assert.equal(call.url.pathname, '/open-apis/im/v1/messages/om_card%2F1');
    assert.equal(call.options.headers.Authorization, 'Bearer t-1');
    const body = JSON.parse(call.options.body);
    assert.ok(!('msg_type' in body));
    assert.equal(body.content, JSON.stringify(card));
    return jsonResponse(200, { code: 0, data: { message_id: 'om_card/1' } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const data = await client.updateMessageCard('om_card/1', card);
    assert.equal(data.message_id, 'om_card/1');
  } finally {
    stub.restore();
  }
});


test('readSheetDispatchRows 按相同行号对齐读取日期、负责人和项目列', async () => {
  const requestedRanges = [];
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    if (call.url.pathname.endsWith('/sheets/query')) {
      return jsonResponse(200, { code: 0, data: { sheets: [{ sheet_id: 'TQuzLA', grid_properties: { row_count: 3 } }] } });
    }
    const encodedRange = call.url.pathname.split('/values/')[1];
    const range = decodeURIComponent(encodedRange);
    requestedRanges.push(range);
    if (range.includes('!H')) return jsonResponse(200, { code: 0, data: { valueRange: { values: [['2026-08-30'], ['8.30']] } } });
    if (range.includes('!C')) return jsonResponse(200, { code: 0, data: { valueRange: { values: [['千川'], [['本地', '千川']], ['仅项目']] } } });
    return jsonResponse(200, { code: 0, data: { valueRange: { values: [['张三'], ['李四']] } } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const rows = await client.readSheetDispatchRows({
      sheetUrl: 'https://example.feishu.cn/sheets/spreadsheetToken', sheetId: 'TQuzLA',
      dateFieldId: 'H', assigneeFieldId: 'J', projectFieldId: 'C',
    });
    assert.deepEqual(rows, [
      ['2026-08-30', '张三', '千川'],
      ['8.30', '李四', ['本地', '千川']],
      [undefined, undefined, '仅项目'],
    ]);
    assert.deepEqual(requestedRanges.sort(), ['TQuzLA!C1:C3', 'TQuzLA!H1:H3', 'TQuzLA!J1:J3']);
  } finally {
    stub.restore();
  }
});


test('row_count 不超过上限时从第 1 行分块扫描并找到前部数据', async () => {
  const requestedRanges = [];
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    if (call.url.pathname.endsWith('/sheets/query')) {
      return jsonResponse(200, { code: 0, data: { sheets: [{ sheet_id: 'TQuzLA', grid_properties: { row_count: 20000 } }] } });
    }
    const range = decodeURIComponent(call.url.pathname.split('/values/')[1]);
    requestedRanges.push(range);
    if (range === 'TQuzLA!H1:H5000') return jsonResponse(200, { code: 0, data: { valueRange: { values: [['2026-08-30']] } } });
    if (range === 'TQuzLA!J1:J5000') return jsonResponse(200, { code: 0, data: { valueRange: { values: [['张三']] } } });
    return jsonResponse(200, { code: 0, data: { valueRange: { values: [] } } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    const rows = await client.readSheetDispatchRows({
      sheetUrl: 'https://example.feishu.cn/sheets/spreadsheetToken', sheetId: 'TQuzLA',
      dateFieldId: 'H', assigneeFieldId: 'J',
    });
    assert.deepEqual(rows, [['2026-08-30', '张三']]);
    assert.ok(requestedRanges.includes('TQuzLA!H1:H5000'));
    assert.ok(requestedRanges.includes('TQuzLA!H15001:H20000'));
    assert.ok(!requestedRanges.some((range) => range.includes('80001')));
  } finally {
    stub.restore();
  }
});


test('物理 row_count 超过 20000 时立即 fail-closed 且不读取单元格', async () => {
  const stub = stubFetch((call) => {
    if (call.url.pathname.endsWith('/tenant_access_token/internal')) {
      return jsonResponse(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    if (call.url.pathname.endsWith('/sheets/query')) {
      return jsonResponse(200, { code: 0, data: { sheets: [{ sheet_id: 'TQuzLA', grid_properties: { row_count: 100000 } }] } });
    }
    return jsonResponse(200, { code: 0, data: { valueRange: { values: [['仍有数据']] } } });
  });
  try {
    const client = new LarkClient({ appId: 'cli_x', appSecret: 'sec', baseUrl: 'https://open.feishu.test' });
    await assert.rejects(() => client.readSheetDispatchRows({
      sheetUrl: 'https://example.feishu.cn/sheets/spreadsheetToken', sheetId: 'TQuzLA',
      dateFieldId: 'H', assigneeFieldId: 'J', selectLatest: () => null,
    }), (error) => error instanceof LarkApiError && error.code === 'SHEET_SCAN_LIMIT_EXCEEDED');
    assert.equal(stub.calls.filter((call) => call.url.pathname.includes('/values/')).length, 0);
  } finally {
    stub.restore();
  }
});
