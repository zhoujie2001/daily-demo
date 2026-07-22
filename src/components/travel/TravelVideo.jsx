import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function TravelVideo({
  src,
  className,
  style,
  muted,
  loop,
  controls,
  playsInline,
  autoPlay,
  disableHover,
  onClick,
  title,
}) {
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isNearViewport, setIsNearViewport] = useState(
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

  const canHover = useMemo(() => {
    if (disableHover) return false;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }, [disableHover]);

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
    height: '100%',
    objectFit: style?.objectFit,
    display: 'block',
  };

  const effectiveControls = canHover ? false : controls;
  const effectiveMuted = canHover ? true : muted;

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
      aria-label={onClick ? `播放旅行视频${title ? `：${title}` : ''}` : undefined}
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
