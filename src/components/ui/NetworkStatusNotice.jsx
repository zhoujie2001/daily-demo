import React from 'react';
import { RefreshCw, WifiOff, X } from 'lucide-react';

export default function NetworkStatusNotice({
  open,
  retrying,
  onClose,
  onRetry,
}) {
  if (!open) return null;

  return (
    <aside
      className="network-status-notice"
      role="status"
      aria-live="polite"
      aria-label="网络状态"
    >
      <WifiOff size={17} aria-hidden="true" />
      <p>部分内容暂时未同步，已显示当前可用内容。</p>
      <button
        type="button"
        className="network-status-retry"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw
          size={15}
          aria-hidden="true"
          className={retrying ? 'is-spinning' : ''}
        />
        <span>{retrying ? '重试中' : '重试'}</span>
      </button>
      <button
        type="button"
        className="network-status-close"
        onClick={onClose}
        aria-label="关闭网络状态提示"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
