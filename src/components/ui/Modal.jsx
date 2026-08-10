import React, { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * 通用 Modal 组件。
 * - 点击遮罩层关闭（可关闭）
 * - Esc 关闭
 * - 支持 title / footer / 自定义内容
 */
export default function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'sm',
  showClose = true,
  closeOnBackdrop = true,
}) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const titleId = useId();
  const handleBackdrop = useCallback(() => {
    if (closeOnBackdrop && onClose) onClose();
  }, [closeOnBackdrop, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const panel = panelRef.current;
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    window.requestAnimationFrame(() => {
      const firstFocusable = panel?.querySelector(focusableSelector);
      (firstFocusable || panel)?.focus();
    });

    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
      if (e.key !== 'Tab' || !panel) return;

      const focusable = Array.from(panel.querySelectorAll(focusableSelector));
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const maxWidth = { sm: 360, md: 480, lg: 640 }[size] || 360;

  return (
    <div className="ui-modal-backdrop" onClick={handleBackdrop}>
      <div
        ref={panelRef}
        className="ui-modal-panel"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? '对话框' : undefined}
        tabIndex={-1}
      >
        {showClose && (
          <button type="button" className="ui-modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        )}
        {title && <div id={titleId} className="ui-modal-title">{title}</div>}
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
