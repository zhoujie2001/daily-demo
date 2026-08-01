import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Volume2, X } from 'lucide-react';

export default function VideoLightbox({ src, title, onClose }) {
  const videoRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [needsSoundTap, setNeedsSoundTap] = useState(false);

  const playWithSound = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return false;

    video.muted = false;
    try {
      await video.play();
      setNeedsSoundTap(false);
      setIsLoading(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  const startPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    if (await playWithSound()) return;

    // Audible autoplay is commonly rejected after React mounts the dialog.
    // Keep the media visibly playing and let the next real tap enable sound.
    video.muted = true;
    try {
      await video.play();
      setNeedsSoundTap(true);
      setIsLoading(false);
    } catch {
      setNeedsSoundTap(true);
      setIsLoading(false);
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const handleSoundTap = async (event) => {
    event.stopPropagation();
    await playWithSound();
  };

  const handleRetry = async (event) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    setLoadFailed(false);
    setIsLoading(true);
    setNeedsSoundTap(false);
    video.load();
    await startPlayback();
  };

  return (
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
          controls
          playsInline
          className="video-lightbox-media"
          onLoadStart={() => setIsLoading(true)}
          onLoadedData={() => setIsLoading(false)}
          onCanPlay={() => setIsLoading(false)}
          onPlaying={() => setIsLoading(false)}
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

        {needsSoundTap && !loadFailed ? (
          <button
            type="button"
            className="video-lightbox-start"
            onClick={handleSoundTap}
          >
            <Volume2 size={19} />
            <span>播放并开启声音</span>
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

        {title ? (
          <div className="video-lightbox-caption">
            <h3>{title}</h3>
          </div>
        ) : null}
      </div>
    </div>
  );
}
