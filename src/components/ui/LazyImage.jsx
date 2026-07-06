import React, { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';

export default function LazyImage({
  src,
  alt = '',
  className = '',
  imgClassName = '',
  skeletonClassName = '',
  errorText = '图片加载失败',
  threshold = 0.15,
  rootMargin = '160px',
  ...imgProps
}) {
  const wrapperRef = useRef(null);
  const [shouldLoad, setShouldLoad] = useState(() => typeof IntersectionObserver === 'undefined');
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [lastSrc, setLastSrc] = useState(src);

  if (src !== lastSrc) {
    setLastSrc(src);
    setLoaded(false);
    setErrored(false);
    setShouldLoad(typeof IntersectionObserver === 'undefined');
  }

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node || shouldLoad || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShouldLoad(true);
            observer.disconnect();
          }
        });
      },
      { threshold, rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, src, shouldLoad]);

  return (
    <div
      ref={wrapperRef}
      className={`lazy-image ${className} ${loaded ? 'is-loaded' : ''} ${errored ? 'is-error' : ''}`.trim()}
    >
      {!loaded && !errored && (
        <div className={`lazy-image-skeleton ${skeletonClassName}`.trim()} aria-hidden="true" />
      )}

      {shouldLoad && !errored && src ? (
        <img
          {...imgProps}
          src={src}
          alt={alt}
          className={`lazy-image-img ${imgClassName} ${loaded ? 'is-visible' : ''}`.trim()}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      ) : null}

      {errored && (
        <div className="lazy-image-error" role="img" aria-label={errorText}>
          <ImageOff size={18} />
          <span>{errorText}</span>
        </div>
      )}
    </div>
  );
}
