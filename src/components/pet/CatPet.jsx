import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Backpack,
  BookOpen,
  Camera,
  ChevronDown,
  EyeOff,
  Pause,
  PawPrint,
  Play,
  Star,
  Settings2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  ALISHA_ACTION,
  ALISHA_ACTION_PRIORITY,
  DEFAULT_ALISHA_CONFIG,
  deriveAlishaState,
  enqueueAlishaAction,
  mergeAlishaConfig,
  pickClickReaction,
  pickIdleAction,
  randomBetween,
  recordRapidClick,
  SECTION_ACTIONS,
  shouldCountActiveTime,
  updateVisitStreak,
} from '../../utils/alishaBehavior';
import AlishaSprite from './AlishaSprite';
import './CatPet.css';

const PREFERENCES_KEY = 'daily-demo-alisha-preferences-v2';
const LEGACY_HIDDEN_KEY = 'daily-demo-alisha-hidden-v1';
const WELCOMED_KEY = 'daily-demo-alisha-welcomed-v2';
const VISITS_KEY = 'daily-demo-alisha-visits-v2';
const AFFECTION_KEY = 'daily-demo-alisha-affection-v2';
const STAR_KEY = 'daily-demo-alisha-star-v2';
const STAR_SESSION_KEY = 'daily-demo-alisha-star-session-v2';

const DEFAULT_PREFERENCES = Object.freeze({
  sound: false,
  paused: false,
  collapsed: false,
  hidden: false,
});

const ACTION_DURATION = Object.freeze({
  [ALISHA_ACTION.WELCOME]: 3200,
  [ALISHA_ACTION.HAPPY_HOP]: 1500,
  [ALISHA_ACTION.HEAD_TILT]: 1400,
  [ALISHA_ACTION.PAW]: 1600,
  [ALISHA_ACTION.PETTING]: 2300,
  [ALISHA_ACTION.EAR_LEFT]: 900,
  [ALISHA_ACTION.EAR_RIGHT]: 900,
  [ALISHA_ACTION.TAIL_TOUCHED]: 1700,
  [ALISHA_ACTION.ANNOYED]: 4200,
  [ALISHA_ACTION.YAWN]: 3200,
  [ALISHA_ACTION.GROOM]: 3600,
  [ALISHA_ACTION.DAYDREAM]: 3800,
  [ALISHA_ACTION.WAKE]: 2400,
  [ALISHA_ACTION.DAILY]: 3600,
  [ALISHA_ACTION.PHOTOGRAPHY]: 3400,
  [ALISHA_ACTION.TRAVEL]: 3800,
  [ALISHA_ACTION.STAR_GIFT]: 4200,
});

const ACTION_COPY = Object.freeze({
  [ALISHA_ACTION.WELCOME]: '你好，我是阿丽莎。',
  [ALISHA_ACTION.HAPPY_HOP]: '今天心情不错。',
  [ALISHA_ACTION.HEAD_TILT]: '嗯？你在看我吗？',
  [ALISHA_ACTION.PAW]: '给你一只软乎乎的爪子。',
  [ALISHA_ACTION.PETTING]: '这里……可以再摸一会儿。',
  [ALISHA_ACTION.EAR_LEFT]: '左边有声音。',
  [ALISHA_ACTION.EAR_RIGHT]: '右边有声音。',
  [ALISHA_ACTION.TAIL_TOUCHED]: '尾巴不能一直碰。',
  [ALISHA_ACTION.ANNOYED]: '够啦，我先躲一下。',
  [ALISHA_ACTION.YAWN]: '唔……有一点困。',
  [ALISHA_ACTION.DAYDREAM]: '在想一片很远的云。',
  [ALISHA_ACTION.WAKE]: '我醒了。',
  [ALISHA_ACTION.DAILY]: '今天也写下一点什么吧。',
  [ALISHA_ACTION.PHOTOGRAPHY]: '咔嚓，替你留住这一刻。',
  [ALISHA_ACTION.TRAVEL]: '下一站，会遇见什么呢？',
  [ALISHA_ACTION.STAR_GIFT]: '这颗星星，送给你。',
});

