import React, { useEffect } from 'react';

export default function Lightbox({ photo, onClose }) {
  useEffect(() => {
    if (!photo) return undefined;
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [photo, onClose]);

  if (!photo) return null;
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose}>
          ×
        </button>
        <img src={photo.src} alt={photo.title} />
        <div className="lightbox-caption">
          <h3>{photo.title}</h3>
          <p>{photo.desc}</p>
        </div>
      </div>
    </div>
  );
}
