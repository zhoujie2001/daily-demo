import React from 'react';
import Modal from './Modal';
import Button from './Button';

export default function NetworkAlertDialog({ open, onClose, onRetry, retrying }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="网络连接提示"
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={retrying}>
            我知道了
          </Button>
          <Button variant="primary" onClick={onRetry} disabled={retrying}>
            {retrying ? '检测中…' : '重试'}
          </Button>
        </div>
      }
    >
      <p style={{ margin: 0, color: '#444', fontSize: '14px', lineHeight: 1.6 }}>
        检测到后端服务暂时无法访问，可能是当前网络环境屏蔽了 vercel.app 域名。建议切换网络（如手机热点）后重试。
      </p>
    </Modal>
  );
}
