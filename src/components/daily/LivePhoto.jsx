import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Camera, CircleDot, MapPin } from 'lucide-react';
import VideoLightbox from '../ui/VideoLightbox';
import {
  formatCamera,
  formatCapturedAt,
  formatPhotoLocation,
  normalizePhotoMetadata,
} from '../../utils/photoMetadata';

let activeLivePhotoStop = null;

export default function LivePhoto({ imageSrc, motionSrc, metadata, title = 'Daily 实况照片' }) {
  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const holdTimerRef = useRef(null);
  const touchStartRef = useRef(null);
  const suppressClickRef = useRef(false);
  const stopRef = useRef(() => {});
  const [motionReady, setMotionReady] = useState(() => typeof IntersectionObserver === 'undefined');
  const [playing, setPlaying] = useState(false);
  const [motionFailed, setMotionFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const photoMetadata = normalizePhotoMetadata(metadata);

  const stopPreview = useCallback(({ reset = true } = {}) => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      if (reset) {
        try {
          video.currentTime = 0;
        } catch {
          // Some mobile browsers reject seeking before metadata is available.
        }
      }
    }
    setPlaying(false);
    if (activeLivePhotoStop === stopRef.current) activeLivePhotoStop = null;
  }, []);

  stopRef.current = stopPreview;

  const startPreview = useCallback(async () => {
    if (!motionSrc || motionFailed) return false;
    setMotionReady(true);
    const video = videoRef.current;
    if (!video) return false;

    if (activeLivePhotoStop && activeLivePhotoStop !== stopRef.current) activeLivePhotoStop();
    activeLivePhotoStop = stopRef.current;
    video.muted = true;
    try {
      await video.play();
      setPlaying(true);
      return true;
    } catch {
      setPlaying(false);
      return false;
    }
  }, [motionFailed, motionSrc]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || motionReady || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMotionReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px', threshold: 0.01 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [motionReady]);

  useEffect(() => () => {
    window.clearTimeout(holdTimerRef.current);
    stopPreview();
  }, [stopPreview]);

  const handlePointerEnter = (event) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (event.pointerType === 'mouse' && !reducedMotion && window.matchMedia('(hover: hover)').matches) startPreview();
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    touchStartRef.current = { x: event.clientX, y: event.clientY };
    holdTimerRef.current = window.setTimeout(async () => {
      if (await startPreview()) suppressClickRef.current = true;
    }, 180);
  };

  const handlePointerMove = (event) => {
    if (!touchStartRef.current) return;
    const distance = Math.hypot(
      event.clientX - touchStartRef.current.x,
      event.clientY - touchStartRef.current.y
    );
    if (distance > 10) {
      window.clearTimeout(holdTimerRef.current);
      touchStartRef.current = null;
      stopPreview();
    }
  };

  const handlePointerEnd = (event) => {
    if (event.pointerType === 'mouse') return;
    window.clearTimeout(holdTimerRef.current);
    touchStartRef.current = null;
    if (playing) stopPreview();
  };

  const handleOpen = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    stopPreview();
    setExpanded(true);
  };

  const visibleMetadata = [
    photoMetadata.showCapturedAt && photoMetadata.capturedAt
      ? { icon: CalendarDays, label: formatCapturedAt(photoMetadata.capturedAt) }
      : null,
    photoMetadata.showLocation && Number.isFinite(photoMetadata.latitude)
      ? { icon: MapPin, label: formatPhotoLocation(photoMetadata) }
      : null,
    photoMetadata.showCamera && (photoMetadata.make || photoMetadata.model)
      ? { icon: Camera, label: formatCamera(photoMetadata) }
      : null,
  ].filter(Boolean);

  return (
    <div ref={rootRef} className="daily-live-photo">
      <button
        type="button"
        className={`daily-live-photo-frame ${playing ? 'is-playing' : ''}`}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => stopPreview()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={handleOpen}
        aria-label="播放实况照片；鼠标悬停或手机长按可预览"
      >
        <img src={imageSrc} alt={title} loading="lazy" decoding="async" className="daily-live-photo-poster" />
        {motionReady && !motionFailed ? (
          <video
            ref={videoRef}
            src={motionSrc}
            muted
            playsInline
            preload="metadata"
            className="daily-live-photo-motion"
            onPlaying={() => setPlaying(true)}
            onEnded={() => stopPreview()}
            onError={() => {
              setMotionFailed(true);
              stopPreview();
            }}
          />
        ) : null}
        {!motionFailed ? (
          <span className="daily-live-photo-badge">
            <CircleDot size={13} /> LIVE
          </span>
        ) : null}
      </button>

      {visibleMetadata.length > 0 ? (
        <div className="daily-photo-metadata" aria-label="照片拍摄信息">
          {visibleMetadata.map(({ icon: Icon, label }) => (
            <span key={label}><Icon size={13} />{label}</span>
          ))}
        </div>
      ) : null}

      {expanded && !motionFailed ? (
        <VideoLightbox src={motionSrc} title={title} onClose={() => setExpanded(false)} />
      ) : null}
    </div>
  );
}
