import React from 'react';

export function SkeletonCard({ height = 120, className = '', style = {} }) {
  return <div className={`skeleton ${className}`.trim()} style={{ width: '100%', height, borderRadius: 16, ...style }} aria-hidden="true" />;
}

export function SkeletonText({ width = '100%', className = '', style = {} }) {
  return <div className={`skeleton ${className}`.trim()} style={{ width, height: 12, borderRadius: 999, ...style }} aria-hidden="true" />;
}

export function SkeletonAvatar({ size = 32, className = '', style = {} }) {
  return (
    <div
      className={`skeleton ${className}`.trim()}
      style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, ...style }}
      aria-hidden="true"
    />
  );
}
