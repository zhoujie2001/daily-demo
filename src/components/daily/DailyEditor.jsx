import React, { useState } from 'react';
import { Film, Image as ImageIcon, Link as LinkIcon, Send, Tag as TagIcon, X } from 'lucide-react';
import { LoadingSpinner } from '../ui/Loading';

const PRESET_TAGS = ['生活', '工作', '旅行', '读书', '随想', '摄影'];

export default function DailyEditor({
  editingId,
  text,
  attachments,
  tags = [],
  publishing = false,
  hasAttachmentErrors = false,
  onTextChange,
  onTagsChange,
  onFilesSelected,
  onRemoveAttachment,
  onRetryCompression,
  onPublish,
  onCancelEdit,
}) {
  const canPublish = (text.trim().length > 0 || attachments.length > 0) && !publishing && !hasAttachmentErrors;
  const [tagInput, setTagInput] = useState('');

  const toggleTag = (t) => {
    if (!onTagsChange) return;
    if (tags.includes(t)) onTagsChange(tags.filter((x) => x !== t));
    else onTagsChange([...tags, t]);
  };
  const addCustom = () => {
    const v = tagInput.trim();
    if (v && !tags.includes(v) && onTagsChange) onTagsChange([...tags, v]);
    setTagInput('');
  };

  return (
    <aside className="col-editor">
      <div className="editor-panel">
        <div className="editor-header">
          <div>
            <div className="editor-kicker">DAILY STUDIO</div>
            <span className="editor-title">{editingId ? 'Edit Update' : 'Write Update'}</span>
            <div className="editor-subtitle">记录今天，留一点给未来的自己。</div>
          </div>
          <div className="status-indicator">
            <span className="status-dot" title="System Online" />
          </div>
        </div>

        <div className="editor-body">
        <div className="editor-writing-surface">
          <textarea
            className="editor-textarea"
            rows={4}
            value={text}
            placeholder="今天有什么想说的？"
            onChange={(e) => onTextChange(e.target.value)}
          />
          <div className="editor-meta-row">
            <span>{editingId ? '正在编辑已有 Daily' : '支持文字、图片、视频与标签'}</span>
            <span>{text.trim().length} 字</span>
          </div>
        </div>

        {attachments.length > 0 && (
          <div className="editor-attachments">
            {attachments.map((att, i) => (
              <div key={att.url || i} className="editor-attachment">
                {att.type === 'image' ? (
                  <img src={att.url} alt="" />
                ) : (
                  <div className="editor-attachment-video">
                    {att.compressionStatus === 'queued' ? (
                      <span>🎬 等待压缩…</span>
                    ) : att.compressing ? (
                      <span>🎬 压缩中 {att.compressionProgress || 0}%…</span>
                    ) : att.compressionStatus === 'error' ? (
                      <span title={att.compressionError}>⚠️ 压缩失败</span>
                    ) : (
                      <>
                        <Film size={14} /> video
                        {att.originalSize && att.compressedSize && att.compressedSize < att.originalSize
                          ? ` ${(att.originalSize / 1024 / 1024).toFixed(1)} → ${(att.compressedSize / 1024 / 1024).toFixed(1)} MB`
                          : ''}
                      </>
                    )}
                  </div>
                )}
                {att.compressionStatus === 'error' ? (
                  <button
                    type="button"
                    className="editor-cancel editor-attachment-retry"
                    onClick={() => onRetryCompression?.(att.id)}
                  >
                    重试
                  </button>
                ) : null}
                <button
                  className="editor-attachment-remove"
                  onClick={() => onRemoveAttachment(i)}
                  aria-label="remove"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="editor-tags">
          <div className="editor-tags-label-row">
            <div className="editor-tags-label">
              <TagIcon size={11} /> 标签
            </div>
            <span className="editor-tags-hint">点击快速分类，也可以自定义</span>
          </div>
          <div className="editor-tag-surface">
          <div className="editor-tag-chips">
            {PRESET_TAGS.map((t) => (
              <button
                key={t}
                type="button"
                className={`tag-chip ${tags.includes(t) ? 'active' : ''}`}
                onClick={() => toggleTag(t)}
              >
                {t}
              </button>
            ))}
            {tags
              .filter((t) => !PRESET_TAGS.includes(t))
              .map((t) => (
                <button
                  key={t}
                  type="button"
                  className="tag-chip active custom"
                  onClick={() => toggleTag(t)}
                  title="点击移除"
                >
                  {t} <X size={9} />
                </button>
              ))}
            <input
              type="text"
              className="tag-chip-input"
              placeholder="+ 自定义"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addCustom();
                }
              }}
              onBlur={addCustom}
            />
          </div>
          </div>
        </div>

        </div>

        <div className="editor-footer">
          <div className="editor-toolbar">
            <label className="editor-tool" title="上传图片">
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => onFilesSelected(e, 'image')}
              />
              <ImageIcon size={14} />
            </label>
            <label className="editor-tool" title="上传视频">
              <input
                type="file"
                accept="video/*"
                multiple
                hidden
                onChange={(e) => onFilesSelected(e, 'video')}
              />
              <Film size={14} />
            </label>
            <button className="editor-tool" title="占位（暂未接入）" disabled>
              <LinkIcon size={14} />
            </button>
          </div>

          <div className="editor-actions">
            {editingId ? (
              <button className="editor-cancel" onClick={onCancelEdit} disabled={publishing}>
                取消
              </button>
            ) : null}
            <button
              className={`editor-publish ${canPublish ? '' : 'disabled'}`}
              onClick={onPublish}
              disabled={!canPublish}
            >
              {publishing ? <LoadingSpinner size={12} /> : <Send size={12} />}{' '}
              {editingId ? '更新' : '发布'}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
