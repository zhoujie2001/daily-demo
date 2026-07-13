import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';

export default function TravelVideo({
  src,
  poster,
  className,
  style,
  muted,
  loop,
  controls,
  playsInline,
  onClick,
}) {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [framePoster, setFramePoster] = useState(null);

  const mergedPoster = useMemo(() => poster || framePoster || undefined, [poster, framePoster]);

  const captureFirstFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || poster || framePoster) return;
    if (!video.videoWidth || !video.videoHeight) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      setFramePoster(canvas.toDataURL('image/jpeg', 0.8));
    } catch {
      // Canvas can fail on cross-origin videos without proper CORS headers.
      // In that case, we just fallback to the default poster/black background.
    }
  }, [poster, framePoster]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handlePause);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handlePause);
    };
  }, []);

  const handleRequestPlay = async (e) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    try {
      await video.play();
    } catch {
      // Ignore play() rejections (e.g., browser policy). User can still use controls.
    }
  };

  return (
    <div className={`travel-video-shell ${className || ''}`} onClick={onClick}>
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        loop={loop}
        controls={controls}
        playsInline={playsInline}
        preload="metadata"
        poster={mergedPoster}
        onLoadedData={captureFirstFrame}
        style={style}
      />

      {!isPlaying ? (
        <div className="travel-video-overlay">
          <button
            className="travel-play-btn"
            type="button"
            aria-label="Play video"
            onClick={handleRequestPlay}
          >
            <Play size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
