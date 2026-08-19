import { ALISHA_MEMORY_API_BASE } from '../config';

const VISITOR_HEADER = 'X-Alisha-Visitor-Id';

function createEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function memoryApiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${ALISHA_MEMORY_API_BASE}${normalized}`;
}

async function memoryRequest(path, visitorId, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(memoryApiUrl(path), {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        [VISITOR_HEADER]: visitorId,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const error = new Error(`Alisha memory request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

export function fetchAlishaMemoryProfile(visitorId) {
  return memoryRequest('/api/alisha/memory/profile', visitorId);
}

export function fetchAlishaRecommendation(visitorId, context = {}) {
  const params = new URLSearchParams();
  if (context.section) params.set('section', context.section);
  if (context.dayKey) params.set('day', context.dayKey);
  const suffix = params.size ? `?${params}` : '';
  return memoryRequest(`/api/alisha/memory/recommendation${suffix}`, visitorId);
}

export function recordAlishaEvents(visitorId, events, { keepalive = false } = {}) {
  const normalized = (Array.isArray(events) ? events : [events])
    .filter(Boolean)
    .map((event) => ({ eventId: event.eventId || createEventId(), ...event }));
  if (normalized.length === 0) return Promise.resolve(null);
  return memoryRequest('/api/alisha/memory/events', visitorId, {
    method: 'POST',
    keepalive,
    body: JSON.stringify({ events: normalized }),
  });
}

export function recordAlishaFeedback(visitorId, memoryId, action) {
  return memoryRequest('/api/alisha/memory/feedback', visitorId, {
    method: 'POST',
    body: JSON.stringify({ memoryId, action }),
  });
}

export function deleteAlishaMemory(visitorId) {
  return memoryRequest('/api/alisha/memory', visitorId, { method: 'DELETE' });
}
