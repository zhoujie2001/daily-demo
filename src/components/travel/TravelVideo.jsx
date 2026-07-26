import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function TravelVideo({
  src,
  className,
  style,
  muted = false,
  loop = false,
  controls = false,
  playsInline = true,
  autoPlay = false,
  playWhenVisible = false,
  disableHover = false,
  onClick,
  title,
}) {
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isNearViewport, setIsNearViewport] = useState(
    () => typeof IntersectionObserver !== 'function'
  );
  const [isPlaybackVisible, setIsPlaybackVisible] = useState(
    () => typeof IntersectionObserver !== 'function'
  );
  const shouldMount = Boolean(autoPlay) || isNearViewport;

  useEffect(() => {
    if (autoPlay || typeof IntersectionObserver !== 'function') return undefined;

    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting);
      },
      {
        rootMargin: '160px',
        threshold: 0.01,
      }
    );

    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [autoPlay]);

  useEffect(() => {
    if (autoPlay || !playWhenVisible || typeof IntersectionObserver !== 'function') {
      return undefined;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsPlaybackVisible(entry.isIntersecting && entry.intersectionRatio >= 0.35);
      },
      {
        threshold: [0, 0.35, 0.75],
      }
    );

    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [autoPlay, playWhenVisible]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    if (autoPlay) {
      video.muted = Boolean(muted);
      const playback = video.play();
      playback?.catch(() => {
        // Controls remain available if the browser blocks audible autoplay.
      });
      return undefined;
    }

    if (!playWhenVisible || !isPlaybackVisible) {
      video.pause();
      return undefined;
    }

    video.muted = true;
    const playback = video.play();
    playback?.catch(() => {
      // Muted playback can still be blocked by device-level media policies.
    });

    return () => {
      video.pause();
    };
  }, [autoPlay, isPlaybackVisible, muted, playWhenVisible, shouldMount, src]);

  const canHover = useMemo(() => {
    if (disableHover || playWhenVisible) return false;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }, [disableHover, playWhenVisible]);

  const handleMouseEnter = async () => {
    if (!canHover) return;
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;

    try {
      await video.play();
    } catch {
      // Ignore autoplay policy issues.
    }
  };

  const handleMouseLeave = () => {
    if (!canHover) return;
    const video = videoRef.current;
    if (!video) return;

    video.pause();

    try {
      video.currentTime = 0;
    } catch {
      // Some browsers may throw if video isn't seekable yet.
    }
  };

  const wrapperStyle = {
    position: 'relative',
    display: 'inline-block',
    lineHeight: 0,
    ...style,
  };

  const videoStyle = {
    width: '100%',
    height: style?.height ?? '100%',
    maxHeight: style?.maxHeight,
    objectFit: style?.objectFit,
    display: 'block',
  };

  const effectiveControls = playWhenVisible || canHover ? false : controls;
  const effectiveMuted = playWhenVisible || canHover ? true : muted;

  return (
    <div
      ref={wrapperRef}
      style={wrapperStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onClick();
      }}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `播放视频${title ? `：${title}` : ''}` : undefined}
    >
      {shouldMount ? (
        <video
          ref={videoRef}
          src={src}
          preload="metadata"
          muted={effectiveMuted}
          loop={loop}
          controls={effectiveControls}
          playsInline={playsInline}
          autoPlay={autoPlay}
          className={className}
          style={videoStyle}
        />
      ) : (
        <div className="travel-video-placeholder" style={videoStyle} aria-hidden="true">
          <span>{title || 'Travel'}</span>
        </div>
      )}
    </div>
  );
}
