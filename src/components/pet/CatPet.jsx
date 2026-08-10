import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EyeOff, PawPrint } from 'lucide-react';
import {
  DEFAULT_ALISHA_CONFIG,
  mergeAlishaConfig,
} from '../../utils/alishaBehavior';
import StableVideoPetPlayer from './StableVideoPetPlayer';
import {
  VIDEO_PET_ACTIONS,
  chooseVideoPetReaction,
  completeVideoPetAction,
  createVideoPetBehavior,
  createVideoPetController,
  createVideoPetRuntimeConfig,
  decayVideoPetBehavior,
  recordVideoPetAction,
  registerVideoPetActivity,
  requestVideoPetAction,
  requestVideoPetSleep,
  resolveVideoPetSpeech,
  scheduleVideoPetAmbient,
  selectVideoPetAmbient,
  selectVideoPetRecovery,
  shouldVideoPetSleep,
} from './videoPetRuntime';
import { resolvePetDock } from '../../utils/petDocking';
import './CatPet.css';

const HIDDEN_KEY = 'daily-demo-alisha-hidden-v1';
const POSITION_KEY = 'daily-demo-alisha-video-position-v3';
const WELCOMED_KEY = 'daily-demo-alisha-video-welcomed-v1';
const AFFINITY_KEY = 'daily-demo-alisha-video-affinity-v1';
const BASE_ASSET = '/videos/alisha/base-image.jpg';
const SECTION_IDS = [
  'about',
  'daily',
  'reading',
  'travel',
  'photography',
  'song',
];

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
    // 隐私模式或禁用存储时，宠物仍可在当前页面运行。
  }
}

function readStoredPosition() {
  try {
    return JSON.parse(readStorage(POSITION_KEY, 'null'));
  } catch {
    return null;
  }
}

function StaticFallback() {
  return (
    <img
      className="cat-video-pet-fallback"
      src="/images/alisha-pet-v2.png"
      alt=""
      draggable="false"
    />
  );
}

