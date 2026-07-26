import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { assignDriftBottleSlots, chooseDriftBottlePosts } from '../../../utils/driftBottle';
import { BottleIcon } from './BottleIllustration';
import './DriftBottle.css';

const loadDriftBottleExperience = () => import('./DriftBottleExperience');
const DriftBottleExperience = lazy(loadDriftBottleExperience);

export default function DriftBottleControl({ posts, currentPostId, disabled }) {
  const [open, setOpen] = useState(false);
  const [bottles, setBottles] = useState([]);
  const seenIdsRef = useRef(new Set());
  const triggerRef = useRef(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const shouldRestoreFocus = wasOpenRef.current && !open;
    wasOpenRef.current = open;
    if (!shouldRestoreFocus) return undefined;

    const timer = window.setTimeout(() => {
      triggerRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const rememberPosts = useCallback((selected) => {
    selected.forEach((post) => seenIdsRef.current.add(String(post.id)));
  }, []);

  const openExperience = () => {
    const selected = chooseDriftBottlePosts(posts, {
      count: 5,
      currentId: currentPostId,
      seenIds: seenIdsRef.current,
    });
    rememberPosts(selected);
    setBottles(assignDriftBottleSlots(selected));
    setOpen(true);
  };

  const replaceReturnedBottle = useCallback((bottleId) => {
    setBottles((current) => {
      const otherPostIds = current
        .filter((bottle) => bottle.id !== bottleId)
        .map((bottle) => bottle.post.id);
      const replacement = chooseDriftBottlePosts(posts, {
        count: 1,
        currentId: currentPostId,
        seenIds: seenIdsRef.current,
        excludeIds: otherPostIds,
      })[0];

      if (!replacement) return current;
      rememberPosts([replacement]);
      return current.map((bottle) => (
        bottle.id === bottleId ? { ...bottle, post: replacement } : bottle
      ));
    });
  }, [currentPostId, posts, rememberPosts]);

  const closeExperience = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="drift-bottle-trigger"
        disabled={disabled}
        onClick={openExperience}
        onFocus={loadDriftBottleExperience}
        onPointerEnter={loadDriftBottleExperience}
        aria-haspopup="dialog"
      >
        <BottleIcon size={15} />
        <span>漂流瓶</span>
      </button>

      {open ? (
        <Suspense
          fallback={(
            <div className="drift-bottle-loading" role="status">
              正在靠近海面…
            </div>
          )}
        >
          <DriftBottleExperience
            bottles={bottles}
            onBottleReturned={replaceReturnedBottle}
            onClose={closeExperience}
          />
        </Suspense>
      ) : null}
    </>
  );
}
