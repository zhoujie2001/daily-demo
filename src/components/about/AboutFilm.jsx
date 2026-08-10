import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ABOUT_FILMS,
  ABOUT_FILM_PLAY_ATTEMPT_TIMEOUT_MS,
  ABOUT_FILM_RETRY_DELAYS,
  ABOUT_FILM_STALL_RECOVERY_MS,
  shouldCrossfadeAboutFilm,
} from '../../utils/aboutFilm';
import './AboutFilm.css';

const CROSSFADE_DURATION_MS = 1150;

function motionIsEnabled() {
  return typeof window === 'undefined'
    || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function AboutFilm({ onVisibilityChange }) {
  const initialMotionEnabled = motionIsEnabled();
  const sectionRef = useRef(null);
  const videoRefs = useRef([]);
  const activeIndexRef = useRef(0);
  const desiredIndexRef = useRef(0);
  const inViewRef = useRef(true);
  const motionEnabledRef = useRef(initialMotionEnabled);
  const playbackStateRef = useRef('loading');
  const playbackRequestRef = useRef(0);
  const transitionStartedRef = useRef(false);
  const retryTimerRef = useRef(null);
  const stallTimerRef = useRef(null);
  const crossfadeTimerRef = useRef(null);
  const lastInteractionRecoveryRef = useRef(0);

  const [activeIndex, setActiveIndex] = useState(0);
  const [inView, setInView] = useState(true);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [playbackState, setPlaybackState] = useState('loading');
  const [motionEnabled, setMotionEnabled] = useState(initialMotionEnabled);

  const updatePlaybackState = useCallback((nextState) => {
    playbackStateRef.current = nextState;
    setPlaybackState(nextState);
  }, []);

  const clearRetryTimer = useCallback(() => {
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const clearStallTimer = useCallback(() => {
    window.clearTimeout(stallTimerRef.current);
    stallTimerRef.current = null;
  }, []);

  const clearCrossfadeTimer = useCallback(() => {
    window.clearTimeout(crossfadeTimerRef.current);
    crossfadeTimerRef.current = null;
  }, []);

  const pauseAll = useCallback(() => {
    videoRefs.current.forEach((video) => video?.pause());
  }, []);

  const cancelPlaybackRequest = useCallback(() => {
    playbackRequestRef.current += 1;
    clearRetryTimer();
  }, [clearRetryTimer]);

  const suspendPlayback = useCallback(() => {
    cancelPlaybackRequest();
    clearStallTimer();
    clearCrossfadeTimer();
    pauseAll();
    updatePlaybackState('paused');
  }, [
    cancelPlaybackRequest,
    clearCrossfadeTimer,
    clearStallTimer,
    pauseAll,
    updatePlaybackState,
  ]);

  const canPlayNow = useCallback(() => (
    motionEnabledRef.current
    && inViewRef.current
    && !document.hidden
  ), []);

  const playAt = useCallback(async (index, reset = false) => {
    const video = videoRefs.current[index];
    if (!video || !canPlayNow()) return false;
    let attemptTimeout = null;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;

    try {
      if (video.error) video.load();
      if (
        reset
        || video.ended
        || (
          Number.isFinite(video.duration)
          && video.duration > 0
          && video.currentTime >= video.duration - 0.05
        )
      ) {
        video.currentTime = 0;
      }
      const playbackStarted = await Promise.race([
        Promise.resolve(video.play()).then(() => true, () => false),
        new Promise((resolve) => {
          attemptTimeout = window.setTimeout(
            () => resolve(false),
            ABOUT_FILM_PLAY_ATTEMPT_TIMEOUT_MS
          );
        }),
      ]);
      if (!playbackStarted) {
        video.pause();
        return false;
      }
      return !video.paused && !video.ended;
    } catch {
      return false;
    } finally {
      window.clearTimeout(attemptTimeout);
    }
  }, [canPlayNow]);

  const commitActiveFilm = useCallback((index) => {
    const previousIndex = activeIndexRef.current;
    activeIndexRef.current = index;
    desiredIndexRef.current = index;
    setActiveIndex(index);

    if (previousIndex === index) return;
    clearCrossfadeTimer();
    crossfadeTimerRef.current = window.setTimeout(() => {
      const previousVideo = videoRefs.current[previousIndex];
      if (previousIndex !== activeIndexRef.current) previousVideo?.pause();
    }, CROSSFADE_DURATION_MS);
  }, [clearCrossfadeTimer]);

  const requestPlayback = useCallback((index, options = {}) => {
    const {
      reset = false,
      onFailure,
      onSuccess,
    } = options;

    cancelPlaybackRequest();
    clearStallTimer();
    desiredIndexRef.current = index;
    const requestId = playbackRequestRef.current;
    let attemptIndex = 0;
    updatePlaybackState('loading');

    const attemptPlayback = async () => {
      if (requestId !== playbackRequestRef.current) return;
      if (!canPlayNow()) {
        updatePlaybackState('paused');
        return;
      }

      const started = await playAt(index, reset && attemptIndex === 0);
      if (requestId !== playbackRequestRef.current) {
        if (index !== activeIndexRef.current) videoRefs.current[index]?.pause();
        return;
      }

      if (started) {
        commitActiveFilm(index);
        setHasPlayed(true);
        updatePlaybackState('playing');
        onSuccess?.();
        return;
      }

      attemptIndex += 1;
      if (attemptIndex < ABOUT_FILM_RETRY_DELAYS.length) {
        updatePlaybackState('retrying');
        retryTimerRef.current = window.setTimeout(
          attemptPlayback,
          ABOUT_FILM_RETRY_DELAYS[attemptIndex]
        );
        return;
      }

      updatePlaybackState('error');
      onFailure?.();
    };

    attemptPlayback();
  }, [
    canPlayNow,
    cancelPlaybackRequest,
    clearStallTimer,
    commitActiveFilm,
    playAt,
    updatePlaybackState,
  ]);

  const restartSequence = useCallback(() => {
    transitionStartedRef.current = false;
    requestPlayback(0, { reset: true });
  }, [requestPlayback]);

  const beginSecondFilm = useCallback(() => {
    if (transitionStartedRef.current || activeIndexRef.current !== 0) return;
    transitionStartedRef.current = true;
    requestPlayback(1, {
      reset: true,
      onFailure: () => {
        transitionStartedRef.current = false;
        requestPlayback(0, { reset: true });
      },
    });
  }, [requestPlayback]);

  const scheduleRecovery = useCallback((index, delay = ABOUT_FILM_STALL_RECOVERY_MS) => {
    if (index !== activeIndexRef.current || !canPlayNow()) return;
    clearStallTimer();
    updatePlaybackState('stalled');
    stallTimerRef.current = window.setTimeout(() => {
      if (index === activeIndexRef.current && canPlayNow()) {
        requestPlayback(index, { reset: false });
      }
    }, delay);
  }, [canPlayNow, clearStallTimer, requestPlayback, updatePlaybackState]);

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotionPreference = () => {
      const nextEnabled = !motionQuery.matches;
      motionEnabledRef.current = nextEnabled;
      setMotionEnabled(nextEnabled);
      if (nextEnabled && inViewRef.current && !document.hidden) {
        requestPlayback(activeIndexRef.current, { reset: false });
      } else {
        suspendPlayback();
      }
    };

    syncMotionPreference();
    motionQuery.addEventListener?.('change', syncMotionPreference);
    return () => motionQuery.removeEventListener?.('change', syncMotionPreference);
  }, [requestPlayback, suspendPlayback]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === 'undefined') {
      inViewRef.current = true;
      setInView(true);
      onVisibilityChange?.(true);
      requestPlayback(activeIndexRef.current, { reset: false });
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting && entry.intersectionRatio >= 0.18;
        inViewRef.current = visible;
        setInView(visible);
        onVisibilityChange?.(visible);
        if (visible && motionEnabledRef.current && !document.hidden) {
          requestPlayback(activeIndexRef.current, { reset: false });
        } else {
          suspendPlayback();
        }
      },
      { threshold: [0, 0.18, 0.5] }
    );

    observer.observe(section);
    return () => {
      observer.disconnect();
      onVisibilityChange?.(false);
    };
  }, [onVisibilityChange, requestPlayback, suspendPlayback]);

  useEffect(() => {
    const recoverActiveFilm = () => {
      if (!canPlayNow()) return;
      requestPlayback(activeIndexRef.current, { reset: false });
    };
    const handleVisibility = () => {
      if (document.hidden) suspendPlayback();
      else recoverActiveFilm();
    };
    const recoverOnInteraction = () => {
      const activeVideo = videoRefs.current[activeIndexRef.current];
      if (
        activeVideo
        && !activeVideo.paused
        && !activeVideo.ended
        && playbackStateRef.current === 'playing'
      ) return;

      const now = Date.now();
      if (now - lastInteractionRecoveryRef.current < 500) return;
      lastInteractionRecoveryRef.current = now;
      recoverActiveFilm();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', recoverActiveFilm);
    window.addEventListener('online', recoverActiveFilm);
    window.addEventListener('pointerdown', recoverOnInteraction, { passive: true });
    window.addEventListener('touchstart', recoverOnInteraction, { passive: true });
    window.addEventListener('keydown', recoverOnInteraction);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', recoverActiveFilm);
      window.removeEventListener('online', recoverActiveFilm);
      window.removeEventListener('pointerdown', recoverOnInteraction);
      window.removeEventListener('touchstart', recoverOnInteraction);
      window.removeEventListener('keydown', recoverOnInteraction);
    };
  }, [canPlayNow, requestPlayback, suspendPlayback]);

  useEffect(() => () => {
    playbackRequestRef.current += 1;
    clearRetryTimer();
    clearStallTimer();
    clearCrossfadeTimer();
    pauseAll();
  }, [clearCrossfadeTimer, clearRetryTimer, clearStallTimer, pauseAll]);

  const handleTimeUpdate = (index, event) => {
    const { currentTime, duration } = event.currentTarget;
    if (shouldCrossfadeAboutFilm({ index, currentTime, duration })) {
      beginSecondFilm();
    }
  };

  const handleEnded = (index) => {
    if (index === 0) beginSecondFilm();
    else restartSequence();
  };

  const handlePlaying = (index) => {
    if (index !== desiredIndexRef.current) return;
    clearStallTimer();
    setHasPlayed(true);
    updatePlaybackState('playing');
  };

  const handlePlaybackInterruption = (index) => {
    scheduleRecovery(index);
  };

  const handlePlaybackError = (index) => {
    scheduleRecovery(index, 250);
  };

  return (
    <div
      ref={sectionRef}
      className={[
        'about-film',
        hasPlayed ? 'is-ready' : '',
        motionEnabled ? 'is-motion-enabled' : 'is-motion-reduced',
        `is-playback-${playbackState}`,
      ].filter(Boolean).join(' ')}
      data-active-film={ABOUT_FILMS[activeIndex].id}
      data-motion={motionEnabled ? 'video' : 'poster'}
      data-playback={playbackState}
      data-in-view={inView ? 'true' : 'false'}
    >
      <picture className="about-film-poster" aria-hidden="true">
        <source
          media="(max-width: 700px)"
          srcSet="/media/about/poster-mobile.webp"
        />
        <img
          src="/media/about/poster-desktop.webp"
          alt=""
          fetchPriority="high"
        />
      </picture>

      <div className="about-film-videos" aria-hidden="true">
        {ABOUT_FILMS.map((film, index) => (
          <video
            key={film.id}
            ref={(element) => { videoRefs.current[index] = element; }}
            className={[
              'about-film-video',
              activeIndex === index ? 'is-active' : '',
            ].filter(Boolean).join(' ')}
            src={film.src}
            autoPlay={motionEnabled && index === 0}
            muted
            defaultMuted
            playsInline
            disablePictureInPicture
            preload={motionEnabled ? 'auto' : 'metadata'}
            poster={index === 0 ? '/media/about/poster-desktop.webp' : undefined}
            onPlaying={() => handlePlaying(index)}
            onWaiting={() => handlePlaybackInterruption(index)}
            onStalled={() => handlePlaybackInterruption(index)}
            onError={() => handlePlaybackError(index)}
            onTimeUpdate={(event) => handleTimeUpdate(index, event)}
            onEnded={() => handleEnded(index)}
          />
        ))}
      </div>

      <div className="about-film-wash" aria-hidden="true" />
    </div>
  );
}
