import React from 'react';

export function LoadingSpinner({ size = 16, label }) {
  return (
    <span className="ui-loading" role="status" aria-live="polite">
      <span
        className="ui-spinner"
        style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)) }}
      />
      {label && <span className="ui-loading-label">{label}</span>}
    </span>
  );
}

export function LoadingBlock({ label = 'Loading...' }) {
  return (
    <div className="ui-loading-block">
      <LoadingSpinner size={24} />
      <div className="ui-loading-block-label">{label}</div>
    </div>
  );
}
