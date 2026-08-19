import { randomUUID } from 'node:crypto';
import { selectAlishaMemory } from '../src/utils/alishaMemory.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set([
  'session_started',
  'session_ended',
  'section_viewed',
  'memory_delivered',
]);
const FEEDBACK_ACTIONS = new Set(['opened', 'dismissed']);
const SECTIONS = new Set(['about', 'daily', 'reading', 'travel', 'photography', 'song']);

export class AlishaMemoryError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'AlishaMemoryError';
    this.status = status;
  }
}

export function validateVisitorId(value) {
  const visitorId = String(value || '').trim();
  if (!UUID_PATTERN.test(visitorId)) {
    throw new AlishaMemoryError('无效的阿丽莎访客标识', 400);
  }
  return visitorId;
}

function cleanText(value, maxLength = 96) {
  return String(value || '').trim().slice(0, maxLength);
}

function safeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (serialized.length > 2048) {
    throw new AlishaMemoryError('事件上下文过大', 400);
  }
  return value;
}

export function normalizeMemoryEvents(value, now = new Date()) {
  const events = Array.isArray(value) ? value : [];
  if (events.length === 0 || events.length > 20) {
    throw new AlishaMemoryError('每批事件数量必须在 1 到 20 之间', 400);
  }
  return events.map((event) => {
    if (!UUID_PATTERN.test(String(event?.eventId || ''))) {
      throw new AlishaMemoryError('事件缺少有效的幂等标识', 400);
    }
    if (!EVENT_TYPES.has(event?.type)) {
      throw new AlishaMemoryError('不支持的记忆事件类型', 400);
    }
    const occurredAt = new Date(event.occurredAt || now);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new AlishaMemoryError('事件时间无效', 400);
    }
    return {
      event_id: event.eventId,
      event_type: event.type,
      content_type: cleanText(event.contentType, 32) || null,
      content_id: cleanText(event.contentId) || null,
      memory_id: cleanText(event.memoryId) || null,
      context: safeContext(event.context),
      occurred_at: occurredAt.toISOString(),
    };
  });
}