export default function CatPet({ suspended = false }) {
  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const baseImageRef = useRef(null);
  const videoARef = useRef(null);
  const videoBRef = useRef(null);
  const controllerRef = useRef(createVideoPetController());
  const behaviorRef = useRef(null);
  const contextRef = useRef('about');
  const reactionRef = useRef(() => {});
  const pointerSessionRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const tapTimerRef = useRef(null);
  const tapCountRef = useRef(0);
  const speechTimerRef = useRef(null);
  const speechClearTimerRef = useRef(null);
  const lastSpeechAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastSpeechActionRef = useRef(null);
  const particleTimerRef = useRef(null);
  const [config, setConfig] = useState(DEFAULT_ALISHA_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [hidden, setHidden] = useState(
    () => readStorage(HIDDEN_KEY, 'false') === 'true'
  );
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [action, setAction] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [particle, setParticle] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [avoidingControls, setAvoidingControls] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [dockSide, setDockSide] = useState('right');
  const [dockBottom, setDockBottom] = useState(8);

  useEffect(() => {
    let cancelled = false;
    fetch('/alisha.config.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Alisha config unavailable');
        return response.json();
      })
      .then((runtimeConfig) => {
        if (!cancelled) {
          setConfig(
            mergeAlishaConfig(DEFAULT_ALISHA_CONFIG, runtimeConfig)
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setConfigReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hidden || !config.behaviors.autoAvoid) {
      const resetFrame = window.requestAnimationFrame(() => {
        setAvoidingControls(false);
        setScrolling(false);
        setDockSide('right');
        setDockBottom(8);
      });
      return () => window.cancelAnimationFrame(resetFrame);
    }

    const mobileQuery = window.matchMedia('(max-width: 700px)');
    let frame = null;
    let scrollStopTimer = null;

    const measureDock = () => {
      frame = null;
      if (!mobileQuery.matches) {
        setAvoidingControls(false);
        setDockSide('right');
        setDockBottom(8);
        return;
      }

      const obstacles = Array.from(
        document.querySelectorAll('[data-pet-avoid]')
      )
        .map((element) => element.getBoundingClientRect())
        .filter(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight
        );
      const decision = resolvePetDock({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        fullSize: config.size.mobile * 1.45,
        compactSize: 56,
        sideInset: 8,
        bottomInset: 8,
        obstacles,
      });
      setDockSide(decision.dock);
      setAvoidingControls(decision.compact);
      setDockBottom(decision.bottomOffset);
    };

    const requestMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measureDock);
    };

    const handleViewportScroll = () => {
      setScrolling(true);
      window.clearTimeout(scrollStopTimer);
      scrollStopTimer = window.setTimeout(() => {
        setScrolling(false);
        requestMeasure();
      }, 800);
      requestMeasure();
    };

    requestMeasure();
    window.addEventListener('scroll', handleViewportScroll, {
      passive: true,
    });
    window.addEventListener('resize', requestMeasure);
    mobileQuery.addEventListener?.('change', requestMeasure);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(scrollStopTimer);
      window.removeEventListener('scroll', handleViewportScroll);
      window.removeEventListener('resize', requestMeasure);
      mobileQuery.removeEventListener?.('change', requestMeasure);
    };
  }, [config.behaviors.autoAvoid, config.size.mobile, hidden]);

  useEffect(() => {
    if (
      hidden ||
      suspended ||
      !configReady ||
      !canvasRef.current ||
      !baseImageRef.current ||
      !videoARef.current ||
      !videoBRef.current
    ) {
      return undefined;
    }

    let disposed = false;
    let behaviorTimer = null;
    let scrollTimer = null;
    let proximityTimer = null;
    let proximityCooldownUntil = 0;
    let lastTickAt = performance.now();
    let lastScrollY = window.scrollY;
    let hiddenAt = null;
    let welcomeTimer = null;
    const reducedMotion =
      config.motion.respectReducedMotion &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isMobile = window.matchMedia('(max-width: 700px)').matches;
    const now = () => performance.now();
    const runtimeConfig = createVideoPetRuntimeConfig(config.timings);
    const unavailableActions = new Set();

    controllerRef.current = createVideoPetController();
    behaviorRef.current = createVideoPetBehavior({
      now: now(),
      affinity: readStorage(AFFINITY_KEY, '0'),
      config: runtimeConfig,
    });

    const dismissSpeech = (immediate = false) => {
      window.clearTimeout(speechTimerRef.current);
      window.clearTimeout(speechClearTimerRef.current);
      if (immediate) {
        setSpeech(null);
        return;
      }
      setSpeech((current) =>
        current ? { ...current, leaving: true } : null
      );
      speechClearTimerRef.current = window.setTimeout(
        () => setSpeech(null),
        220
      );
    };

    const showSpeech = (
      message,
      duration = 2_100,
      tone = 'direct',
      speechAction = 'system'
    ) => {
      window.clearTimeout(speechTimerRef.current);
      window.clearTimeout(speechClearTimerRef.current);
      if (!message) {
        dismissSpeech();
        return;
      }
      lastSpeechAtRef.current = now();
      lastSpeechActionRef.current = speechAction;
      setSpeech({
        message,
        tone,
        leaving: false,
        key: Date.now(),
      });
      speechTimerRef.current = window.setTimeout(
        () => dismissSpeech(),
        duration
      );
    };

    const showParticle = (symbol) => {
      window.clearTimeout(particleTimerRef.current);
      setParticle({ symbol, key: Date.now() });
      particleTimerRef.current = window.setTimeout(
        () => setParticle(null),
        1_500
      );
    };

    const finishCurrentAction = (finishedAction = null) => {
      if (
        finishedAction &&
        controllerRef.current.current?.action !== finishedAction
      ) {
        return;
      }
      const result = completeVideoPetAction(controllerRef.current);
      controllerRef.current = result.controller;
      window.setTimeout(
        () => runCommand(result.command),
        result.command?.type === 'play' ? 180 : 0
      );
    };

    const recoverFromPlaybackFailure = (
      actionKey,
      playbackResult = {}
    ) => {
      if (
        disposed ||
        !actionKey ||
        controllerRef.current.current?.action !== actionKey
      ) {
        return;
      }
      unavailableActions.add(actionKey);
      console.warn('[Alisha] action disabled for this session', {
        action: actionKey,
        sources: playbackResult.attemptedSources ?? [],
        error: playbackResult.error?.message ?? 'media error',
      });

      const replacement = selectVideoPetRecovery({
        failedAction: actionKey,
        unavailableActions,
      });
      if (!replacement) {
        finishCurrentAction(actionKey);
        return;
      }

      const failedRequest = controllerRef.current.current;
      controllerRef.current = {
        ...controllerRef.current,
        current: {
          ...failedRequest,
          action: replacement,
          requestedAt: now(),
        },
      };
      runCommand({ type: 'play', action: replacement });
    };

    const player = new StableVideoPetPlayer({
      canvas: canvasRef.current,
      videos: [videoARef.current, videoBRef.current],
      baseImage: baseImageRef.current,
      threshold: config.render.chromaTolerance,
      onEnded: finishCurrentAction,
      onError: (error, details = {}) => {
        recoverFromPlaybackFailure(details.actionKey, {
          error,
          attemptedSources: details.source ? [details.source] : [],
        });
      },
    });

    async function runCommand(command) {
      if (disposed || !command) return;
      if (command.type === 'base') {
        player.drawBase();
        setAction(null);
        return;
      }
      const actionKey = command.action;
      const actionConfig = VIDEO_PET_ACTIONS[actionKey];
      const actionSource =
        controllerRef.current.current?.source ?? 'ambient';
      const playbackResult = await player.play(actionKey, actionConfig);
      if (disposed || playbackResult.status === 'superseded') return;
      if (playbackResult.status === 'failed') {
        recoverFromPlaybackFailure(actionKey, playbackResult);
        return;
      }

      behaviorRef.current = recordVideoPetAction(
        behaviorRef.current,
        actionKey,
        now(),
        runtimeConfig
      );
      setAction(actionKey);
      if (actionKey === 'sleep') {
        dismissSpeech();
      } else {
        const speechDecision = resolveVideoPetSpeech({
          actionKey,
          source: actionSource,
          now: now(),
          lastSpokenAt: lastSpeechAtRef.current,
          lastSpeechAction: lastSpeechActionRef.current,
          config: runtimeConfig,
        });
        if (speechDecision) {
          showSpeech(
            speechDecision.message,
            speechDecision.duration,
            speechDecision.tone,
            actionKey
          );
        }
      }
      if (actionKey === 'happy') showParticle('♥');
      if (actionKey === 'annoyed') showParticle('…');
      const queued = controllerRef.current.queue[0]?.action;
      if (queued) {
        player.preload(queued, VIDEO_PET_ACTIONS[queued]);
      }
    }

    const enqueue = (
      actionKey,
      source = 'ambient',
      canWake = false
    ) => {
      if (!actionKey || !VIDEO_PET_ACTIONS[actionKey]) return false;
      if (unavailableActions.has(actionKey)) {
        const replacement = selectVideoPetRecovery({
          failedAction: actionKey,
          unavailableActions,
        });
        return replacement
          ? enqueue(replacement, source, canWake)
          : false;
      }
      const result = requestVideoPetAction(controllerRef.current, {
        action: actionKey,
        source,
        requestedAt: now(),
        canWake,
      });
      controllerRef.current = result.controller;
      runCommand(result.command);
      if (result.accepted && !result.command) {
        const queuedAction = result.controller.queue[0]?.action;
        if (queuedAction) {
          player.preload(
            queuedAction,
            VIDEO_PET_ACTIONS[queuedAction]
          );
        }
      }
      return result.accepted;
    };

    const register = (type) => {
      behaviorRef.current = registerVideoPetActivity(
        behaviorRef.current,
        { type, now: now(), config: runtimeConfig }
      );
    };

    const reactTo = (event, count = 1) => {
      if (
        ['tap', 'longpress', 'drop'].includes(event) &&
        !config.behaviors.clickReaction
      ) {
        return;
      }
      register(
        event === 'tap' || event === 'longpress' || event === 'drop'
          ? event
          : 'keyboard'
      );
      const reactionCount =
        count >= 5 && !config.behaviors.annoyedReaction ? 2 : count;
      const selected = chooseVideoPetReaction({
        event,
        count: reactionCount,
        state: behaviorRef.current,
        now: now(),
      });
      enqueue(
        selected,
        reactionCount >= 5 ? 'urgent' : 'direct',
        true
      );
    };

    reactionRef.current = reactTo;

    const requestSleep = () => {
      const result = requestVideoPetSleep(
        controllerRef.current,
        now(),
        { force: true }
      );
      controllerRef.current = result.controller;
      if (result.accepted) runCommand(result.command);
    };

    const behaviorTick = () => {
      const timestamp = now();
      behaviorRef.current = decayVideoPetBehavior(
        behaviorRef.current,
        timestamp - lastTickAt
      );
      lastTickAt = timestamp;
      if (
        document.hidden ||
        !config.behaviors.idle
      ) {
        return;
      }
      const currentAction =
        controllerRef.current.current?.action ?? null;
      if (
        shouldVideoPetSleep({
          state: behaviorRef.current,
          now: timestamp,
          currentAction,
        })
      ) {
        requestSleep();
        return;
      }
      if (
        currentAction === 'sleep' ||
        timestamp < behaviorRef.current.nextAmbientAt
      ) {
        return;
      }
      const selected = selectVideoPetAmbient({
        state: behaviorRef.current,
        now: timestamp,
        context: contextRef.current,
        isMobile,
        hour: new Date().getHours(),
        config: runtimeConfig,
        unavailableActions,
        reducedMotion,
      });
      let accepted = false;
      if (selected) {
        accepted = enqueue(selected, 'ambient');
      }
      behaviorRef.current = scheduleVideoPetAmbient(
        behaviorRef.current,
        timestamp,
        Math.random,
        runtimeConfig
      );
      if (!accepted && selected) {
        player.preload(selected, VIDEO_PET_ACTIONS[selected]);
      }
    };

    const contextObserver =
      !config.behaviors.sectionSync ||
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              const visible = entries
                .filter((entry) => entry.isIntersecting)
                .sort(
                  (left, right) =>
                    right.intersectionRatio - left.intersectionRatio
                )[0];
              if (visible?.target.id) {
                contextRef.current = visible.target.id;
              }
            },
            { threshold: [0.3, 0.5, 0.7] }
          );

    SECTION_IDS.forEach((id) => {
      const section = document.getElementById(id);
      if (section) contextObserver?.observe(section);
    });

    const handlePointerProximity = (event) => {
      if (
        pointerSessionRef.current ||
        event.pointerType === 'touch' ||
        !config.behaviors.pointerGaze
      ) {
        return;
      }
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const nearby =
        Math.hypot(event.clientX - centerX, event.clientY - centerY) <
        180;
      if (!nearby) {
        window.clearTimeout(proximityTimer);
        proximityTimer = null;
        return;
      }
      if (controllerRef.current.current?.action === 'sleep') {
        window.clearTimeout(proximityTimer);
        proximityTimer = null;
        proximityCooldownUntil = now() + 2_000;
        register('pointerNearby');
        enqueue('wake', 'direct', true);
        return;
      }
      if (proximityTimer || now() < proximityCooldownUntil) return;
      proximityTimer = window.setTimeout(() => {
        proximityTimer = null;
        proximityCooldownUntil = now() + 20_000;
        register('pointerNearby');
        if (controllerRef.current.current?.action === 'sleep') {
          enqueue('wake', 'direct', true);
          return;
        }
        const selected = chooseVideoPetReaction({
          event: 'proximity',
          state: behaviorRef.current,
          now: now(),
        });
        enqueue(selected, 'context');
      }, 800);
    };

    const handleScroll = () => {
      const direction = window.scrollY >= lastScrollY ? 'down' : 'up';
      lastScrollY = window.scrollY;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        behaviorRef.current = registerVideoPetActivity(
          behaviorRef.current,
          {
            type: 'scrollStop',
            now: now(),
            config: runtimeConfig,
          }
        );
        const selected = chooseVideoPetReaction({
          event: 'scrollStop',
          state: behaviorRef.current,
          now: now(),
          scrollDirection: direction,
        });
        enqueue(selected, 'context');
      }, 600);
    };

    const applyStoredPosition = () => {
      const container = containerRef.current;
      if (!container) return;
      if (window.matchMedia('(max-width: 700px)').matches) {
        container.style.removeProperty('left');
        container.style.removeProperty('top');
        container.style.removeProperty('right');
        container.style.removeProperty('bottom');
        return;
      }
      const stored = readStoredPosition();
      if (
        !stored ||
        typeof stored.x !== 'number' ||
        typeof stored.y !== 'number'
      ) {
        return;
      }
      const rect = container.getBoundingClientRect();
      container.style.left = `${Math.min(
        Math.max(4, stored.x),
        window.innerWidth - rect.width - 4
      )}px`;
      container.style.top = `${Math.min(
        Math.max(62, stored.y),
        window.innerHeight - rect.height - 4
      )}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    };

    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        player.pause();
        return;
      }
      const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      player.resume();
      if (hiddenFor > runtimeConfig.sleepDelay.min) {
        requestSleep();
      }
    };

    window.addEventListener('pointermove', handlePointerProximity, {
      passive: true,
    });
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', applyStoredPosition);
    document.addEventListener('visibilitychange', handleVisibility);
    behaviorTimer = window.setInterval(behaviorTick, 200);

    player
      .initialize()
      .then(() => {
        if (disposed) return;
        setReady(true);
        applyStoredPosition();
        if (
          config.behaviors.welcome &&
          readStorage(WELCOMED_KEY, 'false', 'sessionStorage') !==
            'true'
        ) {
          writeStorage(
            WELCOMED_KEY,
            'true',
            'sessionStorage'
          );
          showSpeech(
            '你来啦，我先看看这里。',
            2_800,
            'direct',
            'welcome'
          );
          welcomeTimer = window.setTimeout(
            () => enqueue(Math.random() < 0.6 ? 'observe' : 'happy', 'context'),
            650
          );
        }
      })
      .catch(() => {
        if (!disposed) {
          setFailed(true);
          setReady(true);
        }
      });

    return () => {
      disposed = true;
      window.clearInterval(behaviorTimer);
      window.clearTimeout(scrollTimer);
      window.clearTimeout(proximityTimer);
      window.clearTimeout(welcomeTimer);
      window.clearTimeout(speechTimerRef.current);
      window.clearTimeout(speechClearTimerRef.current);
      window.clearTimeout(particleTimerRef.current);
      window.removeEventListener(
        'pointermove',
        handlePointerProximity
      );
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', applyStoredPosition);
      document.removeEventListener(
        'visibilitychange',
        handleVisibility
      );
      contextObserver?.disconnect();
      writeStorage(
        AFFINITY_KEY,
        Math.round(behaviorRef.current?.affinity ?? 0)
      );
      reactionRef.current = () => {};
      player.destroy();
    };
  }, [config, configReady, hidden, suspended]);

  useEffect(
    () => () => {
      window.clearTimeout(longPressTimerRef.current);
      window.clearTimeout(tapTimerRef.current);
    },
    []
  );

  const cssVariables = useMemo(
    () => ({
      '--alisha-right': `${config.position.right}px`,
      '--alisha-bottom': `${config.position.bottom}px`,
      '--alisha-size-desktop': `${config.size.desktop * 2.35}px`,
      '--alisha-size-tablet': `${config.size.tablet * 2.2}px`,
      '--alisha-size-mobile': `${config.size.mobile * 1.45}px`,
      '--alisha-dock-bottom': `${dockBottom}px`,
    }),
    [config, dockBottom]
  );

  const changeVisibility = (nextHidden) => {
    writeStorage(HIDDEN_KEY, String(nextHidden));
    setHidden(nextHidden);
  };

  const resolveTapBurst = () => {
    const count = tapCountRef.current;
    tapCountRef.current = 0;
    reactionRef.current('tap', count);
  };

  const queueTap = () => {
    tapCountRef.current += 1;
    window.clearTimeout(tapTimerRef.current);
    tapTimerRef.current = window.setTimeout(resolveTapBurst, 430);
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 || !ready) return;
    const rect = containerRef.current.getBoundingClientRect();
    pointerSessionRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      dragging: false,
      longPressed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    longPressTimerRef.current = window.setTimeout(() => {
      if (!pointerSessionRef.current?.dragging) {
        pointerSessionRef.current.longPressed = true;
        reactionRef.current('longpress');
        navigator.vibrate?.(16);
      }
    }, 550);
  };

  const handlePointerMove = (event) => {
    const session = pointerSessionRef.current;
    if (!session || session.id !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY
    );
    if (distance > 9 && !session.dragging) {
      session.dragging = true;
      window.clearTimeout(longPressTimerRef.current);
      setDragging(true);
    }
    if (!session.dragging) return;
    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const x = Math.min(
      Math.max(4, event.clientX - session.offsetX),
      window.innerWidth - rect.width - 4
    );
    const y = Math.min(
      Math.max(62, event.clientY - session.offsetY),
      window.innerHeight - rect.height - 4
    );
    container.style.left = `${x}px`;
    container.style.top = `${y}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
  };

  const handlePointerUp = (event) => {
    const session = pointerSessionRef.current;
    if (!session || session.id !== event.pointerId) return;
    window.clearTimeout(longPressTimerRef.current);
    pointerSessionRef.current = null;
    setDragging(false);
    if (session.dragging) {
      const rect = containerRef.current.getBoundingClientRect();
      if (!window.matchMedia('(max-width: 700px)').matches) {
        writeStorage(
          POSITION_KEY,
          JSON.stringify({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
          })
        );
      }
      reactionRef.current('drop');
      return;
    }
    if (!session.longPressed) queueTap();
  };

  const handlePointerCancel = () => {
    window.clearTimeout(longPressTimerRef.current);
    pointerSessionRef.current = null;
    setDragging(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      queueTap();
    }
    if (event.key === ' ') {
      event.preventDefault();
      reactionRef.current('longpress');
    }
  };

  if (!config.enabled || suspended) return null;

  if (hidden) {
    return (
      <button
        type="button"
        className="cat-video-pet-restore"
        onClick={() => changeVisibility(false)}
        aria-label="显示页面宠物阿丽莎"
        title="叫阿丽莎回来"
        style={cssVariables}
      >
        <PawPrint size={17} aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      ref={containerRef}
      className={[
        'cat-video-pet',
        avoidingControls ? 'is-avoiding-controls' : '',
        scrolling ? 'is-scrolling' : '',
        dragging ? 'is-dragging' : '',
        ready ? 'is-ready' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="页面宠物阿丽莎"
      style={cssVariables}
      data-action={action || 'quiet'}
      data-chroma-tolerance={config.render.chromaTolerance}
      data-position-revision="3"
      data-pet-dock={dockSide}
    >
      <button
        type="button"
        className="cat-video-pet-hide"
        onClick={() => changeVisibility(true)}
        aria-label="隐藏页面宠物阿丽莎"
        title="让阿丽莎休息"
      >
        <EyeOff size={13} aria-hidden="true" />
      </button>

      <div
        ref={stageRef}
        className="cat-video-pet-stage"
        role="button"
        tabIndex={0}
        aria-label="银白猫阿丽莎，点击、长按或拖动和她互动"
        title="摸摸阿丽莎"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        {failed ? <StaticFallback /> : null}
        <canvas
          ref={canvasRef}
          className="cat-video-pet-canvas"
          aria-hidden="true"
        />
        <img
          ref={baseImageRef}
          className="cat-video-pet-source"
          src={BASE_ASSET}
          alt=""
          aria-hidden="true"
        />
        <video
          ref={videoARef}
          className="cat-video-pet-source"
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
        />
        <video
          ref={videoBRef}
          className="cat-video-pet-source"
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
        />
        <span className="cat-video-pet-ground" aria-hidden="true" />
        {speech && !scrolling && !avoidingControls ? (
          <span
            key={speech.key}
            className={[
              'cat-video-pet-speech',
              `is-${speech.tone}`,
              speech.leaving ? 'is-leaving' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="status"
          >
            {speech.message}
          </span>
        ) : null}
        {particle ? (
          <span
            key={particle.key}
            className="cat-video-pet-particles"
            aria-hidden="true"
          >
            <i>{particle.symbol}</i>
            <i>{particle.symbol}</i>
            <i>{particle.symbol}</i>
          </span>
        ) : null}
      </div>
    </aside>
  );
}
