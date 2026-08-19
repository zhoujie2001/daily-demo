import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAlishaMemoryProfile,
  fetchAlishaRecommendation,
  deleteAlishaMemory,
  recordAlishaEvents,
  recordAlishaFeedback,
} from '../api/alishaMemory';
import {
  ALISHA_MEMORY_STORAGE_KEY,
  ALISHA_VISITOR_STORAGE_KEY,
  createEmptyAlishaMemoryProfile,
  hasDeliveredToday,
  mergeAlishaMemoryProfiles,
  normalizeAlishaMemoryProfile,
  normalizeCloudRecommendation,
  recordAlishaDelivery,
  registerAlishaVisit,
  selectAlishaMemory,
  toLocalDayKey,
  updateAlishaDeliveryAction,
} from '../utils/alishaMemory';

const FORGET_PENDING_KEY = 'daily-demo-alisha-forget-pending-v1';

function createVisitorId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function getVisitorId() {
  try {
    const stored = window.localStorage.getItem(ALISHA_VISITOR_STORAGE_KEY);
    if (stored) return stored;
    const created = createVisitorId();
    window.localStorage.setItem(ALISHA_VISITOR_STORAGE_KEY, created);
    return created;
  } catch {
    return createVisitorId();
  }
}

function readLocalProfile(visitorId) {
  try {
    const raw = window.localStorage.getItem(ALISHA_MEMORY_STORAGE_KEY);
    return normalizeAlishaMemoryProfile(raw ? JSON.parse(raw) : null, visitorId);
  } catch {
    return createEmptyAlishaMemoryProfile(visitorId);
  }
}

