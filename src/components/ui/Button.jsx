import React from 'react';

/**
 * 通用按钮：
 * - variant: primary / secondary / danger / ghost
 * - size: sm / md
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  type = 'button',
  onClick,
  className = '',
  ...rest
}) {
  const cls = [
    'ui-btn',
    `ui-btn-${variant}`,
    `ui-btn-${size}`,
    disabled || loading ? 'ui-btn-disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {loading ? '处理中...' : children}
    </button>
  );
}
