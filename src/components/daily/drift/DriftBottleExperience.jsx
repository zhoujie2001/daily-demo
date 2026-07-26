import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion as Motion, MotionConfig, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import {
  createDriftBottleState,
  DRIFT_BOTTLE_ACTIONS,
  DRIFT_BOTTLE_PHASES,
  driftBottleReducer,
  isDriftBottleBusy,
} from '../../../utils/driftBottle';
import BottleIllustration, { BottleCork } from './BottleIllustration';
import BottleNote from './BottleNote';
import DriftSea from './DriftSea';

const PHASE_COPY = {
  [DRIFT_BOTTLE_PHASES.APPROACHING]: '漂流瓶正在靠近…',
  [DRIFT_BOTTLE_PHASES.UNCORKING]: '正在打开木塞…',
  [DRIFT_BOTTLE_PHASES.EXTRACTING]: '正在取出瓶内纸卷…',
  [DRIFT_BOTTLE_PHASES.UNFOLDING]: '正在展开纸条…',
  [DRIFT_BOTTLE_PHASES.FOLDING]: '正在卷好纸条…',
  [DRIFT_BOTTLE_PHASES.INSERTING]: '正在把纸卷放回瓶里…',
  [DRIFT_BOTTLE_PHASES.CORKING]: '正在塞好木塞…',
  [DRIFT_BOTTLE_PHASES.THROWING]: '正在扔回海里…',
  [DRIFT_BOTTLE_PHASES.SPLASHING]: '扑通——',
};

const PHASE_DURATION = Object.freeze({
  approach: 1.5,
  uncork: 1.05,
  extract: 1.25,
  unfold: 1.35,
  fold: 1.2,
  insert: 1.2,
  cork: 1,
  throw: 1.55,
  splash: 1.4,
});

const PHASE_ADVANCE = Object.freeze({
  [DRIFT_BOTTLE_PHASES.APPROACHING]: {
    duration: 'approach',
    action: DRIFT_BOTTLE_ACTIONS.APPROACH_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.UNCORKING]: {
    duration: 'uncork',
    action: DRIFT_BOTTLE_ACTIONS.UNCORK_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.EXTRACTING]: {
    duration: 'extract',
    action: DRIFT_BOTTLE_ACTIONS.EXTRACT_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.UNFOLDING]: {
    duration: 'unfold',
    action: DRIFT_BOTTLE_ACTIONS.UNFOLD_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.FOLDING]: {
    duration: 'fold',
    action: DRIFT_BOTTLE_ACTIONS.FOLD_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.INSERTING]: {
    duration: 'insert',
    action: DRIFT_BOTTLE_ACTIONS.INSERT_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.CORKING]: {
    duration: 'cork',
    action: DRIFT_BOTTLE_ACTIONS.CORK_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.THROWING]: {
    duration: 'throw',
    action: DRIFT_BOTTLE_ACTIONS.THROW_COMPLETE,
  },
  [DRIFT_BOTTLE_PHASES.SPLASHING]: {
    duration: 'splash',
    action: DRIFT_BOTTLE_ACTIONS.SPLASH_COMPLETE,
  },
});

function motionDuration(reducedMotion, duration) {
  return reducedMotion ? Math.max(0.75, duration * 0.9) : duration;
}

function RolledPaper({ phase, reducedMotion }) {
  const extracting = phase === DRIFT_BOTTLE_PHASES.EXTRACTING;
  const duration = motionDuration(
    reducedMotion,
    extracting ? PHASE_DURATION.extract : PHASE_DURATION.insert
  );

  return (
    <Motion.div
      key={phase}
      className="drift-rolled-note"
      initial={extracting ? {
        top: '64%',
        y: 42,
        scale: 0.32,
        rotate: 6,
        opacity: 0.28,
      } : {
        top: '43%',
        y: 0,
        scale: 1,
        rotate: -2,
        opacity: 1,
      }}
      animate={extracting ? {
        top: '43%',
        y: 0,
        scale: 1,
        rotate: -2,
        opacity: 1,
      } : {
        top: '69%',
        y: 0,
        scale: 0.3,
        rotate: 5,
        opacity: 0.2,
      }}
      transition={{
        duration,
        ease: [0.22, 0.74, 0.22, 1],
      }}
      aria-hidden="true"
    >
      <span />
    </Motion.div>
  );
}

