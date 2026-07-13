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
  loading = 'lazy',
  decoding = 'async',
  onLoad,
  onError,
  ...imgProps
}) {
  const wrapperRef = useRef(null);

  const [shouldLoadSrc, setShouldLoadSrc] = useState(() =>
    typeof IntersectionObserver === 'undefined' ? src : null
  );

  const [loadedSrc, setLoadedSrc] = useState(null);
  const [erroredSrc, setErroredSrc] = useState(null);

  const shouldLoad = typeof IntersectionObserver === 'undefined' ? true : shouldLoadSrc === src;
  const loaded = loadedSrc === src;
  const errored = erroredSrc === src;

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node || shouldLoad || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShouldLoadSrc(src);
            observer.disconnect();
          }
        });
      },
      { threshold, rootMargin }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, src, shouldLoad]);

  const handleLoad = (event) => {
    setLoadedSrc(src);
    onLoad?.(event);
  };

  const handleError = (event) => {
    setErroredSrc(src);
    onError?.(event);
  };

  return (
    <div
      ref={wrapperRef}
      className={`lazy-image ${className} ${loaded ? 'is-loaded' : ''} ${errored ? 'is-error' : ''}`.trim()}
    >
      {!loaded && !errored ? (
        <div className={`lazy-image-skeleton ${skeletonClassName}`.trim()} aria-hidden="true" />
      ) : null}

      {shouldLoad && !errored && src ? (
        <img
          {...imgProps}
          src={src}
          alt={alt}
          loading={loading}
          decoding={decoding}
          className={`lazy-image-img ${imgClassName} ${loaded ? 'is-visible' : ''}`.trim()}
          onLoad={handleLoad}
          onError={handleError}
        />
      ) : null}

      {errored ? (
        <div className="lazy-image-error" role="img" aria-label={errorText}>
          <ImageOff size={18} />
          <span>{errorText}</span>
        </div>
      ) : null}
    </div>
  );
}
