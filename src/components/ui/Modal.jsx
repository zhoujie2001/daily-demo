import React, { useCallback, useEffect } from 'react';
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
  const handleBackdrop = useCallback(() => {
    if (closeOnBackdrop && onClose) onClose();
  }, [closeOnBackdrop, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const maxWidth = { sm: 360, md: 480, lg: 640 }[size] || 360;

  return (
    <div className="ui-modal-backdrop" onClick={handleBackdrop}>
      <div
        className="ui-modal-panel"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        {showClose && (
          <button className="ui-modal-close" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        )}
        {title && <div className="ui-modal-title">{title}</div>}
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
