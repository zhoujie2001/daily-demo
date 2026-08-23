import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, QrCode, Share2, X } from 'lucide-react';
import { useDialog } from '../../context/DialogContext';
import {
  copyText,
  createDailySharePayload,
  isCanceledShare,
} from '../../utils/dailyShare';
import DailyQrCode from './DailyQrCode';

const COPY_RESET_DELAY = 1800;

function supportsSystemShare() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

function prefersImmediateSystemShare() {
  if (!supportsSystemShare() || typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(max-width: 900px)').matches;
}

export default function DailyShare({ post }) {
  const { toast } = useDialog();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareRootRef = useRef(null);
  const triggerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const copyResetTimerRef = useRef(null);
  const popoverId = useId();
  const payload = useMemo(() => createDailySharePayload(post), [post]);
  const nativeShareAvailable = supportsSystemShare();

  const closePopover = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => () => {
    if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!shareRootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closePopover();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePopover, open]);

  const openFallback = (message = '') => {
    setOpen(true);
    if (message) toast.info(message);
  };

  const handleSystemShare = async () => {
    if (!nativeShareAvailable || sharing) {
      openFallback('当前浏览器不支持系统分享，可复制链接或扫描二维码');
      return;
    }

    setSharing(true);
    try {
      await navigator.share(payload);
      setOpen(false);
    } catch (error) {
      if (!isCanceledShare(error)) openFallback('系统分享未能打开，已为你保留其他分享方式');
    } finally {
      setSharing(false);
    }
  };

  const handleTrigger = () => {
    if (prefersImmediateSystemShare()) {
      handleSystemShare();
      return;
    }
    setOpen((current) => !current);
  };

  const handleCopy = async () => {
    try {
      await copyText(payload.url);
      setCopied(true);
      toast.success('分享链接已复制');
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_DELAY);
    } catch (error) {
      toast.error(error.message || '复制失败，请重试');
    }
  };

  return (
    <div className="daily-share" ref={shareRootRef} data-pet-avoid>
      <button
        ref={triggerRef}
        type="button"
        className="daily-share-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={handleTrigger}
        title="分享这篇 Daily"
      >
        <Share2 size={15} aria-hidden="true" />
        <span>分享</span>
      </button>

      {open ? (
        <section
          id={popoverId}
          className="daily-share-popover"
          role="dialog"
          aria-label="分享这篇 Daily"
        >
          <header className="daily-share-popover-header">
            <div>
              <strong>分享这一天</strong>
              <span>{post.date}</span>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="daily-share-close"
              onClick={closePopover}
              aria-label="关闭分享面板"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="daily-share-qr-wrap">
            <DailyQrCode value={payload.url} />
            <span><QrCode size={13} aria-hidden="true" />扫码打开这一天</span>
          </div>

          <div className="daily-share-actions">
            {nativeShareAvailable ? (
              <button type="button" onClick={handleSystemShare} disabled={sharing}>
                <Share2 size={15} aria-hidden="true" />
                {sharing ? '正在打开…' : '系统分享'}
              </button>
            ) : null}
            <button type="button" onClick={handleCopy}>
              {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
