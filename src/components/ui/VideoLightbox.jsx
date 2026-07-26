import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import TravelVideo from '../travel/TravelVideo';

export default function VideoLightbox({ src, title, onClose }) {
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
        <TravelVideo
          src={src}
          autoPlay
          controls
          muted={false}
          disableHover
          playsInline
          title={title}
          className="video-lightbox-media"
          style={{ width: '100%', height: 'auto', maxHeight: '85vh', objectFit: 'contain' }}
        />

        {title ? (
          <div className="video-lightbox-caption">
            <h3>{title}</h3>
          </div>
        ) : null}
      </div>
    </div>
  );
}
