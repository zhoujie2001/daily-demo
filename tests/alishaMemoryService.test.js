import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAlishaMemoryService,
  createSupabaseAlishaStore,
  normalizeMemoryEvents,
  validateVisitorId,
} from '../server/alishaMemoryService.js';
import { handleAlishaMemoryRequest } from '../server/alishaMemoryApi.js';

const VISITOR_ID = '78f0b9e9-25ab-4bd7-9c6b-499e54ca32c6';
const EVENT_ID = '0fe53c0b-975a-4fae-a6d6-0c43d9ce9457';

function diaryResponse(items) {
  return Promise.resolve({
    ok: true,
    json: async () => items,
  });
}

function createStore(overrides = {}) {
  return {
    getProfile: async () => ({ visitorId: VISITOR_ID, deliveries: [] }),
    appendEvents: async () => {},
    getDeliveries: async () => [],
    createDelivery: async (_visitorId, delivery) => delivery,
    updateDelivery: async () => ({ memory_id: 'memory' }),
    deleteProfile: async () => {},
    ...overrides,
  };
}

test('服务端拒绝把任意匿名字符串当作访客身份', () => {
  assert.throws(() => validateVisitorId('visitor-anything'), /无效/);
  assert.equal(validateVisitorId(VISITOR_ID), VISITOR_ID);
});

test('事件白名单、幂等 UUID 和上下文大小都会被验证', () => {
  const [event] = normalizeMemoryEvents([
    {
      eventId: EVENT_ID,
      type: 'section_viewed',
      occurredAt: '2026-08-18T02:00:00.000Z',
      context: { section: 'daily' },
    },
  ]);
  assert.equal(event.event_type, 'section_viewed');
  assert.equal(event.event_id, EVENT_ID);
  assert.throws(
    () => normalizeMemoryEvents([{ eventId: EVENT_ID, type: 'unknown' }]),
    /不支持/
  );
});

test('Supabase 新 secret key 只通过 apikey 发送，旧 JWT 仍使用 Bearer', async () => {
  async function captureHeaders(serviceRoleKey) {
    const calls = [];
    const store = createSupabaseAlishaStore({
      url: 'https://project.supabase.co',
      serviceRoleKey,
      fetchImpl: async (_url, options) => {
        calls.push(options.headers);
        return {
          ok: true,
          status: 200,
          text: async () => '[]',
        };
      },
    });
    await store.getProfile(VISITOR_ID, '2026-08-18');
    return calls;
  }

  const secretCalls = await captureHeaders('sb_secret_test');
  assert.ok(secretCalls.every((headers) => headers.apikey === 'sb_secret_test'));
  assert.ok(secretCalls.every((headers) => !('Authorization' in headers)));

  const jwtCalls = await captureHeaders('eyJ.test-service-role-token');
  assert.ok(
    jwtCalls.every(
      (headers) => headers.Authorization === 'Bearer eyJ.test-service-role-token'
    )
  );
});

test('Supabase 网关短暂时钟偏差只重试一次', async () => {
  let calls = 0;
  const delays = [];
  const store = createSupabaseAlishaStore({
    url: 'https://project.supabase.co',
    serviceRoleKey: 'sb_secret_test',
    clockSkewRetryDelayMs: 25,
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({
            code: 'PGRST303',
            message: 'JWT issued at future',
          }),
        };
      }
      return {
        ok: true,
        status: 204,
        text: async () => '',
      };
    },
  });

  await store.deleteProfile(VISITOR_ID);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
});

test('云端规则优先召回同一天不同年份并写入投递记录', async () => {
  let persisted = null;
  const service = createAlishaMemoryService({
    store: createStore({
      createDelivery: async (visitorId, delivery) => {
        persisted = { visitorId, ...delivery };
        return delivery;
      },
    }),
    fetchImpl: async () => diaryResponse([
      { id: 1, date: 'Jan 05, 2024', text: '普通旧日记', media: [] },
      { id: 2, date: 'Aug 18, 2025', text: '去年今天的雨', media: [] },
    ]),
    contentApiUrl: 'https://content.example.test',
  });

  const recommendation = await service.recommend(VISITOR_ID, {
    dayKey: '2026-08-18',
    section: 'daily',
  });
  assert.equal(recommendation.contentId, 'post-2');
  assert.equal(recommendation.reason, '同一天，不同年份');
  assert.equal(persisted.visitorId, VISITOR_ID);
  assert.equal(persisted.reason_code, 'same-day-other-year');
});

test('当天已经投递过时服务端不会再次读取内容或生成推荐', async () => {
  let fetched = false;
  const service = createAlishaMemoryService({
    store: createStore({
      getDeliveries: async () => [
        {
          memory_id: '8b3af71e-6517-4ec8-89b1-0b451658c29e',
          content_id: 'post-2',
          delivered_at: '2026-08-17T16:30:00.000Z',
          action: 'delivered',
        },
      ],
    }),
    fetchImpl: async () => {
      fetched = true;
      return diaryResponse([]);
    },
  });
  const recommendation = await service.recommend(VISITOR_ID, {
    dayKey: '2026-08-18',
  });
  assert.equal(recommendation, null);
  assert.equal(fetched, false);
});

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('记忆 API 只向允许的主站来源开放', async () => {
  const deniedResponse = createMockResponse();
  await handleAlishaMemoryRequest(
    {
      method: 'GET',
      headers: { origin: 'https://tracker.example.test' },
      query: {},
    },
    deniedResponse,
    'recommendation',
    { service: {} }
  );
  assert.equal(deniedResponse.statusCode, 403);

  const allowedResponse = createMockResponse();
  await handleAlishaMemoryRequest(
    {
      method: 'GET',
      headers: {
        origin: 'https://www.littlearisa88.com',
        'x-alisha-visitor-id': VISITOR_ID,
      },
      query: { day: '2026-08-18' },
    },
    allowedResponse,
    'recommendation',
    { service: { recommend: async () => null } }
  );
  assert.equal(allowedResponse.statusCode, 204);
  assert.equal(
    allowedResponse.headers['Access-Control-Allow-Origin'],
    'https://www.littlearisa88.com'
  );
});
