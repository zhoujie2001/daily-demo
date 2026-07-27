import React, { useEffect, useRef, useState } from 'react';
import { EyeOff, PawPrint } from 'lucide-react';
import {
  advanceCatPetSchedule,
  blinkAmount,
  CAT_PET_EVENT,
  CAT_PET_REACTION,
  chooseCatPetReaction,
  createCatPetSchedule,
} from '../../utils/catPetBehavior';
import './CatPet.css';

const STORAGE_KEY = 'daily-demo-cat-pet-hidden';
const CAT_ASSET = '/images/cat-pet-2d.png';

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

function clamp(value, min = -1, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function CatPetFallback() {
  return (
    <svg
      className="cat-pet-fallback"
      viewBox="0 0 220 278"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="catFallbackFur" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7f1e8" />
          <stop offset=".58" stopColor="#d7d5d1" />
          <stop offset="1" stopColor="#aaaead" />
        </linearGradient>
        <radialGradient id="catFallbackEye">
          <stop offset="0" stopColor="#d8c35d" />
          <stop offset=".72" stopColor="#9b8b31" />
          <stop offset="1" stopColor="#514a20" />
        </radialGradient>
      </defs>
      <path
        d="M53 242c-11-60-5-116 23-139 10-9 22-14 35-14 15 0 29 7 39 19 24 28 28 83 13 134-18 16-86 17-110 0Z"
        fill="url(#catFallbackFur)"
      />
      <path
        d="M56 116 49 53l42 30c13-5 27-5 40 0l41-30-7 64c7 11 10 24 7 38-6 29-30 48-61 48-33 0-58-19-64-49-3-14 1-27 9-38Z"
        fill="url(#catFallbackFur)"
      />
      <path d="m60 88-5-24 26 20-21 4Zm102 0 5-24-26 20 21 4Z" fill="#d5a7a0" />
      <ellipse cx="87" cy="132" rx="13" ry="10" fill="url(#catFallbackEye)" />
      <ellipse cx="137" cy="132" rx="13" ry="10" fill="url(#catFallbackEye)" />
      <ellipse cx="87" cy="132" rx="2.6" ry="8" fill="#24231f" />
      <ellipse cx="137" cy="132" rx="2.6" ry="8" fill="#24231f" />
      <circle cx="83" cy="128" r="2.2" fill="#fff" />
      <circle cx="133" cy="128" r="2.2" fill="#fff" />
      <path d="m103 151 9-5 9 5-9 9-9-9Z" fill="#b26c61" />
      <path
        d="M105 98c2-11 5-19 7-25 3 7 6 14 8 25M91 101c3-9 7-16 12-21m31 21c-3-9-7-16-12-21"
        fill="none"
        stroke="#777b7b"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M79 170c-19 10-29 33-24 52m113-54c24 12 33 34 22 55"
        fill="none"
        stroke="#f7f1e8"
        strokeWidth="22"
        strokeLinecap="round"
      />
      <path
        d="M153 226c37-5 55 7 54 24-2 19-32 22-77 6 31 0 46-6 44-17-2-7-9-11-21-13Z"
        fill="#c3c5c3"
      />
    </svg>
  );
}

function CatArtLayer({ className, onError }) {
  return (
    <img
      className={className}
      src={CAT_ASSET}
      alt=""
      aria-hidden="true"
      draggable="false"
      onError={onError}
    />
  );
}

export default function CatPet() {
  const stageRef = useRef(null);
  const reactionTimerRef = useRef(null);
  const previousReactionRef = useRef(null);
  const [hidden, setHidden] = useState(readInitialHiddenState);
  const [assetFailed, setAssetFailed] = useState(false);
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
    if (hidden || !stageRef.current) return undefined;

    const stage = stageRef.current;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = media.matches;
    let frame = null;
    let running = true;
    let schedule = createCatPetSchedule(performance.now());
    const pointerTarget = { x: 0, y: 0, nearby: false };
    const pointer = { x: 0, y: 0 };

    const render = (time) => {
      if (!running) return;

      const advanced = advanceCatPetSchedule(schedule, time);
      schedule = advanced.schedule;
      const active = advanced.active;
      const blink = blinkAmount(active[CAT_PET_EVENT.BLINK] || 0);
      const earProgress = active[CAT_PET_EVENT.EAR_FLICK] || 0;
      const lookProgress = active[CAT_PET_EVENT.LOOK_AROUND] || 0;
      const lookArc = Math.sin(lookProgress * Math.PI * 2);
      const targetX = pointerTarget.nearby ? pointerTarget.x : lookArc * 0.48;
      const targetY = pointerTarget.nearby ? pointerTarget.y : 0;

      pointer.x += (targetX - pointer.x) * 0.075;
      pointer.y += (targetY - pointer.y) * 0.075;

      const breath = reducedMotion ? 0 : Math.sin(time * 0.0015) * 1.35;
      const tail = reducedMotion
        ? 0
        : Math.sin(time * 0.00082) * 1.25 + Math.sin(time * 0.0017) * 0.4;
      const ear = reducedMotion
        ? 0
        : Math.sin(earProgress * Math.PI * 3) * 3.2;

      stage.style.setProperty('--blink', reducedMotion ? '0' : String(blink));
      stage.style.setProperty('--look-x', `${pointer.x * 2.2}px`);
      stage.style.setProperty('--look-y', `${pointer.y * 1.35}px`);
      stage.style.setProperty('--eye-x', `${pointer.x * 1.4}px`);
      stage.style.setProperty('--eye-y', `${pointer.y * 0.9}px`);
      stage.style.setProperty('--head-angle', `${pointer.x * 1.15}deg`);
      stage.style.setProperty('--ear-flick', `${ear}deg`);
      stage.style.setProperty('--tail-angle', `${tail}deg`);
      stage.style.setProperty('--breath', `${breath}px`);

      frame = window.requestAnimationFrame(render);
    };

    const start = () => {
      if (frame !== null) return;
      running = true;
      frame = window.requestAnimationFrame(render);
    };
    const stop = () => {
      running = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const handleMotionPreference = (event) => {
      reducedMotion = event.matches;
    };
    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const handlePointer = (event) => {
      const rect = stage.getBoundingClientRect();
      const centerX = rect.left + rect.width * 0.42;
      const centerY = rect.top + rect.height * 0.28;
      const distanceX = (event.clientX - centerX) / Math.max(window.innerWidth * 0.34, 1);
      const distanceY = (event.clientY - centerY) / Math.max(window.innerHeight * 0.34, 1);

      pointerTarget.x = clamp(distanceX);
      pointerTarget.y = clamp(distanceY);
      pointerTarget.nearby = Math.hypot(distanceX, distanceY) < 1.45;
    };

    media.addEventListener?.('change', handleMotionPreference);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pointermove', handlePointer, { passive: true });
    frame = window.requestAnimationFrame(render);

    return () => {
      media.removeEventListener?.('change', handleMotionPreference);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pointermove', handlePointer);
      stop();
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
    const nextReaction = chooseCatPetReaction(previousReactionRef.current);
    previousReactionRef.current = nextReaction;
    setReaction(nextReaction);
    setReactionKey((current) => current + 1);

    if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = window.setTimeout(() => setReaction(null), 1250);
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
        ref={stageRef}
        className={`cat-pet-stage${reaction ? ` is-${reaction}` : ''}`}
        role="button"
        tabIndex={0}
        aria-label="银白猫页面宠物，点击和它互动"
        title="摸摸它"
        onClick={interact}
        onKeyDown={handleKeyDown}
      >
        {assetFailed ? (
          <CatPetFallback />
        ) : (
          <span className="cat-pet-character" aria-hidden="true">
            <CatArtLayer
              className="cat-pet-art"
              onError={() => setAssetFailed(true)}
            />
            <CatArtLayer className="cat-pet-tail-layer" />
            <CatArtLayer className="cat-pet-head-layer" />
            <CatArtLayer className="cat-pet-ear-layer is-left" />
            <CatArtLayer className="cat-pet-ear-layer is-right" />
            <span className="cat-pet-paw-mask" />
            <CatArtLayer className="cat-pet-paw-layer" />

            <span className="cat-pet-eyelid is-left" />
            <span className="cat-pet-eyelid is-right" />
            <span className="cat-pet-eye-shine is-left" />
            <span className="cat-pet-eye-shine is-right" />
          </span>
        )}

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
