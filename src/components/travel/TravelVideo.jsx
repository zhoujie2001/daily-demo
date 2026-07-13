import React, { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

export default function TravelVideo({ src, className, style, muted, loop, controls, playsInline, onClick }) {
  const videoRef = useRef(null);
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setHasStarted(true);

    video.addEventListener('play', handlePlay);
    return () => {
      video.removeEventListener('play', handlePlay);
    };
  }, []);

  const requestPlay = async (e) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    try {
      await video.play();
    } catch {
      // Ignore play() rejections. User can still use native controls.
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
        style={style}
      />

      {!hasStarted ? (
        <div className="travel-video-overlay" onClick={requestPlay}>
          <button className="travel-play-btn" type="button" aria-label="Play video" onClick={requestPlay}>
            <Play size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