function readStorage(key, fallback = null, storage = 'localStorage') {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window[storage]?.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value, storage = 'localStorage') {
  if (typeof window === 'undefined') return;
  try {
    window[storage]?.setItem(key, String(value));
  } catch {
    // 存储被浏览器禁用时，阿丽莎仍能在当前页面正常运行。
  }
}

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(readStorage(key, 'null')) ?? fallback;
  } catch {
    return fallback;
  }
}

function readPreferences() {
  const stored = readJsonStorage(PREFERENCES_KEY, {});
  const legacyHidden = readStorage(LEGACY_HIDDEN_KEY, 'false') === 'true';
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    hidden: stored.hidden ?? legacyHidden,
  };
}

function actionDuration(action, config) {
  if (action === ALISHA_ACTION.WELCOME) return config.timings.welcomeMs;
  return ACTION_DURATION[action] || 2400;
}

function stopEvent(event) {
  event?.stopPropagation?.();
}

function Accessory({ action }) {
  if (action === ALISHA_ACTION.DAILY) {
    return (
      <span className="alisha-accessory is-diary" aria-hidden="true">
        <BookOpen />
        <i />
      </span>
    );
  }

  if (action === ALISHA_ACTION.PHOTOGRAPHY) {
    return (
      <span className="alisha-accessory is-camera" aria-hidden="true">
        <Camera />
        <i />
      </span>
    );
  }

  if (action === ALISHA_ACTION.TRAVEL) {
    return (
      <span className="alisha-accessory is-backpack" aria-hidden="true">
        <Backpack />
      </span>
    );
  }

  return null;
}

