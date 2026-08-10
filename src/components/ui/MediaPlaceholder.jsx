import React from 'react';
import {
  BookOpen,
  Film,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';

const ICONS = {
  book: BookOpen,
  image: ImageIcon,
  video: Film,
};

const DEFAULT_LABELS = {
  loading: '正在加载',
  error: '暂时无法显示',
  empty: '暂无内容',
};

export default function MediaPlaceholder({
  kind = 'image',
  state = 'loading',
  label,
  title,
  compact = false,
  className = '',
  onRetry,
}) {
  const Icon = ICONS[kind] ?? ImageIcon;
  const resolvedLabel = label || DEFAULT_LABELS[state] || DEFAULT_LABELS.empty;
  const isLoading = state === 'loading';

  return (
    <div
      className={[
        'media-state',
        `media-state-${kind}`,
        `is-${state}`,
        compact ? 'is-compact' : '',
        className,
      ].filter(Boolean).join(' ')}
      role={isLoading ? undefined : 'status'}
      aria-hidden={isLoading ? 'true' : undefined}
    >
      <span className="media-state-icon" aria-hidden="true">
        <Icon size={compact ? 17 : 21} />
      </span>
      <span className="media-state-copy">
        <span className="media-state-label">{resolvedLabel}</span>
        {title ? <small>{title}</small> : null}
      </span>
      {state === 'error' && onRetry ? (
        <button
          type="button"
          className="media-state-retry"
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>重试</span>
        </button>
      ) : null}
    </div>
  );
}
