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
  EyeOff,
  PawPrint,
  Star,
} from 'lucide-react';
import {
  ALISHA_ACTION,
  ALISHA_ACTION_PRIORITY,
  DEFAULT_ALISHA_CONFIG,
  mergeAlishaConfig,
  pickClickReaction,
  pickIdleAction,
  randomBetween,
  recordRapidClick,
  SECTION_ACTIONS,
  shouldCountActiveTime,
  updateVisitStreak,
} from '../../utils/alishaBehavior';
import './CatPet.css';

const HIDDEN_KEY = 'daily-demo-alisha-hidden-v1';
const WELCOMED_KEY = 'daily-demo-alisha-welcomed-v1';
const VISITS_KEY = 'daily-demo-alisha-visits-v1';
const STAR_KEY = 'daily-demo-alisha-star-v1';
const STAR_SESSION_KEY = 'daily-demo-alisha-star-session-v1';
const CAT_ASSET = '/images/alisha-pet-v2.png';

const ACTION_DURATION = Object.freeze({
  [ALISHA_ACTION.HAPPY_HOP]: 1500,
  [ALISHA_ACTION.SPIN]: 1750,
  [ALISHA_ACTION.TAIL_SHAKE]: 1600,
  [ALISHA_ACTION.ANNOYED]: 5600,
  [ALISHA_ACTION.YAWN]: 3200,
  [ALISHA_ACTION.GROOM]: 3400,
  [ALISHA_ACTION.DAYDREAM]: 3800,
  [ALISHA_ACTION.DAILY]: 3600,
  [ALISHA_ACTION.PHOTOGRAPHY]: 3400,
  [ALISHA_ACTION.TRAVEL]: 3800,
  [ALISHA_ACTION.STAR_GIFT]: 4200,
});

const ACTION_COPY = Object.freeze({
  [ALISHA_ACTION.WELCOME]: '你好呀，我是阿丽莎。',
  [ALISHA_ACTION.YAWN]: '唔……有一点困。',
  [ALISHA_ACTION.DAYDREAM]: '在想一片很远的云。',
  [ALISHA_ACTION.DAILY]: '今天也写下一点什么吧。',
  [ALISHA_ACTION.PHOTOGRAPHY]: '咔嚓，替你留住这一刻。',
  [ALISHA_ACTION.TRAVEL]: '下一站，会遇见什么呢？',
  [ALISHA_ACTION.STAR_GIFT]: '这颗星星，送给你。',
  [ALISHA_ACTION.ANNOYED]: '哼，我先躲一下。',
});

function readStorage(key, fallback = null, storage = 'localStorage') {
  try {
    const value = window?.[storage]?.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value, storage = 'localStorage') {
  try {
    window?.[storage]?.setItem(key, String(value));
  } catch {
    // 阿丽莎在隐私模式或禁用存储时仍可正常陪伴。
  }
}

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(readStorage(key, 'null')) || fallback;
  } catch {
    return fallback;
  }
}

