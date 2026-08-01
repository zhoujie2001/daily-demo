import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

function formatPlaybackTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function VideoLightbox({ src, title, onClose }) {
  const videoRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [needsSoundTap, setNeedsSoundTap] = useState(false);
  const [isPaused, setIsPaused] = useState(true);
  const [hasEnded, setHasEnded] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const playWithSound = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return false;

    video.muted = false;
    setIsMuted(false);
    try {
      await video.play();
      setNeedsSoundTap(false);
      setIsLoading(false);
      setHasEnded(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  const startPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return false;

    if (video.ended || (video.duration && video.currentTime >= video.duration)) {
      video.currentTime = 0;
      setCurrentTime(0);
      setHasEnded(false);
    }

    if (await playWithSound()) return true;

    // Audible autoplay can be rejected after React mounts the dialog. Keep the
    // video moving, then let the next real tap enable sound.
    video.muted = true;
    setIsMuted(true);
    try {
      await video.play();
      setNeedsSoundTap(true);
      setIsLoading(false);
      return true;
    } catch {
      setNeedsSoundTap(true);
      setIsLoading(false);
      setIsPaused(true);
      return false;
    }
  }, [playWithSound]);

  const attachVideo = useCallback((video) => {
    const previousVideo = videoRef.current;
    if (!video) {
      previousVideo?.pause();
      videoRef.current = null;
      return;
    }

    videoRef.current = video;
    startPlayback();
  }, [startPlayback]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === ' ' && videoRef.current) {
        event.preventDefault();
        if (videoRef.current.paused) startPlayback();
        else videoRef.current.pause();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, startPlayback]);

  const handlePrimaryPlayback = async (event) => {
    event?.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    if (!video.paused && !video.ended) {
      video.pause();
      return;
    }

    await startPlayback();
  };

  const handleSoundTap = async (event) => {
    event.stopPropagation();
    await playWithSound();
  };

  const handleMuteToggle = (event) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setIsMuted(video.muted);
    if (!video.muted) setNeedsSoundTap(false);
  };

  const handleSeek = (event) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    const nextTime = Number(event.currentTarget.value);
    video.currentTime = nextTime;
    setCurrentTime(nextTime);
    setHasEnded(false);
  };

  const handleRetry = async (event) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    setLoadFailed(false);
    setIsLoading(true);
    setNeedsSoundTap(false);
    setHasEnded(false);
    setCurrentTime(0);
    video.load();
    await startPlayback();
  };

  return createPortal(
    <div
      className="lightbox video-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `播放视频：${title}` : '播放视频'}
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close video-lightbox-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="关闭视频"
      >
        <X size={20} />
      </button>

      <div
        className="lightbox-content video-lightbox-content"
        onClick={(event) => event.stopPropagation()}
      >
        <video
          ref={attachVideo}
          key={src}
          src={src}
          preload="auto"
          playsInline
          className="video-lightbox-media"
          onClick={handlePrimaryPlayback}
          onLoadStart={() => setIsLoading(true)}
          onLoadedMetadata={(event) => {
            setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
          }}
          onLoadedData={() => setIsLoading(false)}
          onCanPlay={() => setIsLoading(false)}
          onPlaying={() => {
            setIsLoading(false);
            setIsPaused(false);
            setHasEnded(false);
          }}
          onPause={() => setIsPaused(true)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onEnded={() => {
            setIsPaused(true);
            setHasEnded(true);
            setNeedsSoundTap(false);
          }}
          onVolumeChange={(event) => setIsMuted(event.currentTarget.muted)}
          onWaiting={() => setIsLoading(true)}
          onError={() => {
            setIsLoading(false);
            setLoadFailed(true);
            setNeedsSoundTap(false);
          }}
        />

        {isLoading && !loadFailed ? (
          <div className="video-lightbox-status" role="status" aria-live="polite">
            <span className="video-lightbox-spinner" aria-hidden="true" />
            <span>正在加载视频…</span>
          </div>
        ) : null}

        {!isLoading && isPaused && !loadFailed ? (
          <button
            type="button"
            className="video-lightbox-primary"
            onClick={handlePrimaryPlayback}
            aria-label={hasEnded ? '重新播放视频' : '播放视频'}
          >
            {hasEnded ? <RotateCcw size={25} /> : <Play size={27} fill="currentColor" />}
          </button>
        ) : null}

        {needsSoundTap && !isPaused && !loadFailed ? (
          <button
            type="button"
            className="video-lightbox-start"
            onClick={handleSoundTap}
          >
            <Volume2 size={19} />
            <span>开启声音</span>
          </button>
        ) : null}

        {loadFailed ? (
          <div className="video-lightbox-status is-error" role="alert">
            <span>视频加载失败</span>
            <button type="button" onClick={handleRetry}>
              <RotateCcw size={16} />
              <span>重新加载</span>
            </button>
          </div>
        ) : null}

        {!loadFailed ? (
          <div className="video-lightbox-controls" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={handlePrimaryPlayback}
              aria-label={isPaused ? (hasEnded ? '重新播放视频' : '播放视频') : '暂停视频'}
            >
              {isPaused ? (
                hasEnded ? <RotateCcw size={19} /> : <Play size={19} fill="currentColor" />
              ) : (
                <Pause size={19} fill="currentColor" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max={duration || 0}
              step="0.05"
              value={Math.min(currentTime, duration || 0)}
              onChange={handleSeek}
              aria-label="视频播放进度"
            />
            <span className="video-lightbox-time">
              {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
            </span>
            <button
              type="button"
              onClick={handleMuteToggle}
              aria-label={isMuted ? '开启声音' : '静音'}
            >
              {isMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
          </div>
        ) : null}

        {title ? (
          <div className="video-lightbox-caption">
            <h3>{title}</h3>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
