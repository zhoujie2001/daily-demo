import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion as Motion, MotionConfig, useSpring } from 'framer-motion';
import BottleIllustration from './BottleIllustration';
import { DRIFT_BOTTLE_PHASES } from '../../../utils/driftBottle';
import {
  calculateBottleCollision,
  samplePointerMotion,
} from '../../../utils/driftBottlePhysics';

function Cloud({ className }) {
  return (
    <div className={`drift-cloud ${className}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

function Sailboat({ className }) {
  return (
    <svg className={`drift-sailboat ${className}`} viewBox="0 0 90 62" aria-hidden="true">
      <path d="M47 5v42" stroke="currentColor" strokeWidth="2" />
      <path d="M45 8 16 42h29V8ZM50 15v27h24L50 15Z" fill="currentColor" opacity=".7" />
      <path d="M9 45h70l-10 11H22L9 45Z" fill="currentColor" />
    </svg>
  );
}

function WaveLayer({ className, path, crest }) {
  return (
    <div className={`drift-wave-layer ${className}`} aria-hidden="true">
      <div className="drift-wave-track">
        {[0, 1].map((item) => (
          <svg key={item} viewBox="0 0 1000 220" preserveAspectRatio="none">
            <path d={path} />
            <path className="drift-wave-crest" d={crest} />
          </svg>
        ))}
      </div>
    </div>
  );
}

function InteractiveBottle({
  bottle,
  index,
  canSelect,
  reducedMotion,
  pointerMotionRef,
  onSelect,
}) {
  const tilt = useSpring(0, { stiffness: 190, damping: 11, mass: 0.62 });
  const shiftX = useSpring(0, { stiffness: 210, damping: 14, mass: 0.58 });
  const shiftY = useSpring(0, { stiffness: 230, damping: 15, mass: 0.56 });
  const [ripples, setRipples] = useState([]);
  const lastImpactRef = useRef(0);
  const resetTimerRef = useRef(null);
  const rippleIdRef = useRef(0);
  const rippleTimersRef = useRef(new Set());

  useEffect(() => () => {
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    rippleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    rippleTimersRef.current.clear();
  }, []);

  const settleBottle = useCallback(() => {
    tilt.set(0);
    shiftX.set(0);
    shiftY.set(0);
  }, [shiftX, shiftY, tilt]);

  const createRipple = useCallback((collision) => {
    const rippleId = `${bottle.id}-${rippleIdRef.current += 1}`;
    setRipples((current) => current.concat({
      id: rippleId,
      energy: collision.energy,
      scale: collision.rippleScale,
      offset: collision.rippleOffset,
    }));

    const timer = window.setTimeout(() => {
      setRipples((current) => current.filter((ripple) => ripple.id !== rippleId));
      rippleTimersRef.current.delete(timer);
    }, 1050);
    rippleTimersRef.current.add(timer);
  }, [bottle.id]);

  const applyPointerImpact = useCallback((event, force = false) => {
    if (!canSelect || event.pointerType === 'touch') return;

    const now = performance.now();
    const pointerMotion = pointerMotionRef.current || {};
    const speed = Math.hypot(
      pointerMotion.velocityX || 0,
      pointerMotion.velocityY || 0
    );
    if (!force && (speed < 130 || now - lastImpactRef.current < 90)) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const collision = calculateBottleCollision({
      pointerX: event.clientX,
      pointerY: event.clientY,
      velocityX: pointerMotion.velocityX,
      velocityY: pointerMotion.velocityY,
      rect,
    });
    const motionScale = reducedMotion ? 0.42 : 1;
    const renderedCollision = reducedMotion ? {
      ...collision,
      tilt: collision.tilt * motionScale,
      shiftX: collision.shiftX * motionScale,
      shiftY: collision.shiftY * motionScale,
      rippleScale: 0.8 + (collision.rippleScale - 0.8) * 0.55,
    } : collision;

    lastImpactRef.current = now;
    tilt.set(renderedCollision.tilt);
    shiftX.set(renderedCollision.shiftX);
    shiftY.set(renderedCollision.shiftY);
    createRipple(renderedCollision);

    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(settleBottle, 115);
  }, [
    canSelect,
    createRipple,
    pointerMotionRef,
    reducedMotion,
    settleBottle,
    shiftX,
    shiftY,
    tilt,
  ]);

  return (
    <div
      className={`drift-bottle-slot drift-depth-${bottle.depth}`}
      style={{ left: `${bottle.x}%`, top: `${bottle.y}%` }}
    >
      <div className="drift-bottle-waterline" aria-hidden="true">
        <span className="drift-bottle-ripple" />
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            className="drift-impact-ripple"
            style={{
              '--ripple-energy': ripple.energy,
              '--ripple-scale': ripple.scale,
              '--ripple-offset': `${ripple.offset * 8}px`,
            }}
          />
        ))}
      </div>

      <Motion.button
        type="button"
        className="drift-floating-bottle"
        data-drift-bottle-id={bottle.id}
        data-physics-enabled={canSelect}
        aria-label={`打开第 ${index + 1} 只漂流瓶`}
        disabled={!canSelect}
        onClick={() => onSelect(bottle)}
        onPointerEnter={(event) => applyPointerImpact(event, true)}
        onPointerMove={applyPointerImpact}
        onPointerLeave={settleBottle}
        animate={reducedMotion ? {
          scale: bottle.scale,
        } : {
          y: [0, -bottle.drift, 0],
          scale: bottle.scale,
        }}
        transition={reducedMotion ? {
          duration: 0.01,
        } : {
          y: {
            duration: 3.2 + index * 0.2,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: bottle.delay,
          },
          scale: { duration: 0.2 },
        }}
        whileTap={canSelect ? { scale: bottle.scale * 0.96 } : undefined}
      >
        <MotionConfig reducedMotion="never">
          <Motion.span
            className="drift-bottle-impact-body"
            style={{ x: shiftX, y: shiftY, rotate: tilt }}
          >
            <span
              className="drift-bottle-idle-body"
              style={{
                '--bottle-rest-rotate': `${bottle.rotate}deg`,
                '--bottle-counter-rotate': `${bottle.rotate * -0.38}deg`,
                '--bottle-sway-duration': `${4.1 + index * 0.18}s`,
                '--bottle-sway-delay': `${bottle.delay}s`,
              }}
            >
              <BottleIllustration />
            </span>
          </Motion.span>
        </MotionConfig>
      </Motion.button>
    </div>
  );
}

export default function DriftSea({
  bottles,
  selectedBottleId,
  phase,
  reducedMotion,
  onSelect,
}) {
  const canSelect = phase === DRIFT_BOTTLE_PHASES.SEA;
  const pointerMotionRef = useRef(null);

  const trackPointer = useCallback((event) => {
    if (event.pointerType === 'touch') return;
    pointerMotionRef.current = samplePointerMotion(pointerMotionRef.current, {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp || performance.now(),
    });
  }, []);

  return (
    <div
      className="drift-sea-world"
      aria-label="漂流瓶海面"
      onPointerMoveCapture={trackPointer}
    >
      <div className="drift-sky" aria-hidden="true">
        <div className="drift-sun-glow" />
        <Cloud className="drift-cloud-one" />
        <Cloud className="drift-cloud-two" />
        <Cloud className="drift-cloud-three" />
        <Sailboat className="drift-sailboat-one" />
        <Sailboat className="drift-sailboat-two" />
        <Sailboat className="drift-sailboat-three" />
      </div>

      <div className="drift-sea" aria-hidden="true">
        <div className="drift-sea-current" />
        <WaveLayer
          className="drift-wave-far"
          path="M0 72C125 30 250 114 375 72S625 30 750 72s125 42 250 0v148H0V72Z"
          crest="M0 72C125 30 250 114 375 72S625 30 750 72s125 42 250 0"
        />
        <WaveLayer
          className="drift-wave-mid"
          path="M0 90C100 34 200 146 300 90S500 34 600 90s200 56 300 0c34-19 67-19 100 0v130H0V90Z"
          crest="M0 90C100 34 200 146 300 90S500 34 600 90s200 56 300 0c34-19 67-19 100 0"
        />
        <WaveLayer
          className="drift-wave-near"
          path="M0 112C85 62 165 162 250 112S415 62 500 112s165 50 250 0 165-50 250 0v108H0V112Z"
          crest="M0 112C85 62 165 162 250 112S415 62 500 112s165 50 250 0 165-50 250 0"
        />
      </div>

      <div className="drift-bottle-field">
        {bottles.map((bottle, index) => {
          if (bottle.id === selectedBottleId) return null;

          return (
            <InteractiveBottle
              key={bottle.id}
              bottle={bottle}
              index={index}
              canSelect={canSelect}
              reducedMotion={reducedMotion}
              pointerMotionRef={pointerMotionRef}
              onSelect={onSelect}
            />
          );
        })}
      </div>

      {!bottles.length ? (
        <div className="drift-empty-sea" role="status">
          <strong>今天海上没有漂流瓶</strong>
          <span>等写下一篇 Daily，再来海边看看。</span>
        </div>
      ) : null}
    </div>
  );
}