function actionDuration(action, config) {
  if (action === ALISHA_ACTION.WELCOME) return config.timings.welcomeMs;
  return ACTION_DURATION[action] || 2400;
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

function CatPetFallback() {
  return (
    <svg
      className="cat-pet-fallback"
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <path
        d="M24 48 18 14l21 15c7-3 15-3 22 0l21-15-6 34c7 9 9 23 5 35-9 12-53 12-62 0-4-12-2-26 5-35Z"
        fill="#eee9df"
        stroke="#8b8277"
        strokeWidth="1.5"
      />
      <path d="m23 25-2-8 9 8Zm54 0 2-8-9 8Z" fill="#d8aaa3" />
      <ellipse cx="38" cy="46" rx="7" ry="6" fill="#b6a445" />
      <ellipse cx="62" cy="46" rx="7" ry="6" fill="#b6a445" />
      <path d="M38 41v10m24-10v10" stroke="#292723" strokeWidth="2" />
      <path d="m46 58 4-3 4 3-4 4Z" fill="#b86f64" />
      <path d="M44 31c2-7 4-11 6-15 2 4 4 8 6 15" fill="none" stroke="#888681" strokeWidth="2" />
    </svg>
  );
}

export default function CatPet() {
  const stageRef = useRef(null);
  const actionRef = useRef(null);
  const actionTimerRef = useRef(null);
  const clickTimesRef = useRef([]);
  const annoyedCooldownRef = useRef(0);
  const previousClickReactionRef = useRef(null);
  const previousIdleActionRef = useRef(null);
  const lastActivityRef = useRef(0);
  const configRef = useRef(DEFAULT_ALISHA_CONFIG);
  const [config, setConfig] = useState(DEFAULT_ALISHA_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [hidden, setHidden] = useState(
    () => readStorage(HIDDEN_KEY, 'false') === 'true'
  );
  const [assetFailed, setAssetFailed] = useState(false);
  const [action, setAction] = useState(null);
  const [blinking, setBlinking] = useState(false);
  const [earFlicking, setEarFlicking] = useState(false);
  const [avoidingControls, setAvoidingControls] = useState(false);
  const [hasBow, setHasBow] = useState(false);
  const [hasStar, setHasStar] = useState(
    () => readStorage(STAR_KEY, 'false') === 'true'
  );

  const performAction = useCallback((name, duration, priority) => {
    const nextPriority = priority ?? ALISHA_ACTION_PRIORITY[name] ?? 0;
    if (
      actionRef.current &&
      actionRef.current.priority > nextPriority
    ) {
      return false;
    }

    if (actionTimerRef.current) window.clearTimeout(actionTimerRef.current);
    const nextAction = {
      name,
      priority: nextPriority,
      key: `${name}-${Date.now()}`,
    };
    actionRef.current = nextAction;
    setAction(nextAction);

    actionTimerRef.current = window.setTimeout(() => {
      if (actionRef.current?.key !== nextAction.key) return;
      actionRef.current = null;
      setAction(null);
    }, Math.max(300, duration));
    return true;
  }, []);

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
      performAction(
        ALISHA_ACTION.WELCOME,
        actionDuration(ALISHA_ACTION.WELCOME, config),
        ALISHA_ACTION_PRIORITY[ALISHA_ACTION.WELCOME]
      );
    }, 420);
    return () => window.clearTimeout(timer);
  }, [config, configReady, hidden, performAction]);

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
    if (hidden) return undefined;
    let blinkTimer;
    let blinkEndTimer;
    let earTimer;
    let earEndTimer;
    let disposed = false;

    const scheduleBlink = () => {
      blinkTimer = window.setTimeout(() => {
        if (disposed || document.hidden) {
          scheduleBlink();
          return;
        }
        setBlinking(true);
        blinkEndTimer = window.setTimeout(() => {
          setBlinking(false);
          scheduleBlink();
        }, 210);
      }, randomBetween(2800, 6400));
    };

    const scheduleEar = () => {
      earTimer = window.setTimeout(() => {
        if (!disposed && !document.hidden) {
          setEarFlicking(true);
          earEndTimer = window.setTimeout(() => setEarFlicking(false), 520);
        }
        scheduleEar();
      }, randomBetween(7200, 14800));
    };

    scheduleBlink();
    scheduleEar();
    return () => {
      disposed = true;
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkEndTimer);
      window.clearTimeout(earTimer);
      window.clearTimeout(earEndTimer);
    };
  }, [hidden]);

  useEffect(() => {
    if (
      hidden ||
      !config.behaviors.pointerGaze ||
      !stageRef.current
    ) {
      return undefined;
    }

    const stage = stageRef.current;
    let frame = null;
    let latestEvent = null;
    const resetEyes = () => {
      stage.style.setProperty('--gaze-x', '0px');
      stage.style.setProperty('--gaze-y', '0px');
      stage.style.setProperty('--face-tilt', '0deg');
    };
    const renderGaze = () => {
      frame = null;
      if (!latestEvent) return;
      const rect = stage.getBoundingClientRect();
      const centerX = rect.left + rect.width * 0.49;
      const centerY = rect.top + rect.height * 0.31;
      const dx = latestEvent.clientX - centerX;
      const dy = latestEvent.clientY - centerY;
      const radius = Math.max(260, window.innerWidth * 0.24);
      const distance = Math.hypot(dx, dy);
      if (distance > radius || latestEvent.pointerType === 'touch') {
        resetEyes();
        return;
      }
      const x = Math.max(-1, Math.min(1, dx / radius));
      const y = Math.max(-1, Math.min(1, dy / radius));
      stage.style.setProperty('--gaze-x', `${x * 1.5}px`);
      stage.style.setProperty('--gaze-y', `${y * 1.05}px`);
      stage.style.setProperty('--face-tilt', `${x * 1.1}deg`);
    };
    const handlePointer = (event) => {
      latestEvent = event;
      if (frame === null) frame = window.requestAnimationFrame(renderGaze);
    };

    window.addEventListener('pointermove', handlePointer, { passive: true });
    return () => {
      window.removeEventListener('pointermove', handlePointer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      resetEyes();
    };
  }, [config.behaviors.pointerGaze, hidden]);

  useEffect(() => {
    if (hidden || !configReady) return undefined;
    lastActivityRef.current = Date.now();
    let idleAt =
      Date.now() +
      randomBetween(config.timings.idleMinMs, config.timings.idleMaxMs);
    let activeMs = 0;
    let lastTick = Date.now();
    let starSentThisSession =
      readStorage(STAR_SESSION_KEY, 'false', 'sessionStorage') === 'true';

    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      idleAt =
        now +
        randomBetween(config.timings.idleMinMs, config.timings.idleMaxMs);
    };

    const interval = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(2000, now - lastTick);
      lastTick = now;

      if (
        config.behaviors.easterEggs &&
        !starSentThisSession &&
        shouldCountActiveTime({
          visible: document.visibilityState === 'visible',
          now,
          lastActivityAt: lastActivityRef.current,
          activeGraceMs: config.timings.activeGraceMs,
        })
      ) {
        activeMs += elapsed;
        if (activeMs >= config.timings.starActiveMs) {
          starSentThisSession = true;
          writeStorage(STAR_SESSION_KEY, 'true', 'sessionStorage');
          writeStorage(STAR_KEY, 'true');
          setHasStar(true);
          performAction(
            ALISHA_ACTION.STAR_GIFT,
            actionDuration(ALISHA_ACTION.STAR_GIFT, config)
          );
        }
      }

      if (
        config.behaviors.idle &&
        document.visibilityState === 'visible' &&
        now >= idleAt
      ) {
        const idleAction = pickIdleAction(previousIdleActionRef.current);
        if (
          performAction(
            idleAction,
            actionDuration(idleAction, config),
            ALISHA_ACTION_PRIORITY[idleAction]
          )
        ) {
          previousIdleActionRef.current = idleAction;
        }
        idleAt =
          now +
          randomBetween(config.timings.idleMinMs, config.timings.idleMaxMs);
      }
    }, 1000);

    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, markActivity, { passive: true });
    });

    return () => {
      window.clearInterval(interval);
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, markActivity);
      });
    };
  }, [config, configReady, hidden, performAction]);

  useEffect(() => {
    if (
      hidden ||
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

    const scheduleSectionAction = (id) => {
      window.clearTimeout(dwellTimer);
      const attempt = () => {
        if (currentSection !== id || seen.has(id)) return;
        const sectionAction = SECTION_ACTIONS[id];
        if (
          performAction(
            sectionAction,
            actionDuration(sectionAction, config),
            ALISHA_ACTION_PRIORITY[sectionAction]
          )
        ) {
          seen.add(id);
          return;
        }
        dwellTimer = window.setTimeout(attempt, 900);
      };
      dwellTimer = window.setTimeout(attempt, config.timings.sectionDwellMs);
    };

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
        if (nextSection && !seen.has(nextSection)) scheduleSectionAction(nextSection);
      },
      { threshold: [0, 0.28, 0.45, 0.65] }
    );

    sections.forEach((section) => observer.observe(section));
    return () => {
      window.clearTimeout(dwellTimer);
      observer.disconnect();
    };
  }, [config, hidden, performAction]);

  useEffect(
    () => () => {
      if (actionTimerRef.current) window.clearTimeout(actionTimerRef.current);
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
    }),
    [config]
  );

  const changeVisibility = (nextHidden) => {
    writeStorage(HIDDEN_KEY, String(nextHidden));
    setHidden(nextHidden);
  };

  const interact = () => {
    const currentConfig = configRef.current;
    lastActivityRef.current = Date.now();
    if (!currentConfig.behaviors.clickReaction) return;

    const now = Date.now();
    const rapid = recordRapidClick(clickTimesRef.current, now, {
      windowMs: currentConfig.timings.rapidClickWindowMs,
      threshold: currentConfig.timings.rapidClickCount,
    });
    clickTimesRef.current = rapid.clicks;

    if (
      rapid.triggered &&
      currentConfig.behaviors.annoyedReaction &&
      now >= annoyedCooldownRef.current
    ) {
      annoyedCooldownRef.current = now + currentConfig.timings.annoyedCooldownMs;
      performAction(
        ALISHA_ACTION.ANNOYED,
        actionDuration(ALISHA_ACTION.ANNOYED, currentConfig),
        ALISHA_ACTION_PRIORITY[ALISHA_ACTION.ANNOYED]
      );
      return;
    }

    if (actionRef.current?.name === ALISHA_ACTION.ANNOYED) return;
    const reaction = pickClickReaction(previousClickReactionRef.current);
    previousClickReactionRef.current = reaction;
    performAction(
      reaction,
      actionDuration(reaction, currentConfig),
      ALISHA_ACTION_PRIORITY[reaction]
    );
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    interact();
  };

  if (!config.enabled) return null;

  if (hidden) {
    return (
      <button
        type="button"
        className="cat-pet-restore"
        onClick={() => changeVisibility(false)}
        aria-label="显示页面宠物阿丽莎"
        title="叫阿丽莎回来"
        style={cssVariables}
      >
        <PawPrint size={17} aria-hidden="true" />
      </button>
    );
  }

  const currentAction = action?.name || '';
  const message = ACTION_COPY[currentAction];

  return (
    <aside
      className={`cat-pet${
        avoidingControls && config.behaviors.autoAvoid
          ? ' is-avoiding-controls'
          : ''
      }`}
      aria-label="页面宠物阿丽莎"
      style={cssVariables}
    >
      <button
        type="button"
        className="cat-pet-hide"
        onClick={() => changeVisibility(true)}
        aria-label="隐藏页面宠物阿丽莎"
        title="让阿丽莎休息"
      >
        <EyeOff size={13} aria-hidden="true" />
      </button>

      <div
        ref={stageRef}
        className={[
          'cat-pet-stage',
          currentAction ? `is-${currentAction}` : '',
          blinking ? 'is-blinking' : '',
          earFlicking ? 'is-ear-flicking' : '',
          hasBow ? 'has-bow' : '',
          hasStar ? 'has-star' : '',
        ].filter(Boolean).join(' ')}
        role="button"
        tabIndex={0}
        aria-label="银白猫阿丽莎，点击和她互动"
        title="摸摸阿丽莎"
        onClick={interact}
        onKeyDown={handleKeyDown}
      >
        <span className="cat-pet-character" aria-hidden="true">
          {assetFailed ? (
            <CatPetFallback />
          ) : (
            <>
              <img
                className="cat-pet-art"
                src={CAT_ASSET}
                alt=""
                draggable="false"
                onError={() => setAssetFailed(true)}
              />
              <img
                className="cat-pet-tail-layer"
                src={CAT_ASSET}
                alt=""
                draggable="false"
              />
              <img
                className="cat-pet-ear-layer"
                src={CAT_ASSET}
                alt=""
                draggable="false"
              />
              <span className="cat-pet-pupil is-left" />
              <span className="cat-pet-pupil is-right" />
              <span className="cat-pet-eyelid is-left" />
              <span className="cat-pet-eyelid is-right" />
            </>
          )}

          <span className="cat-pet-paw" />
          {hasBow ? (
            <span className="alisha-bow" aria-hidden="true">
              <i />
              <i />
              <b />
            </span>
          ) : null}
          {hasStar ? (
            <span className="alisha-keepsake-star" aria-hidden="true">
              <Star />
            </span>
          ) : null}
          <Accessory action={currentAction} />
        </span>

        <span className="cat-pet-ground" aria-hidden="true" />
        <span className="alisha-expression" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {message ? (
          <span key={action.key} className="alisha-speech" role="status">
            {message}
          </span>
        ) : null}
      </div>
    </aside>
  );
}
