import React, { useEffect, useRef, useState } from 'react';
import MediaPlaceholder from './MediaPlaceholder';

export default function LazyImage({
  src,
  alt = '',
  className = '',
  imgClassName = '',
  skeletonClassName = '',
  kind = 'image',
  loadingText = '图片加载中',
  errorText = '图片暂时无法显示',
  emptyText = '暂无图片',
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
  const [retryKey, setRetryKey] = useState(0);

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

  const handleRetry = () => {
    setErroredSrc(null);
    setLoadedSrc(null);
    setShouldLoadSrc(src);
    setRetryKey((current) => current + 1);
  };

  return (
    <div
      ref={wrapperRef}
      className={`lazy-image ${className} ${loaded ? 'is-loaded' : ''} ${errored ? 'is-error' : ''}`.trim()}
    >
      {!src ? (
        <MediaPlaceholder
          kind={kind}
          state="empty"
          compact
          label={emptyText}
        />
      ) : null}

      {src && !loaded && !errored ? (
        <MediaPlaceholder
          kind={kind}
          state="loading"
          compact
          label={loadingText}
          className={`lazy-image-skeleton ${skeletonClassName}`.trim()}
        />
      ) : null}

      {shouldLoad && !errored && src ? (
        <img
          key={`${src}-${retryKey}`}
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
        <MediaPlaceholder
          kind={kind}
          state="error"
          compact
          label={errorText}
          className="lazy-image-error"
          onRetry={handleRetry}
        />
      ) : null}
    </div>
  );
}
