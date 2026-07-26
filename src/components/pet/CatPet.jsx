import React, { useEffect, useRef, useState } from 'react';
import { EyeOff, PawPrint } from 'lucide-react';
import { CAT_PET_REACTION } from '../../utils/catPetBehavior';
import { createCatPetEngine } from './catPetEngine';
import './CatPet.css';

const STORAGE_KEY = 'daily-demo-cat-pet-hidden';

function readInitialHiddenState() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistHiddenState(hidden) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(hidden));
  } catch {
    // The pet still works when storage is unavailable.
  }
}

function CatPetFallback() {
  return (
    <svg
      className="cat-pet-fallback"
      viewBox="0 0 220 260"
      aria-hidden="true"
    >
      <ellipse cx="110" cy="236" rx="72" ry="13" fill="rgba(74, 64, 54, .12)" />
      <path
        d="M66 200c-7-47 4-94 44-103 38 5 54 48 45 102-5 30-25 39-45 39-22 0-39-9-44-38Z"
        fill="#c9c8c4"
      />
      <path
        d="M75 117 67 55l38 26c13-5 28-5 41 0l36-25-7 62c7 10 10 22 8 35-4 29-29 47-67 47-40 0-67-19-69-49-1-13 2-24 8-34Z"
        fill="#d8d6d0"
      />
      <path
        d="M77 126c-9 9-13 24-9 40 5 23 23 35 48 35 26 0 45-13 49-37 3-16-2-31-11-40-4 25-18 39-38 39-20 0-35-13-39-37Z"
        fill="#f1eadf"
      />
      <path d="m78 86-5-22 23 16-18 6Zm79 0 5-22-23 16 18 6Z" fill="#c3877b" />
      <ellipse cx="92" cy="121" rx="12" ry="15" fill="#a9943b" />
      <ellipse cx="140" cy="121" rx="12" ry="15" fill="#a9943b" />
      <ellipse cx="94" cy="121" rx="3" ry="10" fill="#292620" />
      <ellipse cx="138" cy="121" rx="3" ry="10" fill="#292620" />
      <path d="m108 142 8-5 8 5-8 8-8-8Z" fill="#a65f4a" />
      <path d="M108 91c3-11 5-17 8-22 3 5 5 12 7 22m-25 2c3-9 7-15 11-20m25 20c-3-9-7-15-11-20" fill="none" stroke="#5e6262" strokeWidth="4" strokeLinecap="round" />
      <path d="M86 183c7 16 7 35 4 51m52-51c-7 16-7 35-4 51" fill="none" stroke="#5e6262" strokeWidth="5" strokeLinecap="round" opacity=".65" />
      <path d="M151 205c34-4 51 10 49 28-2 19-28 24-68 9 28 1 42-5 40-16-2-8-9-15-21-21Z" fill="#b9bab7" />
    </svg>
  );
}

export default function CatPet() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const reactionTimerRef = useRef(null);
  const [hidden, setHidden] = useState(readInitialHiddenState);
  const [fallback, setFallback] = useState(false);
  const [reaction, setReaction] = useState(null);
  const [reactionKey, setReactionKey] = useState(0);
  const [avoidingControls, setAvoidingControls] = useState(false);

  useEffect(() => {
    const controls = document.querySelector('.memory-actions');
    if (!controls || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(([entry]) => {
      setAvoidingControls(entry.isIntersecting);
    }, { threshold: 0.05 });
    observer.observe(controls);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (hidden || !canvasRef.current) return undefined;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const engine = createCatPetEngine(canvasRef.current, {
      reducedMotion: media.matches,
      onUnavailable: () => setFallback(true),
    });
    engineRef.current = engine;
    engine?.start();

    const handleMotionPreference = (event) => {
      engine?.setReducedMotion(event.matches);
    };
    const handleVisibility = () => {
      if (document.hidden) engine?.stop();
      else engine?.start();
    };
    const handlePointer = (event) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const x = (event.clientX - centerX) / Math.max(window.innerWidth * 0.42, 1);
      const y = (event.clientY - centerY) / Math.max(window.innerHeight * 0.42, 1);
      const nearby = Math.hypot(x, y) < 1.25;
      if (nearby) engine?.setPointer(x, y, true);
      else engine?.clearPointer();
    };

    media.addEventListener?.('change', handleMotionPreference);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pointermove', handlePointer, { passive: true });

    return () => {
      media.removeEventListener?.('change', handleMotionPreference);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pointermove', handlePointer);
      engine?.destroy();
      engineRef.current = null;
    };
  }, [hidden]);

  useEffect(() => () => {
    if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
  }, []);

  const changeVisibility = (nextHidden) => {
    persistHiddenState(nextHidden);
    setHidden(nextHidden);
  };

  const interact = () => {
    const nextReaction = engineRef.current?.react() || CAT_PET_REACTION.HEAD_TILT;
    setReaction(nextReaction);
    setReactionKey((current) => current + 1);
    if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = window.setTimeout(() => setReaction(null), 1200);
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    interact();
  };

  if (hidden) {
    return (
      <button
        type="button"
        className="cat-pet-restore"
        onClick={() => changeVisibility(false)}
        aria-label="显示页面宠物"
        title="叫猫回来"
      >
        <PawPrint size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      className={`cat-pet${avoidingControls ? ' is-avoiding-controls' : ''}`}
      aria-label="页面宠物"
    >
      <button
        type="button"
        className="cat-pet-hide"
        onClick={() => changeVisibility(true)}
        aria-label="隐藏页面宠物"
        title="让猫休息"
      >
        <EyeOff size={15} aria-hidden="true" />
      </button>

      <div
        className="cat-pet-stage"
        role="button"
        tabIndex={0}
        aria-label="银白猫页面宠物，点击和它互动"
        title="摸摸它"
        onClick={interact}
        onKeyDown={handleKeyDown}
      >
        {fallback ? <CatPetFallback /> : null}
        <canvas
          ref={canvasRef}
          className={fallback ? 'is-unavailable' : ''}
          aria-hidden="true"
        />
        <span className="cat-pet-ground" aria-hidden="true" />
        {reaction ? (
          <span
            key={reactionKey}
            className={`cat-pet-reaction is-${reaction}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
    </aside>
  );
}
