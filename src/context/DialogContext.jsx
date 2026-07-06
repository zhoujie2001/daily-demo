import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import PromptDialog from '../components/ui/PromptDialog';
import ToastContainer from '../components/ui/Toast';

const DialogContext = createContext(null);

/**
 * DialogProvider 挂在 App 最外层，提供:
 *   const { confirm, prompt, toast } = useDialog();
 *
 * 都返回 Promise，方便 async/await 风格调用。
 *   const ok = await confirm({ title, message, danger: true });
 *   const value = await prompt({ title, defaultValue, placeholder });
 *   toast.success('OK'); toast.error('Failed'); toast.info('...');
 */
export function DialogProvider({ children }) {
  const [confirmState, setConfirmState] = useState({ open: false });
  const [promptState, setPromptState] = useState({ open: false });
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const closeConfirm = useCallback(() => setConfirmState((s) => ({ ...s, open: false })), []);
  const closePrompt = useCallback(() => setPromptState((s) => ({ ...s, open: false })), []);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      setConfirmState({
        open: true,
        options,
        onConfirm: () => {
          closeConfirm();
          resolve(true);
        },
        onCancel: () => {
          closeConfirm();
          resolve(false);
        },
      });
    });
  }, [closeConfirm]);

  const prompt = useCallback((options) => {
    // 归一化：允许传单字段的简写
    let fields = options.fields;
    if (!fields) {
      fields = [
        {
          name: 'value',
          label: options.label,
          defaultValue: options.defaultValue,
          placeholder: options.placeholder,
          type: options.type,
        },
      ];
    }
    return new Promise((resolve) => {
      setPromptState({
        open: true,
        options: { ...options, fields },
        onConfirm: (value) => {
          closePrompt();
          resolve(value);
        },
        onCancel: () => {
          closePrompt();
          resolve(null);
        },
      });
    });
  }, [closePrompt]);

  const pushToast = useCallback((type, message, opts = {}) => {
    idRef.current += 1;
    const id = idRef.current;
    setToasts((prev) => [...prev, { id, type, message, ...opts }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useMemo(
    () => ({
      success: (msg, opts) => pushToast('success', msg, opts),
      error: (msg, opts) => pushToast('error', msg, opts),
      info: (msg, opts) => pushToast('info', msg, opts),
    }),
    [pushToast]
  );

  const value = useMemo(() => ({ confirm, prompt, toast }), [confirm, prompt, toast]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.options?.title}
        message={confirmState.options?.message}
        confirmText={confirmState.options?.confirmText}
        cancelText={confirmState.options?.cancelText}
        danger={confirmState.options?.danger}
        onConfirm={confirmState.onConfirm}
        onCancel={confirmState.onCancel}
      />
      <PromptDialog
        open={promptState.open}
        title={promptState.options?.title}
        fields={promptState.options?.fields || []}
        confirmText={promptState.options?.confirmText}
        cancelText={promptState.options?.cancelText}
        onConfirm={promptState.onConfirm}
        onCancel={promptState.onCancel}
      />
      <ToastContainer items={toasts} onDismiss={dismissToast} />
    </DialogContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used inside <DialogProvider>');
  }
  return ctx;
}
