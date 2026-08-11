import React, { useEffect, useMemo, useRef, useState } from 'react';
import MediaPlaceholder from '../ui/MediaPlaceholder';

export default function TravelVideo({
  src,
  poster,
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
  const [mediaStatus, setMediaStatus] = useState(() => ({
    src,
    state: 'loading',
    retryKey: 0,
  }));
  const mediaState = mediaStatus.src === src ? mediaStatus.state : 'loading';
  const retryKey = mediaStatus.src === src ? mediaStatus.retryKey : 0;
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
    display: 'block',
    lineHeight: 0,
    ...style,
  };

  const videoStyle = {
    width: '100%',
    height: style?.height ?? '100%',
    maxHeight: style?.maxHeight,
    objectFit: style?.objectFit,
    display: 'block',
    opacity: mediaState === 'ready' ? 1 : 0,
    transition: 'opacity 260ms ease',
  };

  const effectiveControls = playWhenVisible || canHover ? false : controls;
  const effectiveMuted = playWhenVisible || canHover ? true : muted;

  return (
    <div
      ref={wrapperRef}
      className={`travel-video-shell is-${mediaState}`}
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
      aria-busy={mediaState === 'loading'}
    >
      {shouldMount ? (
        <video
          key={`${src}-${retryKey}`}
          ref={videoRef}
          src={src}
          poster={poster}
          preload="metadata"
          muted={effectiveMuted}
          loop={loop}
          controls={effectiveControls}
          playsInline={playsInline}
          autoPlay={autoPlay}
          className={className}
          style={videoStyle}
          onLoadedData={() => setMediaStatus((current) => ({
            src,
            state: 'ready',
            retryKey: current.src === src ? current.retryKey : 0,
          }))}
          onCanPlay={() => setMediaStatus((current) => ({
            src,
            state: 'ready',
            retryKey: current.src === src ? current.retryKey : 0,
          }))}
          onError={() => setMediaStatus((current) => ({
            src,
            state: 'error',
            retryKey: current.src === src ? current.retryKey : 0,
          }))}
        />
      ) : null}
      {mediaState !== 'ready' ? (
        <MediaPlaceholder
          kind="video"
          state={mediaState}
          label={mediaState === 'error' ? '视频暂时无法播放' : '视频加载中'}
          title={title || 'Travel'}
          onRetry={mediaState === 'error' ? () => {
            setMediaStatus((current) => ({
              src,
              state: 'loading',
              retryKey: current.src === src ? current.retryKey + 1 : 1,
            }));
          } : undefined}
        />
      ) : null}
    </div>
  );
}