function FocusedBottle({
  bottle,
  phase,
  reducedMotion,
  dispatch,
}) {
  const isThrowing = phase === DRIFT_BOTTLE_PHASES.THROWING;
  const throwDirection = bottle.x < 50 ? -1 : 1;
  const showBottle = phase !== DRIFT_BOTTLE_PHASES.SPLASHING;
  const lowerBottlePhases = [
    DRIFT_BOTTLE_PHASES.EXTRACTING,
    DRIFT_BOTTLE_PHASES.UNFOLDING,
    DRIFT_BOTTLE_PHASES.READING,
    DRIFT_BOTTLE_PHASES.FOLDING,
    DRIFT_BOTTLE_PHASES.INSERTING,
    DRIFT_BOTTLE_PHASES.CORKING,
  ];
  const bottleIsLowered = lowerBottlePhases.includes(phase);
  const paperInsideBottle = [
    DRIFT_BOTTLE_PHASES.APPROACHING,
    DRIFT_BOTTLE_PHASES.UNCORKING,
    DRIFT_BOTTLE_PHASES.CORKING,
    DRIFT_BOTTLE_PHASES.THROWING,
  ].includes(phase);
  const parkedCork = [
    DRIFT_BOTTLE_PHASES.EXTRACTING,
    DRIFT_BOTTLE_PHASES.UNFOLDING,
    DRIFT_BOTTLE_PHASES.READING,
    DRIFT_BOTTLE_PHASES.FOLDING,
    DRIFT_BOTTLE_PHASES.INSERTING,
  ].includes(phase);
  const bottleTarget = isThrowing ? {
    left: ['50%', throwDirection < 0 ? '38%' : '62%', throwDirection < 0 ? '20%' : '80%'],
    top: ['90%', '46%', '78%'],
    scale: [1.42, 1.06, 0.36],
    rotate: [0, throwDirection * 150, throwDirection * 560],
    opacity: [1, 1, 0],
  } : {
    left: '50%',
    top: bottleIsLowered ? '90%' : '66%',
    scale: bottleIsLowered ? 1.42 : 2.08,
    rotate: 0,
    opacity: 1,
  };
  const bottleDuration = motionDuration(
    reducedMotion,
    phase === DRIFT_BOTTLE_PHASES.APPROACHING
      ? PHASE_DURATION.approach
      : isThrowing
        ? PHASE_DURATION.throw
        : phase === DRIFT_BOTTLE_PHASES.EXTRACTING
          ? PHASE_DURATION.extract
          : 0.42
  );

  return (
    <>
      {showBottle ? (
        <Motion.div
          className="drift-focused-bottle"
          initial={{
            left: `${bottle.x}%`,
            top: `${bottle.y}%`,
            scale: bottle.scale,
            rotate: bottle.rotate,
            opacity: 1,
          }}
          animate={bottleTarget}
          transition={{
            duration: bottleDuration,
            ease: [0.19, 1, 0.22, 1],
            times: isThrowing ? [0, 0.5, 1] : undefined,
          }}
          aria-hidden="true"
        >
          <BottleIllustration
            corked={isThrowing}
            paperVisible={paperInsideBottle}
          />

          {phase === DRIFT_BOTTLE_PHASES.APPROACHING ? (
            <div className="drift-focus-cork"><BottleCork /></div>
          ) : null}

          {phase === DRIFT_BOTTLE_PHASES.UNCORKING ? (
            <Motion.div
              className="drift-focus-cork"
              initial={{ y: 0, x: 0, rotate: 0, opacity: 1 }}
              animate={{ y: -58, x: 48, rotate: 24, opacity: 1 }}
              transition={{
                duration: motionDuration(reducedMotion, PHASE_DURATION.uncork),
                ease: [0.22, 0.74, 0.22, 1],
              }}
            >
              <BottleCork />
            </Motion.div>
          ) : null}

          {parkedCork ? (
            <div className="drift-focus-cork drift-focus-cork-parked">
              <BottleCork />
            </div>
          ) : null}

          {phase === DRIFT_BOTTLE_PHASES.CORKING ? (
            <Motion.div
              className="drift-focus-cork"
              initial={{ y: -58, x: 48, rotate: 24, opacity: 1 }}
              animate={{ y: 0, x: 0, rotate: 0, opacity: 1 }}
              transition={{
                duration: motionDuration(reducedMotion, PHASE_DURATION.cork),
                ease: [0.19, 1, 0.22, 1],
              }}
            >
              <BottleCork />
            </Motion.div>
          ) : null}
        </Motion.div>
      ) : null}

      {[
        DRIFT_BOTTLE_PHASES.EXTRACTING,
        DRIFT_BOTTLE_PHASES.INSERTING,
      ].includes(phase) ? (
        <RolledPaper
          phase={phase}
          reducedMotion={reducedMotion}
        />
      ) : null}

      <AnimatePresence>
        {[
          DRIFT_BOTTLE_PHASES.UNFOLDING,
          DRIFT_BOTTLE_PHASES.READING,
          DRIFT_BOTTLE_PHASES.FOLDING,
        ].includes(phase) ? (
          <Motion.div
            key="drift-note"
            className="drift-note-stage"
            initial={{
              y: 152,
              scaleX: 0.16,
              scaleY: 0.12,
              opacity: 0.66,
              rotate: -2,
              borderRadius: '999px',
            }}
            animate={phase === DRIFT_BOTTLE_PHASES.FOLDING ? {
              y: 152,
              scaleX: 0.16,
              scaleY: 0.12,
              opacity: 0.68,
              rotate: 2,
              borderRadius: '999px',
            } : {
              y: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              rotate: 0,
              borderRadius: '6px',
            }}
            transition={{
              duration: motionDuration(
                reducedMotion,
                phase === DRIFT_BOTTLE_PHASES.FOLDING
                  ? PHASE_DURATION.fold
                  : PHASE_DURATION.unfold
              ),
              ease: [0.19, 1, 0.22, 1],
            }}
          >
            <BottleNote
              post={bottle.post}
              onReturn={() => dispatch({ type: DRIFT_BOTTLE_ACTIONS.RETURN })}
            />
          </Motion.div>
        ) : null}
      </AnimatePresence>

      {phase === DRIFT_BOTTLE_PHASES.SPLASHING ? (
        <Motion.div
          className={`drift-splash ${throwDirection < 0 ? 'drift-splash-left' : 'drift-splash-right'}`}
          initial={{ y: -12, scale: 0.34, opacity: 1 }}
          animate={{ y: 0, scale: [0.34, 1.2, 2.8], opacity: [1, 1, 0] }}
          transition={{
            duration: motionDuration(reducedMotion, PHASE_DURATION.splash),
            ease: [0.16, 0.68, 0.32, 1],
            times: [0, 0.28, 1],
          }}
          aria-hidden="true"
        >
          <span className="drift-splash-ring drift-splash-ring-outer" />
          <span className="drift-splash-ring drift-splash-ring-inner" />
          <i />
          <i />
          <i />
          <i />
          <i />
        </Motion.div>
      ) : null}
    </>
  );
}