function writeLocalProfile(profile) {
  try {
    window.localStorage.setItem(ALISHA_MEMORY_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 云端仍可继续记录；本机隐私模式下不阻断阿丽莎。
  }
}

function quietly(promise) {
  promise?.catch(() => null);
}

export function useAlishaMemory({ posts, enabled = true }) {
  const visitorIdRef = useRef('');
  const profileRef = useRef(null);
  const forgottenRef = useRef(false);
  const [memoryCue, setMemoryCue] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const sessionStartedAt = Date.now();
    try {
      const pendingVisitorId = window.localStorage.getItem(FORGET_PENDING_KEY);
      if (pendingVisitorId) {
        quietly(
          deleteAlishaMemory(pendingVisitorId).then(() => {
            window.localStorage.removeItem(FORGET_PENDING_KEY);
          })
        );
      }
    } catch {
      // 无法读取本机存储时继续当前会话。
    }
    const visitorId = getVisitorId();
    visitorIdRef.current = visitorId;
    const localProfile = registerAlishaVisit(readLocalProfile(visitorId));
    profileRef.current = localProfile;
    writeLocalProfile(localProfile);

    quietly(
      fetchAlishaMemoryProfile(visitorId).then((remote) => {
        const remoteProfile = remote?.profile || remote;
        if (!remoteProfile) return;
        const merged = registerAlishaVisit(
          mergeAlishaMemoryProfiles(profileRef.current, remoteProfile, visitorId)
        );
        profileRef.current = merged;
        writeLocalProfile(merged);
      })
    );
    quietly(
      recordAlishaEvents(visitorId, {
        type: 'session_started',
        occurredAt: new Date().toISOString(),
        context: { path: window.location.pathname },
      })
    );

    return () => {
      if (forgottenRef.current) return;
      const activeSeconds = Math.max(
        1,
        Math.round((Date.now() - sessionStartedAt) / 1000)
      );
      quietly(
        recordAlishaEvents(
          visitorId,
          {
            type: 'session_ended',
            occurredAt: new Date().toISOString(),
            context: { activeSeconds },
          },
          { keepalive: true }
        )
      );
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return undefined;
    const sectionIds = ['about', 'daily', 'reading', 'travel', 'photography', 'song'];
    const recorded = new Set();
    const timers = new Map();

    const recordSection = (section) => {
      if (recorded.has(section) || !visitorIdRef.current || forgottenRef.current) return;
      recorded.add(section);
      const profile = profileRef.current;
      if (profile) {
        const sectionVisits = {
          ...(profile.sectionVisits || {}),
          [section]: Number(profile.sectionVisits?.[section] || 0) + 1,
        };
        profileRef.current = { ...profile, sectionVisits };
        writeLocalProfile(profileRef.current);
      }
      quietly(
        recordAlishaEvents(visitorIdRef.current, {
          type: 'section_viewed',
          occurredAt: new Date().toISOString(),
          context: { section, dwellThresholdSeconds: 4 },
        })
      );
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const section = entry.target.id;
          if (!section || recorded.has(section)) return;
          if (entry.isIntersecting) {
            if (!timers.has(section)) {
              timers.set(
                section,
                window.setTimeout(() => recordSection(section), 4_000)
              );
            }
          } else if (timers.has(section)) {
            window.clearTimeout(timers.get(section));
            timers.delete(section);
          }
        });
      },
      { threshold: 0.45 }
    );

    sectionIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });
    return () => {
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !posts?.length) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const visitorId = visitorIdRef.current;
      const profile = profileRef.current;
      if (
        !visitorId ||
        !profile ||
        cancelled ||
        forgottenRef.current ||
        hasDeliveredToday(profile)
      ) return;

      let recommendation = null;
      try {
        const remote = await fetchAlishaRecommendation(visitorId, {
          section: 'daily',
          dayKey: toLocalDayKey(),
        });
        recommendation = normalizeCloudRecommendation(
          remote?.recommendation || remote,
          posts
        );
      } catch {
        recommendation = selectAlishaMemory({ posts, profile });
      }
      if (!recommendation || cancelled) return;

      const nextProfile = recordAlishaDelivery(
        profileRef.current,
        recommendation.id
      );
      profileRef.current = nextProfile;
      writeLocalProfile(nextProfile);
      setMemoryCue(recommendation);
      quietly(
        recordAlishaEvents(visitorId, {
          type: 'memory_delivered',
          occurredAt: new Date().toISOString(),
          contentType: recommendation.contentType,
          contentId: recommendation.contentId,
          memoryId: recommendation.id,
          context: {
            source: recommendation.source,
            reason: recommendation.reason,
          },
        })
      );
    }, 8_000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, posts]);

  const respondToMemory = useCallback((action) => {
    const cue = memoryCue;
    if (!cue) return null;
    const nextProfile = updateAlishaDeliveryAction(
      profileRef.current,
      cue.id,
      action
    );
    profileRef.current = nextProfile;
    writeLocalProfile(nextProfile);
    setMemoryCue(null);
    quietly(recordAlishaFeedback(visitorIdRef.current, cue.id, action));
    return cue;
  }, [memoryCue]);

  const openMemory = useCallback(() => respondToMemory('opened'), [respondToMemory]);
  const dismissMemory = useCallback(
    () => respondToMemory('dismissed'),
    [respondToMemory]
  );

  const forgetMemory = useCallback(async () => {
    const visitorId = visitorIdRef.current;
    forgottenRef.current = true;
    setMemoryCue(null);
    let cloudDeleted = false;
    if (visitorId) {
      try {
        await deleteAlishaMemory(visitorId);
        cloudDeleted = true;
      } catch {
        try {
          window.localStorage.setItem(FORGET_PENDING_KEY, visitorId);
        } catch {
          // 无法排队时仍清除当前设备上的档案。
        }
      }
    }
    try {
      window.localStorage.removeItem(ALISHA_MEMORY_STORAGE_KEY);
      window.localStorage.removeItem(ALISHA_VISITOR_STORAGE_KEY);
      if (cloudDeleted) window.localStorage.removeItem(FORGET_PENDING_KEY);
    } catch {
      // 隐私模式下内存状态已经停止继续记录。
    }
    visitorIdRef.current = '';
    profileRef.current = null;
    return { cloudDeleted };
  }, []);

  return { memoryCue, openMemory, dismissMemory, forgetMemory };
}
