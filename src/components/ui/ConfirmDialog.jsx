import React from 'react';
import Modal from './Modal';
import Button from './Button';

export default function ConfirmDialog({
  open,
  title = '确认操作',
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      }
    >
      {typeof message === 'string' ? (
        <p style={{ margin: 0, color: '#444', fontSize: '14px', lineHeight: 1.6 }}>{message}</p>
      ) : (
        message
      )}
    </Modal>
  );
}
