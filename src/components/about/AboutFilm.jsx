import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ABOUT_FILMS,
  shouldCrossfadeAboutFilm,
} from '../../utils/aboutFilm';
import './AboutFilm.css';

export default function AboutFilm({ onVisibilityChange }) {
  const sectionRef = useRef(null);
  const videoRefs = useRef([]);
  const transitionStartedRef = useRef(false);
  const playbackRetryRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [inView, setInView] = useState(true);
  const [ready, setReady] = useState(false);

  const pauseAll = useCallback(() => {
    videoRefs.current.forEach((video) => video?.pause());
  }, []);

  const playAt = useCallback(async (index) => {
    const video = videoRefs.current[index];
    if (!video) return false;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  }, []);

  const ensurePlayback = useCallback(async (index) => {
    window.clearTimeout(playbackRetryRef.current);
    const started = await playAt(index);
    if (!started && !document.hidden) {
      playbackRetryRef.current = window.setTimeout(() => playAt(index), 350);
    }
    return started;
  }, [playAt]);

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
      else if (inView) ensurePlayback(activeIndex);
    };
    const handlePageShow = () => {
      if (inView) ensurePlayback(activeIndex);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [activeIndex, ensurePlayback, inView, pauseAll]);

  useEffect(() => {
    if (inView) ensurePlayback(activeIndex);
    else pauseAll();
    return () => window.clearTimeout(playbackRetryRef.current);
  }, [activeIndex, ensurePlayback, inView, pauseAll]);

  const beginSecondFilm = async () => {
    if (transitionStartedRef.current) return;
    transitionStartedRef.current = true;
    const second = videoRefs.current[1];
    if (second) second.currentTime = 0;
    const started = await ensurePlayback(1);
    if (started) {
      setActiveIndex(1);
    } else {
      transitionStartedRef.current = false;
    }
  };

  const restartSequence = async () => {
    pauseAll();
    transitionStartedRef.current = false;
    videoRefs.current.forEach((video) => {
      if (video) video.currentTime = 0;
    });
    setActiveIndex(0);
    await ensurePlayback(0);
  };

  const handleTimeUpdate = (index, event) => {
    const { currentTime, duration } = event.currentTarget;
    if (
      shouldCrossfadeAboutFilm({ index, currentTime, duration })
    ) {
      beginSecondFilm();
    }
  };

  const handleEnded = (index) => {
    if (index === 0) {
      beginSecondFilm();
      return;
    }
    restartSequence();
  };

  const handleMediaReady = (index) => {
    if (index === 0) setReady(true);
    if (index === activeIndex && inView) ensurePlayback(index);
  };

  return (
    <div
      ref={sectionRef}
      className={[
        'about-film',
        ready ? 'is-ready' : '',
        'is-motion-enabled',
      ].filter(Boolean).join(' ')}
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
            autoPlay={index === 0}
            muted
            defaultMuted
            playsInline
            preload="auto"
            poster={index === 0 ? '/media/about/poster-desktop.webp' : undefined}
            onCanPlay={() => handleMediaReady(index)}
            onLoadedData={() => handleMediaReady(index)}
            onTimeUpdate={(event) => handleTimeUpdate(index, event)}
            onEnded={() => handleEnded(index)}
          />
        ))}
      </div>

      <div className="about-film-wash" aria-hidden="true" />
    </div>
  );
}