function playPurr(enabled) {
  if (!enabled || typeof window === 'undefined') return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  try {
    const context = new AudioContext();
    const gain = context.createGain();
    const low = context.createOscillator();
    const pulse = context.createOscillator();
    const now = context.currentTime;

    low.type = 'sine';
    pulse.type = 'triangle';
    low.frequency.setValueAtTime(72, now);
    pulse.frequency.setValueAtTime(25, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.024, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    low.connect(gain);
    pulse.connect(gain);
    gain.connect(context.destination);
    low.start(now);
    pulse.start(now);
    low.stop(now + 1.3);
    pulse.stop(now + 1.3);
    low.addEventListener('ended', () => context.close().catch(() => {}), { once: true });
  } catch {
    // 音频属于可选增强能力，失败不影响交互。
  }
}

export default function CatPet() {
  const stageRef = useRef(null);
  const actionRef = useRef(null);
  const actionQueueRef = useRef([]);
  const actionKeyRef = useRef(0);
  const clickTimesRef = useRef([]);
  const annoyedCooldownRef = useRef(0);
  const previousClickReactionRef = useRef(null);
  const previousIdleActionRef = useRef(null);
  const lastComplexActionRef = useRef(0);
  const lastActivityRef = useRef(0);
  const hiddenAtRef = useRef(null);
  const petHoldTimerRef = useRef(null);
  const petTriggeredRef = useRef(false);
  const configRef = useRef(DEFAULT_ALISHA_CONFIG);

  const [config, setConfig] = useState(DEFAULT_ALISHA_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [preferences, setPreferences] = useState(readPreferences);
  const [action, setAction] = useState(null);
  const [blinking, setBlinking] = useState(false);
  const [earFlick, setEarFlick] = useState('');
  const [tailMotion, setTailMotion] = useState('');
  const [observing, setObserving] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  );
  const [avoidingControls, setAvoidingControls] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [hasBow, setHasBow] = useState(false);
  const [hasStar, setHasStar] = useState(
    () => readStorage(STAR_KEY, 'false') === 'true'
  );
  const [affection, setAffection] = useState(
    () => Math.max(0, Number(readStorage(AFFECTION_KEY, '0')) || 0)
  );
  const [breathMs, setBreathMs] = useState(3800);

  const paused = preferences.paused || !pageVisible;
  const hidden = preferences.hidden;
  const collapsed = preferences.collapsed;

  const performAction = useCallback((name, options = {}) => {
    const currentConfig = configRef.current;
    if (!name || preferences.paused || preferences.hidden) return false;

    const next = {
      name,
      priority: options.priority ?? ALISHA_ACTION_PRIORITY[name] ?? 0,
      duration: options.duration ?? actionDuration(name, currentConfig),
      key: `${name}-${Date.now()}-${actionKeyRef.current += 1}`,
    };

    if (actionRef.current) {
      actionQueueRef.current = enqueueAlishaAction(actionQueueRef.current, next);
      return true;
    }

    actionRef.current = next;
    setAction(next);
    return true;
  }, [preferences.hidden, preferences.paused]);

  useEffect(() => {
    if (action) {
      const timer = window.setTimeout(() => {
        if (actionRef.current?.key !== action.key) return;
        actionRef.current = null;
        setAction(null);
      }, Math.max(300, action.duration));
      return () => window.clearTimeout(timer);
    }

    if (
      actionQueueRef.current.length &&
      !preferences.paused &&
      !preferences.hidden &&
      !sleeping
    ) {
      const next = actionQueueRef.current.shift();
      const timer = window.setTimeout(() => {
        actionRef.current = next;
        setAction(next);
      }, 90);
      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [action, preferences.hidden, preferences.paused, sleeping]);

  useEffect(() => {
    let cancelled = false;
    fetch('/alisha.config.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Alisha config unavailable');
        return response.json();
      })
      .then((runtimeConfig) => {
        if (cancelled) return;
        const merged = mergeAlishaConfig(DEFAULT_ALISHA_CONFIG, runtimeConfig);
        configRef.current = merged;
        setConfig(merged);
      })
      .catch(() => {
        configRef.current = DEFAULT_ALISHA_CONFIG;
      })
      .finally(() => {
        if (!cancelled) setConfigReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeStorage(PREFERENCES_KEY, JSON.stringify(preferences));
    writeStorage(LEGACY_HIDDEN_KEY, String(preferences.hidden));
  }, [preferences]);

  useEffect(() => {
    if (!configReady || !config.behaviors.easterEggs) return;
    const nextVisit = updateVisitStreak(readJsonStorage(VISITS_KEY, null));
    writeStorage(VISITS_KEY, JSON.stringify(nextVisit));
    const timer = window.setTimeout(() => setHasBow(nextVisit.streak >= 7), 0);
    return () => window.clearTimeout(timer);
  }, [config.behaviors.easterEggs, configReady]);

  useEffect(() => {
    if (
      !configReady ||
      hidden ||
      !config.behaviors.welcome ||
      readStorage(WELCOMED_KEY, 'false') === 'true'
    ) {
      return undefined;
    }

    writeStorage(WELCOMED_KEY, 'true');
    const timer = window.setTimeout(() => {
      performAction(ALISHA_ACTION.WELCOME);
    }, 560);
    return () => window.clearTimeout(timer);
  }, [config.behaviors.welcome, configReady, hidden, performAction]);

  useEffect(() => {
    if (hidden || !config.behaviors.autoAvoid) return undefined;
    const controls = document.querySelector('.memory-actions');
    if (!controls || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => setAvoidingControls(entry.isIntersecting),
      { threshold: 0.05 }
    );
    observer.observe(controls);
    return () => observer.disconnect();
  }, [config.behaviors.autoAvoid, hidden]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      setPageVisible(visible);

      if (!visible) {
        hiddenAtRef.current = Date.now();
        return;
      }

      const awayMs = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = null;
      lastActivityRef.current = Date.now();
      if (sleeping || awayMs >= configRef.current.timings.idleSleepMs) {
        setSleeping(false);
        performAction(ALISHA_ACTION.WAKE, {
          priority: ALISHA_ACTION_PRIORITY[ALISHA_ACTION.WAKE],
        });
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [performAction, sleeping]);

  useEffect(() => {
    if (hidden || paused || sleeping) return undefined;
    let blinkTimer;
    let blinkEndTimer;
    let disposed = false;

    const schedule = () => {
      blinkTimer = window.setTimeout(() => {
        if (disposed || document.hidden) return;
        setBlinking(true);
        blinkEndTimer = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 360);
      }, randomBetween(config.timings.blinkMinMs, config.timings.blinkMaxMs));
    };

    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkEndTimer);
      setBlinking(false);
    };
  }, [
    config.timings.blinkMaxMs,
    config.timings.blinkMinMs,
    hidden,
    paused,
    sleeping,
  ]);

  useEffect(() => {
    if (hidden || paused || sleeping) return undefined;
    let earTimer;
    let earEndTimer;
    let disposed = false;

    const schedule = () => {
      earTimer = window.setTimeout(() => {
        if (disposed || document.hidden) return;
        setEarFlick(Math.random() > 0.5 ? 'left' : 'right');
        earEndTimer = window.setTimeout(() => {
          setEarFlick('');
          schedule();
        }, randomBetween(440, 760));
      }, randomBetween(config.timings.earMinMs, config.timings.earMaxMs));
    };

    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(earTimer);
      window.clearTimeout(earEndTimer);
      setEarFlick('');
    };
  }, [
    config.timings.earMaxMs,
    config.timings.earMinMs,
    hidden,
    paused,
    sleeping,
  ]);

  useEffect(() => {
    if (hidden || paused || sleeping) return undefined;
    let tailTimer;
    let tailEndTimer;
    let disposed = false;

    const schedule = () => {
      tailTimer = window.setTimeout(() => {
        if (disposed || document.hidden) return;
        setTailMotion(Math.random() > 0.5 ? 'left' : 'right');
        tailEndTimer = window.setTimeout(() => {
          setTailMotion('');
          schedule();
        }, randomBetween(2200, 4600));
      }, randomBetween(config.timings.tailMinMs, config.timings.tailMaxMs));
    };

    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(tailTimer);
      window.clearTimeout(tailEndTimer);
      setTailMotion('');
    };
  }, [
    config.timings.tailMaxMs,
    config.timings.tailMinMs,
    hidden,
    paused,
    sleeping,
  ]);

  useEffect(() => {
    if (hidden || paused || sleeping) return undefined;
    const updateBreath = () => {
      setBreathMs(Math.round(randomBetween(3200, 4500)));
    };
    updateBreath();
    const timer = window.setInterval(updateBreath, 4500);
    return () => window.clearInterval(timer);
  }, [hidden, paused, sleeping]);

  useEffect(() => {
    if (
      hidden ||
      paused ||
      !config.behaviors.pointerGaze ||
      !stageRef.current
    ) {
      return undefined;
    }

    const stage = stageRef.current;
    let frame = null;
    let latestEvent = null;

    const resetGaze = () => {
      stage.style.setProperty('--eye-x', '0px');
      stage.style.setProperty('--eye-y', '0px');
      stage.style.setProperty('--head-x', '0px');
      stage.style.setProperty('--head-y', '0px');
      stage.style.setProperty('--head-tilt', '0deg');
      setObserving(false);
    };

    const renderGaze = () => {
      frame = null;
      if (!latestEvent) return;
      const rect = stage.getBoundingClientRect();
      const centerX = rect.left + rect.width * 0.51;
      const centerY = rect.top + rect.height * 0.34;
      const dx = latestEvent.clientX - centerX;
      const dy = latestEvent.clientY - centerY;
      const radius = 240;
      const distance = Math.hypot(dx, dy);

      if (distance > radius || latestEvent.pointerType === 'touch') {
        resetGaze();
        return;
      }

      const x = Math.max(-1, Math.min(1, dx / radius));
      const y = Math.max(-1, Math.min(1, dy / radius));
      stage.style.setProperty('--eye-x', `${x * 4.2}px`);
      stage.style.setProperty('--eye-y', `${y * 2.8}px`);
      stage.style.setProperty('--head-x', `${x * 2.4}px`);
      stage.style.setProperty('--head-y', `${y * 1.4}px`);
      stage.style.setProperty('--head-tilt', `${x * 2.6}deg`);
      setObserving(true);
    };

    const handlePointer = (event) => {
      latestEvent = event;
      if (frame === null) frame = window.requestAnimationFrame(renderGaze);
    };

    window.addEventListener('pointermove', handlePointer, { passive: true });
    return () => {
      window.removeEventListener('pointermove', handlePointer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      resetGaze();
    };
  }, [config.behaviors.pointerGaze, hidden, paused]);

  useEffect(() => {
    if (hidden || paused || !configReady) return undefined;
    lastActivityRef.current = Date.now();

    const markActivity = () => {
      lastActivityRef.current = Date.now();
      if (sleeping) {
        setSleeping(false);
        performAction(ALISHA_ACTION.WAKE);
      }
    };

    const events = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
    events.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });

    const timer = window.setInterval(() => {
      if (
        config.behaviors.sleep &&
        !actionRef.current &&
        document.visibilityState === 'visible' &&
        Date.now() - lastActivityRef.current >= config.timings.idleSleepMs
      ) {
        actionQueueRef.current = [];
        setSleeping(true);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
      events.forEach((eventName) => {
        window.removeEventListener(eventName, markActivity);
      });
    };
  }, [
    config.behaviors.sleep,
    config.timings.idleSleepMs,
    configReady,
    hidden,
    paused,
    performAction,
    sleeping,
  ]);

  useEffect(() => {
    if (hidden || paused || sleeping || !config.behaviors.idle) return undefined;
    let timer;
    let disposed = false;

    const schedule = () => {
      timer = window.setTimeout(() => {
        if (disposed || document.hidden) return;
        const now = Date.now();
        if (
          now - lastComplexActionRef.current >= config.timings.complexCooldownMs
        ) {
          const idleAction = pickIdleAction(previousIdleActionRef.current);
          if (performAction(idleAction)) {
            previousIdleActionRef.current = idleAction;
            lastComplexActionRef.current = now;
          }
        }
        schedule();
      }, randomBetween(config.timings.idleMinMs, config.timings.idleMaxMs));
    };

    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    config.behaviors.idle,
    config.timings.complexCooldownMs,
    config.timings.idleMaxMs,
    config.timings.idleMinMs,
    hidden,
    paused,
    performAction,
    sleeping,
  ]);

  useEffect(() => {
    if (
      hidden ||
      paused ||
      !config.behaviors.sectionSync ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return undefined;
    }

    const sections = Object.keys(SECTION_ACTIONS)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!sections.length) return undefined;

    const ratios = new Map();
    const seen = new Set();
    let currentSection = null;
    let dwellTimer = null;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        });
        const [bestId, bestRatio] = [...ratios.entries()].sort(
          (left, right) => right[1] - left[1]
        )[0] || [null, 0];
        const nextSection = bestRatio >= 0.28 ? bestId : null;
        if (nextSection === currentSection) return;
        currentSection = nextSection;
        window.clearTimeout(dwellTimer);
        if (!nextSection || seen.has(nextSection)) return;
        dwellTimer = window.setTimeout(() => {
          if (currentSection !== nextSection) return;
          if (performAction(SECTION_ACTIONS[nextSection])) {
            seen.add(nextSection);
          }
        }, config.timings.sectionDwellMs);
      },
      { threshold: [0, 0.28, 0.45, 0.65] }
    );

    sections.forEach((section) => observer.observe(section));
    return () => {
      window.clearTimeout(dwellTimer);
      observer.disconnect();
    };
  }, [
    config.behaviors.sectionSync,
    config.timings.sectionDwellMs,
    hidden,
    paused,
    performAction,
  ]);

  useEffect(() => {
    if (
      hidden ||
      paused ||
      !configReady ||
      !config.behaviors.easterEggs
    ) {
      return undefined;
    }

    let activeMs = 0;
    let lastTick = Date.now();
    let starSent =
      readStorage(STAR_SESSION_KEY, 'false', 'sessionStorage') === 'true';

    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(2000, now - lastTick);
      lastTick = now;
      if (
        !starSent &&
        shouldCountActiveTime({
          visible: document.visibilityState === 'visible',
          now,
          lastActivityAt: lastActivityRef.current,
          activeGraceMs: config.timings.activeGraceMs,
        })
      ) {
        activeMs += elapsed;
        if (activeMs >= config.timings.starActiveMs) {
          starSent = true;
          writeStorage(STAR_SESSION_KEY, 'true', 'sessionStorage');
          writeStorage(STAR_KEY, 'true');
          setHasStar(true);
          performAction(ALISHA_ACTION.STAR_GIFT);
        }
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    config.behaviors.easterEggs,
    config.timings.activeGraceMs,
    config.timings.starActiveMs,
    configReady,
    hidden,
    paused,
    performAction,
  ]);

  useEffect(
    () => () => {
      window.clearTimeout(petHoldTimerRef.current);
      actionQueueRef.current = [];
    },
    []
  );

  const cssVariables = useMemo(
    () => ({
      '--alisha-right': `${config.position.right}px`,
      '--alisha-bottom': `${config.position.bottom}px`,
      '--alisha-size-desktop': `${config.size.desktop}px`,
      '--alisha-size-tablet': `${config.size.tablet}px`,
      '--alisha-size-mobile': `${config.size.mobile}px`,
      '--alisha-breathe-ms': `${breathMs}ms`,
    }),
    [breathMs, config]
  );

  const updatePreferences = useCallback((patch) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const wakeBeforeInteraction = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (!sleeping) return false;
    setSleeping(false);
    performAction(ALISHA_ACTION.WAKE);
    return true;
  }, [performAction, sleeping]);

  const triggerBodyReaction = useCallback((event) => {
    stopEvent(event);
    if (wakeBeforeInteraction() || !configRef.current.behaviors.clickReaction) return;
    const now = Date.now();
    const rapid = recordRapidClick(clickTimesRef.current, now, {
      windowMs: configRef.current.timings.rapidClickWindowMs,
      threshold: configRef.current.timings.rapidClickCount,
    });
    clickTimesRef.current = rapid.clicks;

    if (
      rapid.triggered &&
      configRef.current.behaviors.annoyedReaction &&
      now >= annoyedCooldownRef.current
    ) {
      annoyedCooldownRef.current =
        now + configRef.current.timings.annoyedCooldownMs;
      performAction(ALISHA_ACTION.ANNOYED);
      return;
    }

    const reaction = pickClickReaction(previousClickReactionRef.current);
    previousClickReactionRef.current = reaction;
    performAction(reaction);
  }, [performAction, wakeBeforeInteraction]);

  const triggerSpecific = useCallback((name, event) => {
    stopEvent(event);
    if (wakeBeforeInteraction()) return;
    performAction(name);
  }, [performAction, wakeBeforeInteraction]);

  const triggerPetting = useCallback(() => {
    if (wakeBeforeInteraction()) return;
    setAffection((current) => {
      const next = current + 1;
      writeStorage(AFFECTION_KEY, next);
      return next;
    });
    performAction(ALISHA_ACTION.PETTING);
    playPurr(preferences.sound);
  }, [performAction, preferences.sound, wakeBeforeInteraction]);

  const handleHeadPointerDown = useCallback((event) => {
    stopEvent(event);
    petTriggeredRef.current = false;
    window.clearTimeout(petHoldTimerRef.current);
    petHoldTimerRef.current = window.setTimeout(() => {
      petTriggeredRef.current = true;
      triggerPetting();
    }, configRef.current.timings.petHoldMs);
  }, [triggerPetting]);

  const handleHeadPointerMove = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.buttons !== 1) return;
    lastActivityRef.current = Date.now();
  }, []);

  const handleHeadPointerUp = useCallback((event) => {
    stopEvent(event);
    window.clearTimeout(petHoldTimerRef.current);
  }, []);

  const handleHeadClick = useCallback((event) => {
    stopEvent(event);
    if (petTriggeredRef.current) {
      petTriggeredRef.current = false;
      return;
    }
    triggerSpecific(ALISHA_ACTION.HEAD_TILT, event);
  }, [triggerSpecific]);

  if (!config.enabled) return null;

  if (hidden) {
    return (
      <button
        type="button"
        className="cat-pet-restore"
        onClick={() => updatePreferences({ hidden: false, collapsed: false })}
        aria-label="显示页面宠物阿丽莎"
        title="叫阿丽莎回来"
        style={cssVariables}
      >
        <PawPrint size={19} aria-hidden="true" />
      </button>
    );
  }

  if (collapsed) {
    return (
      <aside className="cat-pet is-collapsed" style={cssVariables}>
        <button
          type="button"
          className="cat-pet-peek"
          onClick={() => updatePreferences({ collapsed: false })}
          aria-label="展开页面宠物阿丽莎"
          title="阿丽莎正在这里看着你"
        >
          <AlishaSprite interactive={false} hasBow={hasBow} hasStar={hasStar} />
        </button>
      </aside>
    );
  }

  const currentAction = action?.name || '';
  const state = deriveAlishaState({
    sleeping,
    observing,
    action: currentAction,
  });
  const message = ACTION_COPY[currentAction];
  const classes = [
    'cat-pet',
    avoidingControls && config.behaviors.autoAvoid ? 'is-avoiding-controls' : '',
    paused ? 'is-paused' : '',
    controlsOpen ? 'is-controls-open' : '',
  ].filter(Boolean).join(' ');
  const stageClasses = [
    'cat-pet-stage',
    `is-state-${state}`,
    currentAction ? `is-${currentAction}` : '',
    blinking ? 'is-blinking' : '',
    earFlick ? `is-ear-${earFlick}` : '',
    tailMotion ? `is-tail-${tailMotion}` : '',
  ].filter(Boolean).join(' ');

  return (
    <aside
      className={classes}
      aria-label={`页面宠物阿丽莎，亲密度 ${affection}`}
      style={cssVariables}
      data-alisha-state={state}
      data-alisha-action={currentAction || 'none'}
      data-alisha-blinking={blinking ? 'true' : 'false'}
      data-alisha-ear={earFlick || 'none'}
      data-alisha-tail={tailMotion || 'none'}
    >
      {config.behaviors.controls ? (
        <>
          <button
            type="button"
            className="cat-pet-control-toggle"
            onClick={() => setControlsOpen((current) => !current)}
            aria-label={controlsOpen ? '收起阿丽莎控制' : '展开阿丽莎控制'}
            aria-expanded={controlsOpen}
          >
            <Settings2 />
          </button>
          <div className="cat-pet-controls" aria-label="阿丽莎控制">
            <button
              type="button"
              onClick={() => updatePreferences({ sound: !preferences.sound })}
              aria-label={preferences.sound ? '关闭阿丽莎声音' : '开启阿丽莎声音'}
              aria-pressed={preferences.sound}
              title={preferences.sound ? '静音' : '开启声音'}
            >
              {preferences.sound ? <Volume2 /> : <VolumeX />}
            </button>
            <button
              type="button"
              onClick={() => updatePreferences({ paused: !preferences.paused })}
              aria-label={preferences.paused ? '继续阿丽莎动画' : '暂停阿丽莎动画'}
              aria-pressed={preferences.paused}
              title={preferences.paused ? '继续动画' : '暂停动画'}
            >
              {preferences.paused ? <Play /> : <Pause />}
            </button>
            <button
              type="button"
              onClick={() => updatePreferences({ collapsed: true })}
              aria-label="收起页面宠物阿丽莎"
              title="收起"
            >
              <ChevronDown />
            </button>
            <button
              type="button"
              onClick={() => updatePreferences({ hidden: true })}
              aria-label="隐藏页面宠物阿丽莎"
              title="关闭"
            >
              <EyeOff />
            </button>
          </div>
        </>
      ) : null}

      <div
        ref={stageRef}
        className={stageClasses}
        aria-live="polite"
      >
        <span className="cat-pet-character">
          <AlishaSprite
            hasBow={hasBow}
            hasStar={hasStar}
            onBodyClick={triggerBodyReaction}
            onHeadClick={handleHeadClick}
            onHeadPointerDown={handleHeadPointerDown}
            onHeadPointerMove={handleHeadPointerMove}
            onHeadPointerUp={handleHeadPointerUp}
            onLeftEarClick={(event) => triggerSpecific(ALISHA_ACTION.EAR_LEFT, event)}
            onRightEarClick={(event) => triggerSpecific(ALISHA_ACTION.EAR_RIGHT, event)}
            onTailClick={(event) => triggerSpecific(ALISHA_ACTION.TAIL_TOUCHED, event)}
          />
          <Accessory action={currentAction} />
        </span>

        {message ? (
          <span key={action.key} className="alisha-speech" role="status">
            {message}
          </span>
        ) : null}

        {preferences.paused ? (
          <span className="alisha-paused-indicator" aria-hidden="true">
            <Pause />
          </span>
        ) : null}
      </div>
    </aside>
  );
}
