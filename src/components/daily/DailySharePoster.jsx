import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Image as ImageIcon, LoaderCircle, Share2, X } from 'lucide-react';
import { useDialog } from '../../context/DialogContext';
import { isCanceledShare } from '../../utils/dailyShare';
import {
  canSharePosterFile,
  canvasToPngBlob,
  createDailyPosterCanvas,
  downloadPoster,
} from '../../utils/dailyPoster';

export default function DailySharePoster({ post, payload, onClose }) {
  const { toast } = useDialog();
  const [poster, setPoster] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll('button:not(:disabled)') || []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));

    const generate = async () => {
      try {
        const { canvas, model } = await createDailyPosterCanvas(post, { payload });
        const blob = await canvasToPngBlob(canvas);
        objectUrl = URL.createObjectURL(blob);
        const file = typeof File === 'function'
          ? new File([blob], model.fileName, { type: 'image/png' })
          : null;
        if (active) {
          setPoster({ file, model, objectUrl });
        } else {
          URL.revokeObjectURL(objectUrl);
          objectUrl = '';
        }
      } catch (generationError) {
        if (active) setError(generationError.message || '分享卡片生成失败，请重试');
      }
    };

    generate();
    return () => {
      active = false;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [onClose, payload, post]);

  const handleDownload = () => {
    try {
      downloadPoster(poster.objectUrl, poster.model.fileName);
      toast.success('分享卡片已保存');
    } catch (downloadError) {
      toast.error(downloadError.message || '保存图片失败，请重试');
    }
  };

  const canShareFile = canSharePosterFile(poster?.file);

  const handleShareFile = async () => {
    if (!canShareFile || sharing) return;
    setSharing(true);
    try {
      await navigator.share({
        files: [poster.file],
        title: payload.title,
        text: payload.text,
      });
    } catch (shareError) {
      if (!isCanceledShare(shareError)) toast.error('图片分享未能打开，请保存后分享');
    } finally {
      setSharing(false);
    }
  };

  return createPortal(
    <div
      className="daily-poster-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-pet-avoid
    >
      <section
        ref={dialogRef}
        className="daily-poster-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-poster-title"
      >
        <header className="daily-poster-header">
          <div>
            <span>SHARE A DAY</span>
            <h2 id="daily-poster-title">分享卡片</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭分享卡片">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="daily-poster-preview" aria-live="polite" aria-busy={!poster && !error}>
          {!poster && !error ? (
            <div className="daily-poster-loading">
              <LoaderCircle size={24} aria-hidden="true" />
              <span>正在装订这一天…</span>
            </div>
          ) : null}
          {error ? (
            <div className="daily-poster-error" role="alert">
              <ImageIcon size={24} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
          {poster ? (
            <img src={poster.objectUrl} alt={`${post.date} Daily 分享卡片预览`} />
          ) : null}
        </div>

        <footer className="daily-poster-footer">
          <p>1080 × 1440 PNG · 适合保存或发送给朋友</p>
          <div>
            {canShareFile ? (
              <button type="button" className="daily-poster-secondary" onClick={handleShareFile} disabled={sharing}>
                <Share2 size={16} aria-hidden="true" />
                {sharing ? '正在打开…' : '分享图片'}
              </button>
            ) : null}
            <button type="button" className="daily-poster-primary" onClick={handleDownload} disabled={!poster}>
              <Download size={16} aria-hidden="true" />
              保存图片
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
