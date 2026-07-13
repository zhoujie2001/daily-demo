import React, { useMemo, useRef } from 'react';

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
}) {
  const videoRef = useRef(null);

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
      style={wrapperStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
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
    </div>
  );
}