function createSupabaseClient(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const clockSkewRetryDelayMs = options.clockSkewRetryDelayMs ?? 500;
  const url = cleanText(options.url || process.env.SUPABASE_URL, 1000).replace(/\/+$/, '');
  const serviceRoleKey = cleanText(
    options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    5000
  );
  if (!url || !serviceRoleKey) {
    throw new AlishaMemoryError('阿丽莎云端记忆尚未配置', 503);
  }

  return async function request(path, requestOptions = {}) {
    const authorizationHeaders = serviceRoleKey.startsWith('eyJ')
      ? { Authorization: `Bearer ${serviceRoleKey}` }
      : {};
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6500);
      try {
        const response = await fetchImpl(`${url}/rest/v1/${path}`, {
          method: requestOptions.method || 'GET',
          headers: {
            apikey: serviceRoleKey,
            ...authorizationHeaders,
            Accept: 'application/json',
            ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
            ...(requestOptions.prefer ? { Prefer: requestOptions.prefer } : {}),
          },
          body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          const details = await response.text().catch(() => '');
          const isTransientClockSkew =
            response.status === 401 &&
            details.includes('PGRST303') &&
            details.includes('JWT issued at future');
          if (isTransientClockSkew && attempt === 0) {
            await sleepImpl(clockSkewRetryDelayMs);
            continue;
          }
          const error = new AlishaMemoryError(
            `记忆数据库请求失败：${response.status}${details ? ` ${details.slice(0, 180)}` : ''}`,
            502
          );
          error.upstreamStatus = response.status;
          throw error;
        }
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function mapProfile(row, deliveries = []) {
  return {
    version: 1,
    visitorId: row.visitor_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    visitDays: Array.isArray(row.visit_day_keys) ? row.visit_day_keys : [],
    sectionVisits:
      row.section_visits && typeof row.section_visits === 'object'
        ? row.section_visits
        : {},
    deliveries: deliveries.map((delivery) => ({
      memoryId: delivery.memory_id,
      contentId: delivery.content_id,
      deliveredAt: delivery.delivered_at,
      action: delivery.action,
    })),
  };
}

export function createSupabaseAlishaStore(options = {}) {
  const request = createSupabaseClient(options);

  async function ensureProfile(visitorId, dayKey) {
    const now = new Date().toISOString();
    const existing = await request(
      `alisha_profiles?visitor_id=eq.${encodeURIComponent(visitorId)}&select=*&limit=1`
    );
    if (existing?.[0]) {
      const visitDayKeys = Array.from(
        new Set([
          ...(Array.isArray(existing[0].visit_day_keys) ? existing[0].visit_day_keys : []),
          ...(dayKey ? [dayKey] : []),
        ])
      ).slice(-90);
      const rows = await request(
        `alisha_profiles?visitor_id=eq.${encodeURIComponent(visitorId)}`,
        {
          method: 'PATCH',
          body: { last_seen_at: now, visit_day_keys: visitDayKeys },
          prefer: 'return=representation',
        }
      );
      return rows?.[0] || { ...existing[0], last_seen_at: now, visit_day_keys: visitDayKeys };
    }

    const body = {
      visitor_id: visitorId,
      first_seen_at: now,
      last_seen_at: now,
      visit_day_keys: dayKey ? [dayKey] : [],
    };
    const rows = await request('alisha_profiles?on_conflict=visitor_id', {
      method: 'POST',
      body,
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    if (rows?.[0]) return rows[0];
    const concurrent = await request(
      `alisha_profiles?visitor_id=eq.${encodeURIComponent(visitorId)}&select=*&limit=1`
    );
    return concurrent?.[0] || body;
  }

  return {
    async getProfile(visitorId, dayKey) {
      const [profile, deliveries] = await Promise.all([
        ensureProfile(visitorId, dayKey),
        request(
          `alisha_memory_deliveries?visitor_id=eq.${encodeURIComponent(visitorId)}&select=memory_id,content_id,delivered_at,action&order=delivered_at.desc&limit=60`
        ),
      ]);
      return mapProfile(profile || { visitor_id: visitorId }, deliveries || []);
    },

    async appendEvents(visitorId, events, dayKey) {
      const profile = await ensureProfile(visitorId, dayKey);
      await request('alisha_events?on_conflict=event_id', {
        method: 'POST',
        body: events.map((event) => ({ ...event, visitor_id: visitorId })),
        prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      const sectionVisits = { ...(profile.section_visits || {}) };
      let sectionChanged = false;
      events.forEach((event) => {
        const section = cleanText(event.context?.section, 32);
        if (event.event_type !== 'section_viewed' || !SECTIONS.has(section)) return;
        sectionVisits[section] = Number(sectionVisits[section] || 0) + 1;
        sectionChanged = true;
      });
      if (sectionChanged) {
        await request(
          `alisha_profiles?visitor_id=eq.${encodeURIComponent(visitorId)}`,
          {
            method: 'PATCH',
            body: { section_visits: sectionVisits },
            prefer: 'return=minimal',
          }
        );
      }
    },

    async getDeliveries(visitorId, sinceIso) {
      return (
        (await request(
          `alisha_memory_deliveries?visitor_id=eq.${encodeURIComponent(visitorId)}&delivered_at=gte.${encodeURIComponent(sinceIso)}&select=memory_id,content_id,delivered_at,action&order=delivered_at.desc`
        )) || []
      );
    },

    async createDelivery(visitorId, delivery) {
      const rows = await request('alisha_memory_deliveries', {
        method: 'POST',
        body: { ...delivery, visitor_id: visitorId },
        prefer: 'return=representation',
      });
      return rows?.[0] || delivery;
    },

    async updateDelivery(visitorId, memoryId, action) {
      const rows = await request(
        `alisha_memory_deliveries?visitor_id=eq.${encodeURIComponent(visitorId)}&memory_id=eq.${encodeURIComponent(memoryId)}`,
        {
          method: 'PATCH',
          body: { action, acted_at: new Date().toISOString() },
          prefer: 'return=representation',
        }
      );
      return rows?.[0] || null;
    },

    async deleteProfile(visitorId) {
      await request(
        `alisha_profiles?visitor_id=eq.${encodeURIComponent(visitorId)}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      );
    },
  };
}

function dayFromKey(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) {
    throw new AlishaMemoryError('日期参数无效', 400);
  }
  const date = new Date(`${dayKey}T12:00:00+08:00`);
  if (Number.isNaN(date.getTime())) throw new AlishaMemoryError('日期参数无效', 400);
  return date;
}

function dayStartIso(dayKey) {
  return new Date(`${dayKey}T00:00:00+08:00`).toISOString();
}

async function fetchPublicDiary(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const contentApiUrl = cleanText(
    options.contentApiUrl || process.env.ALISHA_CONTENT_API_URL || 'https://api.littlearisa88.com',
    1000
  ).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetchImpl(`${contentApiUrl}/api/diary`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new AlishaMemoryError('无法读取公开日记', 502);
    const data = await response.json();
    return (Array.isArray(data) ? data : [])
      .filter((item) => item?.isPublic !== false && item?.status !== 'draft')
      .map((item) => {
        let media = item.media;
        if (typeof media === 'string') {
          try {
            media = JSON.parse(media);
          } catch {
            media = [];
          }
        }
        const rawId = cleanText(item.id);
        return {
          ...item,
          id: rawId.startsWith('post-') ? rawId : `post-${rawId}`,
          text: cleanText(item.text, 10_000),
          media: Array.isArray(media) ? media : [],
        };
      })
      .filter((item) => item.id !== 'post-' && item.date);
  } finally {
    clearTimeout(timer);
  }
}

export function createAlishaMemoryService(options = {}) {
  const store = options.store || createSupabaseAlishaStore(options);

  return {
    async getProfile(visitorId, dayKey) {
      return store.getProfile(validateVisitorId(visitorId), dayKey);
    },

    async recordEvents(visitorId, rawEvents, dayKey) {
      const validVisitorId = validateVisitorId(visitorId);
      const events = normalizeMemoryEvents(rawEvents);
      await store.appendEvents(validVisitorId, events, dayKey);
      return { accepted: events.length };
    },

    async recommend(visitorId, { dayKey, section = 'daily' } = {}) {
      const validVisitorId = validateVisitorId(visitorId);
      const now = dayFromKey(dayKey);
      const todayStart = dayStartIso(dayKey);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      await store.getProfile(validVisitorId, dayKey);
      const deliveries = await store.getDeliveries(validVisitorId, thirtyDaysAgo);
      if (deliveries.some((delivery) => delivery.delivered_at >= todayStart)) return null;

      const posts = await fetchPublicDiary(options);
      const profile = {
        deliveries: deliveries.map((delivery) => ({
          memoryId: delivery.content_id,
          deliveredAt: delivery.delivered_at,
          action: delivery.action,
        })),
      };
      const selected = selectAlishaMemory({ posts, profile, now });
      if (!selected) return null;

      const memoryId = randomUUID();
      await store.createDelivery(validVisitorId, {
        memory_id: memoryId,
        content_type: selected.contentType,
        content_id: selected.contentId,
        reason_code:
          selected.reason === '同一天，不同年份' ? 'same-day-other-year' : 'long-unseen',
        action: 'delivered',
        delivered_at: new Date().toISOString(),
      });
      return {
        ...selected,
        id: memoryId,
        source: 'cloud-rules',
        context: { section: cleanText(section, 32) },
      };
    },

    async recordFeedback(visitorId, memoryId, action) {
      const validVisitorId = validateVisitorId(visitorId);
      const validMemoryId = cleanText(memoryId);
      if (!UUID_PATTERN.test(validMemoryId) || !FEEDBACK_ACTIONS.has(action)) {
        throw new AlishaMemoryError('无效的记忆反馈', 400);
      }
      const delivery = await store.updateDelivery(validVisitorId, validMemoryId, action);
      if (!delivery) throw new AlishaMemoryError('记忆投递不存在', 404);
      return { updated: true };
    },

    async forget(visitorId) {
      await store.deleteProfile(validateVisitorId(visitorId));
    },
  };
}