export default function DriftBottleExperience({
  bottles,
  onBottleReturned,
  onClose,
}) {
  const [state, dispatch] = useReducer(driftBottleReducer, undefined, () => createDriftBottleState(true));
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef(null);
  const returnedFocusRef = useRef(null);
  const onBottleReturnedRef = useRef(onBottleReturned);
  const reducedMotion = useReducedMotion();
  const selectedBottle = useMemo(
    () => bottles.find((bottle) => bottle.id === state.selectedBottleId) || null,
    [bottles, state.selectedBottleId]
  );

  const requestClose = useCallback(() => {
    if (closing) return;
    dispatch({ type: DRIFT_BOTTLE_ACTIONS.CLOSE });
    setClosing(true);
  }, [closing]);

  useEffect(() => {
    onBottleReturnedRef.current = onBottleReturned;
  }, [onBottleReturned]);

  useEffect(() => {
    const advance = PHASE_ADVANCE[state.phase];
    if (!advance) return undefined;

    const duration = motionDuration(
      Boolean(reducedMotion),
      PHASE_DURATION[advance.duration]
    );
    const selectedBottleId = state.selectedBottleId;
    const timer = window.setTimeout(() => {
      if (state.phase === DRIFT_BOTTLE_PHASES.SPLASHING && selectedBottleId) {
        onBottleReturnedRef.current(selectedBottleId);
      }
      dispatch({ type: advance.action });
    }, duration * 1000 + 60);

    return () => window.clearTimeout(timer);
  }, [reducedMotion, state.phase, state.selectedBottleId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    if (dialog && !dialog.open) dialog.showModal();

    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      requestClose();
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [requestClose]);

  useEffect(() => {
    if (state.phase !== DRIFT_BOTTLE_PHASES.SEA || !state.lastReturnedBottleId) return;
    returnedFocusRef.current = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector(`[data-drift-bottle-id="${state.lastReturnedBottleId}"]`)
        ?.focus({ preventScroll: true });
    });

    return () => {
      if (returnedFocusRef.current) window.cancelAnimationFrame(returnedFocusRef.current);
    };
  }, [state.lastReturnedBottleId, state.phase]);

  const handleSelect = (bottle) => {
    dispatch({
      type: DRIFT_BOTTLE_ACTIONS.SELECT,
      bottleId: bottle.id,
      post: bottle.post,
    });
  };

  const statusCopy = PHASE_COPY[state.phase]
    || (state.phase === DRIFT_BOTTLE_PHASES.READING ? '纸条已经展开，可以阅读。' : '选择一只漂流瓶。');

  return createPortal(
    <dialog
      ref={dialogRef}
      className="drift-bottle-dialog"
      aria-labelledby="drift-bottle-title"
      aria-describedby="drift-bottle-description"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <MotionConfig reducedMotion="never">
        <Motion.main
          className="drift-bottle-experience"
          initial={{ opacity: 0 }}
          animate={{ opacity: closing ? 0 : 1 }}
          transition={{ duration: motionDuration(Boolean(reducedMotion), 0.3) }}
          onAnimationComplete={() => {
            if (closing) onClose();
          }}
        >
          <header className="drift-experience-header">
            <div>
              <h2 id="drift-bottle-title">漂流瓶</h2>
              <p id="drift-bottle-description">从海面捞起一封被遗忘的 Daily</p>
            </div>
            <button type="button" className="drift-exit-button" onClick={requestClose}>
              <X size={17} aria-hidden="true" />
              <span>退出漂流瓶</span>
            </button>
          </header>

          <p className="drift-live-status" aria-live="polite" aria-atomic="true">
            {statusCopy}
          </p>

          <DriftSea
            bottles={bottles}
            selectedBottleId={state.selectedBottleId}
            phase={state.phase}
            reducedMotion={Boolean(reducedMotion)}
            onSelect={handleSelect}
          />

          {selectedBottle ? (
            <FocusedBottle
              bottle={selectedBottle}
              phase={state.phase}
              reducedMotion={Boolean(reducedMotion)}
              dispatch={dispatch}
            />
          ) : null}

          {isDriftBottleBusy(state.phase) ? (
            <div className="drift-interaction-guard" aria-hidden="true" />
          ) : null}
        </Motion.main>
      </MotionConfig>
    </dialog>,
    document.body
  );
}
