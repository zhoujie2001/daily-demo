import React, { useState } from 'react';
import Modal from './Modal';
import Button from './Button';

/**
 * 支持一个或多个输入字段的 Prompt 弹窗。
 * fields: [{ name, label, defaultValue, placeholder, type: 'text' | 'textarea' }]
 * 确定时返回 { name: value } 对象；单字段模式返回单个字符串（更符合 window.prompt 语义）。
 */
export default function PromptDialog({
  open,
  title = '输入',
  fields = [],
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
}) {
  const [values, setValues] = useState({});
  const [prevOpen, setPrevOpen] = useState(false);

  // 在 render 中同步 open 的变化并重置字段（官方推荐的“在渲染阶段调整 state”模式）
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      const initial = {};
      fields.forEach((f) => {
        initial[f.name] = f.defaultValue ?? '';
      });
      setValues(initial);
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (fields.length === 1) {
      onConfirm(values[fields[0].name] ?? '');
    } else {
      onConfirm({ ...values });
    }
  };

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
          <Button variant="primary" onClick={handleSubmit}>
            {confirmText}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="ui-form">
        {fields.map((field) => (
          <div key={field.name} className="ui-form-item">
            {field.label && <label className="ui-form-label">{field.label}</label>}
            {field.type === 'textarea' ? (
              <textarea
                className="ui-input ui-textarea"
                value={values[field.name] ?? ''}
                placeholder={field.placeholder || ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                rows={3}
              />
            ) : (
              <input
                autoFocus={field.name === fields[0]?.name}
                className="ui-input"
                type="text"
                value={values[field.name] ?? ''}
                placeholder={field.placeholder || ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
              />
            )}
          </div>
        ))}
        {/* 让 Enter 键提交表单 */}
        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  );
}
