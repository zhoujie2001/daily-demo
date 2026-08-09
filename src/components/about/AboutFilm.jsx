import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ABOUT_FILMS,
  shouldAutoplayAboutFilm,
  shouldCrossfadeAboutFilm,
} from '../../utils/aboutFilm';
import './AboutFilm.css';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readPlaybackPolicy() {
  return {
    reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
  };
}

export default function AboutFilm({ onVisibilityChange }) {
  const sectionRef = useRef(null);
  const videoRefs = useRef([]);
  const transitionStartedRef = useRef(false);
  const [policy, setPolicy] = useState(() => ({ reducedMotion: false }));
  const [activeIndex, setActiveIndex] = useState(0);
  const [inView, setInView] = useState(true);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);

  const motionEnabled = shouldAutoplayAboutFilm(policy);

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
    const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const updatePolicy = () => setPolicy(readPlaybackPolicy());

    updatePolicy();
    motionQuery.addEventListener?.('change', updatePolicy);
    return () => motionQuery.removeEventListener?.('change', updatePolicy);
  }, []);

  useEffect(() => {
    if (!motionEnabled) return;
    videoRefs.current.forEach((video) => {
      if (!video) return;
      video.preload = 'auto';
      video.load();
    });
  }, [motionEnabled]);

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
      else if (inView && motionEnabled && !ended) playAt(activeIndex);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeIndex, ended, inView, motionEnabled, pauseAll, playAt]);

  useEffect(() => {
    if (inView && motionEnabled && !ended) playAt(activeIndex);
    else pauseAll();
  }, [activeIndex, ended, inView, motionEnabled, pauseAll, playAt]);

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
  };

  return (
    <div
      ref={sectionRef}
      className={[
        'about-film',
        ready ? 'is-ready' : '',
        motionEnabled ? 'is-motion-enabled' : '',
        ended ? 'is-ended' : '',
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
            autoPlay={index === 0 && motionEnabled}
            muted
            playsInline
            preload="auto"
            poster={index === 0 ? '/media/about/poster-desktop.webp' : undefined}
            onCanPlay={() => index === 0 && setReady(true)}
            onTimeUpdate={(event) => handleTimeUpdate(index, event)}
            onEnded={() => handleEnded(index)}
          />
        ))}
      </div>

      <div className="about-film-wash" aria-hidden="true" />
    </div>
  );
}
