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
  [DRIFT_BOTTLE_PHASES.UNFOLDING]: '正在展开纸条…',
  [DRIFT_BOTTLE_PHASES.FOLDING]: '正在卷好纸条…',
  [DRIFT_BOTTLE_PHASES.CORKING]: '正在塞好木塞…',
  [DRIFT_BOTTLE_PHASES.THROWING]: '正在扔回海里…',
  [DRIFT_BOTTLE_PHASES.SPLASHING]: '扑通——',
};

function FocusedBottle({
  bottle,
  phase,
  reducedMotion,
  dispatch,
  onReturned,
}) {
  const fastDuration = reducedMotion ? 0.01 : 0.24;
  const regularDuration = reducedMotion ? 0.01 : 0.56;
  const isThrowing = phase === DRIFT_BOTTLE_PHASES.THROWING;
  const throwDirection = bottle.x < 50 ? -1 : 1;
  const showBottle = ![
    DRIFT_BOTTLE_PHASES.READING,
    DRIFT_BOTTLE_PHASES.SPLASHING,
  ].includes(phase);

  const bottleTarget = isThrowing ? {
    left: throwDirection < 0 ? '22%' : '78%',
    top: '77%',
    scale: 0.48,
    rotate: throwDirection * 520,
    opacity: 0,
  } : {
    left: '50%',
    top: '60%',
    scale: phase === DRIFT_BOTTLE_PHASES.UNFOLDING || phase === DRIFT_BOTTLE_PHASES.FOLDING ? 1.72 : 2.12,
    rotate: 0,
    opacity: phase === DRIFT_BOTTLE_PHASES.UNFOLDING ? 0.32 : 1,
  };

  const handleBottleAnimationComplete = () => {
    if (phase === DRIFT_BOTTLE_PHASES.APPROACHING) {
      dispatch({ type: DRIFT_BOTTLE_ACTIONS.APPROACH_COMPLETE });
    } else if (phase === DRIFT_BOTTLE_PHASES.THROWING) {
      dispatch({ type: DRIFT_BOTTLE_ACTIONS.THROW_COMPLETE });
    }
  };

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
            duration: phase === DRIFT_BOTTLE_PHASES.APPROACHING || isThrowing ? regularDuration : fastDuration,
            ease: [0.19, 1, 0.22, 1],
          }}
          onAnimationComplete={handleBottleAnimationComplete}
          aria-hidden="true"
        >
          <BottleIllustration corked={isThrowing} />

          {phase === DRIFT_BOTTLE_PHASES.APPROACHING ? (
            <div className="drift-focus-cork"><BottleCork /></div>
          ) : null}

          {phase === DRIFT_BOTTLE_PHASES.UNCORKING ? (
            <Motion.div
              className="drift-focus-cork"
              initial={{ y: 0, rotate: 0, opacity: 1 }}
              animate={{ y: -72, x: 12, rotate: 18, opacity: 0 }}
              transition={{ duration: reducedMotion ? 0.01 : 0.42, ease: 'easeOut' }}
              onAnimationComplete={() => dispatch({ type: DRIFT_BOTTLE_ACTIONS.UNCORK_COMPLETE })}
            >
              <BottleCork />
            </Motion.div>
          ) : null}

          {phase === DRIFT_BOTTLE_PHASES.CORKING ? (
            <Motion.div
              className="drift-focus-cork"
              initial={{ y: -76, x: 10, rotate: 16, opacity: 0.45 }}
              animate={{ y: 0, x: 0, rotate: 0, opacity: 1 }}
              transition={{ duration: reducedMotion ? 0.01 : 0.4, ease: [0.19, 1, 0.22, 1] }}
              onAnimationComplete={() => dispatch({ type: DRIFT_BOTTLE_ACTIONS.CORK_COMPLETE })}
            >
              <BottleCork />
            </Motion.div>
          ) : null}
        </Motion.div>
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
            initial={{ y: 130, scaleX: 0.2, scaleY: 0.08, opacity: 0, rotate: -2 }}
            animate={phase === DRIFT_BOTTLE_PHASES.FOLDING ? {
              y: 145,
              scaleX: 0.17,
              scaleY: 0.06,
              opacity: 0.2,
              rotate: 3,
            } : {
              y: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              rotate: 0,
            }}
            transition={{ duration: reducedMotion ? 0.01 : 0.58, ease: [0.19, 1, 0.22, 1] }}
            onAnimationComplete={() => {
              if (phase === DRIFT_BOTTLE_PHASES.UNFOLDING) {
                dispatch({ type: DRIFT_BOTTLE_ACTIONS.UNFOLD_COMPLETE });
              } else if (phase === DRIFT_BOTTLE_PHASES.FOLDING) {
                dispatch({ type: DRIFT_BOTTLE_ACTIONS.FOLD_COMPLETE });
              }
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
          initial={{ scale: 0.2, opacity: 0.9 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: reducedMotion ? 0.01 : 0.58, ease: 'easeOut' }}
          onAnimationComplete={() => {
            onReturned(bottle.id);
            dispatch({ type: DRIFT_BOTTLE_ACTIONS.SPLASH_COMPLETE });
          }}
          aria-hidden="true"
        >
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
      <MotionConfig reducedMotion="user">
        <Motion.main
          className="drift-bottle-experience"
          initial={{ opacity: 0 }}
          animate={{ opacity: closing ? 0 : 1 }}
          transition={{ duration: reducedMotion ? 0.01 : 0.3 }}
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
              onReturned={onBottleReturned}
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
