import React, { useEffect } from 'react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

const ICONS = {
  success: <CheckCircle2 size={16} />,
  error: <XCircle size={16} />,
  info: <Info size={16} />,
};

export default function ToastContainer({ items, onDismiss }) {
  return (
    <div className="ui-toast-container">
      {items.map((t) => (
        <ToastItem key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ item, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), item.duration ?? 2400);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, onDismiss]);
  return (
    <div className={`ui-toast ui-toast-${item.type || 'info'}`}>
      <span className="ui-toast-icon">{ICONS[item.type] || ICONS.info}</span>
      <span className="ui-toast-msg">{item.message}</span>
    </div>
  );
}
