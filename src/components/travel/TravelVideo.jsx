import React, { useEffect, useMemo, useRef } from 'react';

export default function TravelVideo({
  src,
  className,
  style,
  muted,
  loop,
  controls,
  playsInline,
  autoPlay,
  onClick,
}) {
  const videoRef = useRef(null);

  const canHover = useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!canHover) return;

    const handleMouseEnter = async () => {
      video.muted = true;
      video.controls = false;

      try {
        await video.play();
      } catch {
        // Ignore autoplay policy issues; hover intent may still fail on some browsers.
      }
    };

    const handleMouseLeave = () => {
      video.pause();

      try {
        video.currentTime = 0;
      } catch {
        // Some browsers may throw if video isn't seekable yet.
      }
    };

    video.addEventListener('mouseenter', handleMouseEnter);
    video.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      video.removeEventListener('mouseenter', handleMouseEnter);
      video.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [canHover]);

  const effectiveMuted = canHover ? true : muted;

  return (
    <video
      ref={videoRef}
      src={src}
      preload="metadata"
      muted={effectiveMuted}
      loop={loop}
      controls={controls}
      playsInline={playsInline}
      autoPlay={autoPlay}
      className={className}
      style={style}
      onClick={onClick}
    />
  );
}
