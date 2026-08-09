import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Film, Pause, Play, RotateCcw } from 'lucide-react';
import {
  ABOUT_FILMS,
  getAboutFilmProgress,
  shouldAutoplayAboutFilm,
  shouldCrossfadeAboutFilm,
} from '../../utils/aboutFilm';
import './AboutFilm.css';

const DESKTOP_QUERY = '(min-width: 701px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readPlaybackPolicy() {
  const connection = navigator.connection
    || navigator.mozConnection
    || navigator.webkitConnection;
  return {
    desktop: window.matchMedia(DESKTOP_QUERY).matches,
    reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
    saveData: Boolean(connection?.saveData),
    effectiveType: connection?.effectiveType || '',
  };
}

export default function AboutFilm({ onVisibilityChange }) {
  const sectionRef = useRef(null);
  const videoRefs = useRef([]);
  const transitionStartedRef = useRef(false);
  const [policy, setPolicy] = useState(() => ({
    desktop: false,
    reducedMotion: false,
    saveData: false,
    effectiveType: '',
  }));
  const [activeIndex, setActiveIndex] = useState(0);
  const [durations, setDurations] = useState([0, 0]);
  const [inView, setInView] = useState(true);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [manualPaused, setManualPaused] = useState(false);
  const [userActivated, setUserActivated] = useState(false);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState(0);

  const autoPlayEnabled = useMemo(
    () => shouldAutoplayAboutFilm(policy),
    [policy]
  );
  const motionEnabled = autoPlayEnabled || userActivated;

  const pauseAll = useCallback(() => {
    videoRefs.current.forEach((video) => video?.pause());
  }, []);

  const playAt = useCallback(async (index) => {
    const video = videoRefs.current[index];
    if (!video) return false;
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const desktopQuery = window.matchMedia(DESKTOP_QUERY);
    const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const connection = navigator.connection
      || navigator.mozConnection
      || navigator.webkitConnection;
    const updatePolicy = () => setPolicy(readPlaybackPolicy());

    updatePolicy();
    desktopQuery.addEventListener?.('change', updatePolicy);
    motionQuery.addEventListener?.('change', updatePolicy);
    connection?.addEventListener?.('change', updatePolicy);
    return () => {
      desktopQuery.removeEventListener?.('change', updatePolicy);
      motionQuery.removeEventListener?.('change', updatePolicy);
      connection?.removeEventListener?.('change', updatePolicy);
    };
  }, []);

  useEffect(() => {
    if (!autoPlayEnabled) return;
    videoRefs.current.forEach((video) => {
      if (!video) return;
      video.preload = 'auto';
      video.load();
    });
  }, [autoPlayEnabled]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === 'undefined') {
      onVisibilityChange?.(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting && entry.intersectionRatio >= 0.18;
        setInView(visible);
        onVisibilityChange?.(visible);
      },
      { threshold: [0, 0.18, 0.5] }
    );
    observer.observe(section);
    return () => {
      observer.disconnect();
      onVisibilityChange?.(false);
    };
  }, [onVisibilityChange]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) pauseAll();
      else if (inView && motionEnabled && !manualPaused && !ended) {
        playAt(activeIndex);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeIndex, ended, inView, manualPaused, motionEnabled, pauseAll, playAt]);

  useEffect(() => {
    if (inView && motionEnabled && !manualPaused && !ended) {
      playAt(activeIndex);
    } else {
      pauseAll();
    }
  }, [activeIndex, ended, inView, manualPaused, motionEnabled, pauseAll, playAt]);

  const updateDuration = (index, duration) => {
    setDurations((current) => current.map((value, itemIndex) => (
      itemIndex === index ? duration : value
    )));
  };

  const beginSecondFilm = async () => {
    if (transitionStartedRef.current) return;
    transitionStartedRef.current = true;
    const second = videoRefs.current[1];
    if (second) second.currentTime = 0;
    setActiveIndex(1);
    await playAt(1);
  };

  const handleTimeUpdate = (index, event) => {
    const { currentTime, duration } = event.currentTarget;
    setProgress(getAboutFilmProgress(index, currentTime, durations));
    if (
      motionEnabled
      && shouldCrossfadeAboutFilm({ index, currentTime, duration })
    ) {
      beginSecondFilm();
    }
  };

  const handleEnded = (index) => {
    if (index === 0) {
      beginSecondFilm();
      return;
    }
    setEnded(true);
    setPlaying(false);
    setProgress(1);
  };

  const restart = async () => {
    pauseAll();
    transitionStartedRef.current = false;
    videoRefs.current.forEach((video) => {
      if (video) video.currentTime = 0;
    });
    setActiveIndex(0);
    setEnded(false);
    setProgress(0);
    setManualPaused(false);
    setUserActivated(true);
    await playAt(0);
  };

  const togglePlayback = async () => {
    setUserActivated(true);
    if (ended) {
      await restart();
      return;
    }
    if (playing) {
      setManualPaused(true);
      pauseAll();
      return;
    }
    setManualPaused(false);
    await playAt(activeIndex);
  };

  const controlLabel = ended
    ? '重新播放背景短片'
    : playing
      ? '暂停背景短片'
      : motionEnabled
        ? '继续播放背景短片'
        : '播放背景短片';
  const ControlIcon = ended ? RotateCcw : playing ? Pause : Play;

  return (
    <div
      ref={sectionRef}
      className={[
        'about-film',
        ready ? 'is-ready' : '',
        motionEnabled ? 'is-motion-enabled' : '',
        userActivated ? 'is-user-activated' : '',
        ended ? 'is-ended' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--about-film-progress': progress }}
      data-active-film={ABOUT_FILMS[activeIndex].id}
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
            muted
            playsInline
            preload="metadata"
            poster={index === 0 ? '/media/about/poster-desktop.webp' : undefined}
            onCanPlay={() => index === 0 && setReady(true)}
            onPlay={() => setPlaying(true)}
            onPause={(event) => {
              if (event.currentTarget.classList.contains('is-active')) {
                setPlaying(false);
              }
            }}
            onLoadedMetadata={(event) => updateDuration(index, event.currentTarget.duration)}
            onTimeUpdate={(event) => handleTimeUpdate(index, event)}
            onEnded={() => handleEnded(index)}
          />
        ))}
      </div>

      <div className="about-film-wash" aria-hidden="true" />

      <button
        type="button"
        className="about-film-control"
        onClick={togglePlayback}
        aria-label={controlLabel}
        title={controlLabel}
      >
        <Film size={14} aria-hidden="true" className="about-film-control-film" />
        <span className="about-film-control-copy">
          {ABOUT_FILMS[activeIndex].label}
        </span>
        <ControlIcon size={14} aria-hidden="true" />
        <span className="about-film-control-progress" aria-hidden="true">
          <span />
        </span>
      </button>

      <span className="sr-only" aria-live="polite">
        {playing
          ? `正在静音播放《${ABOUT_FILMS[activeIndex].label}》`
          : `背景短片《${ABOUT_FILMS[activeIndex].label}》已暂停`}
      </span>
    </div>
  );
}
