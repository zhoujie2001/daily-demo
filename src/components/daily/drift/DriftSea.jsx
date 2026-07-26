import React from 'react';
import { motion as Motion } from 'framer-motion';
import BottleIllustration from './BottleIllustration';
import { DRIFT_BOTTLE_PHASES } from '../../../utils/driftBottle';

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

function WaveLayer({ className, path }) {
  return (
    <div className={`drift-wave-layer ${className}`} aria-hidden="true">
      <div className="drift-wave-track">
        {[0, 1].map((item) => (
          <svg key={item} viewBox="0 0 800 180" preserveAspectRatio="none">
            <path d={path} />
          </svg>
        ))}
      </div>
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

  return (
    <div className="drift-sea-world" aria-label="漂流瓶海面">
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
        <WaveLayer
          className="drift-wave-far"
          path="M0 55C85 18 155 92 240 55S395 18 480 55s155 37 240 0 155-37 240 0v125H0V55Z"
        />
        <WaveLayer
          className="drift-wave-mid"
          path="M0 70c110-58 190 58 300 0s190 58 300 0 190 58 300 0v110H0V70Z"
        />
        <WaveLayer
          className="drift-wave-near"
          path="M0 88c95-48 165 48 260 0s165 48 260 0 165 48 260 0 165 48 260 0v92H0V88Z"
        />
      </div>

      <div className="drift-bottle-field">
        {bottles.map((bottle, index) => {
          if (bottle.id === selectedBottleId) return null;

          return (
            <div
              key={bottle.id}
              className={`drift-bottle-slot drift-depth-${bottle.depth}`}
              style={{ left: `${bottle.x}%`, top: `${bottle.y}%` }}
            >
              <Motion.button
                type="button"
                className="drift-floating-bottle"
                data-drift-bottle-id={bottle.id}
                aria-label={`打开第 ${index + 1} 只漂流瓶`}
                disabled={!canSelect}
                onClick={() => onSelect(bottle)}
                animate={reducedMotion ? {
                  scale: bottle.scale,
                  rotate: bottle.rotate,
                } : {
                  y: [0, -bottle.drift, 0],
                  rotate: [bottle.rotate, bottle.rotate * -0.38, bottle.rotate],
                  scale: bottle.scale,
                }}
                transition={reducedMotion ? {
                  duration: 0.01,
                } : {
                  y: {
                    duration: 3.4 + index * 0.22,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: bottle.delay,
                  },
                  rotate: {
                    duration: 4.1 + index * 0.18,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: bottle.delay,
                  },
                  scale: { duration: 0.2 },
                }}
                whileHover={canSelect && !reducedMotion ? { scale: bottle.scale * 1.1, y: -8 } : undefined}
                whileTap={canSelect ? { scale: bottle.scale * 0.96 } : undefined}
              >
                <BottleIllustration />
                <span className="drift-bottle-ripple" aria-hidden="true" />
              </Motion.button>
            </div>
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
