import React, { useState } from 'react';
import {
  CalendarDays,
  Camera,
  CircleDot,
  Film,
  Image as ImageIcon,
  Link as LinkIcon,
  MapPin,
  Mic2,
  Send,
  Tag as TagIcon,
  X,
} from 'lucide-react';
import { LoadingSpinner } from '../ui/Loading';
import { getPhotoMetadataAvailability } from '../../utils/photoMetadata';
import { formatSoundDuration } from '../../utils/soundPostcard';
import SoundPostcardComposer from './SoundPostcardComposer';

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
  onLivePhotoFilesSelected,
  onLiveMotionSelected,
  onSoundFileSelected,
  onAttachmentMetadataChange,
  onRemoveAttachment,
  onRetryCompression,
  onPublish,
  onCancelEdit,
}) {
  const canPublish = (text.trim().length > 0 || attachments.length > 0) && !publishing && !hasAttachmentErrors;
  const [tagInput, setTagInput] = useState('');
  const [liveImporterOpen, setLiveImporterOpen] = useState(false);
  const [soundImporterOpen, setSoundImporterOpen] = useState(false);
  const hasSoundPostcard = attachments.some((att) => att.type === 'audio');
  const pendingLivePhotoIndex = attachments.findIndex(
    (att) => att.type === 'live-photo' && !att.motionFile && !att.motionUrl
  );

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

  const renderMetadataOptions = (att, index) => {
    const availability = getPhotoMetadataAvailability(att.metadata);
    const options = [
      { key: 'showCapturedAt', available: availability.capturedAt, icon: CalendarDays, label: '拍摄日期' },
      { key: 'showLocation', available: availability.location, icon: MapPin, label: '拍摄位置' },
      { key: 'showCamera', available: availability.camera, icon: Camera, label: '相机信息' },
    ];

    return (
      <div className="editor-photo-metadata-options" aria-label="照片拍摄信息选项">
        <div className="editor-photo-metadata-title">照片信息</div>
        <div className="editor-photo-metadata-toggles">
          {options.map(({ key, available, icon: Icon, label }) => (
            <label
              key={key}
              className={`editor-photo-metadata-toggle ${available ? '' : 'is-disabled'}`}
              title={available ? `在 Daily 中显示${label}` : `照片未包含${label}`}
            >
              <input
                type="checkbox"
                checked={Boolean(att.metadata?.[key])}
                disabled={!available}
                onChange={(event) => onAttachmentMetadataChange?.(index, key, event.target.checked)}
              />
              {React.createElement(Icon, { size: 12 })}
              <span>{label}</span>
            </label>
          ))}
        </div>
        {!availability.capturedAt && !availability.location && !availability.camera ? (
          <span className="editor-photo-metadata-empty">此照片没有可读取的 EXIF 信息</span>
        ) : null}
      </div>
    );
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
            <span>{editingId ? '正在编辑已有 Daily' : '支持文字、图片、视频、实况与声音'}</span>
            <span>{text.trim().length} 字</span>
          </div>
        </div>

        {attachments.length > 0 && (
          <div className="editor-attachments">
            {attachments.map((att, i) => (
              <div
                key={att.id || att.url || i}
                className={`editor-attachment ${att.type === 'image' || att.type === 'live-photo' ? 'has-photo-details' : ''} ${att.type === 'audio' ? 'has-sound-details' : ''}`.trim()}
              >
                {att.type === 'audio' ? (
                  <div className="editor-attachment-sound-preview">
                    <span><Mic2 size={15} /> 声音明信片</span>
                    <small>{formatSoundDuration(att.duration)} · {att.name || '现场录音'}</small>
                    <audio src={att.url} controls preload="metadata" />
                  </div>
                ) : att.type === 'image' || att.type === 'live-photo' ? (
                  <div className="editor-attachment-photo-preview">
                    <img src={att.url} alt="" />
                    {att.type === 'live-photo' ? (
                      <span className="editor-live-photo-badge"><CircleDot size={11} /> LIVE</span>
                    ) : null}
                  </div>
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
                {att.type === 'live-photo' ? (
                  <div className="editor-live-photo-motion-row">
                    {att.motionUrl || att.motionFile ? (
                      <span className={att.compressionStatus === 'error' ? 'is-error' : ''}>
                        <Film size={12} />
                        {att.compressing
                          ? `动态片段压缩中 ${att.compressionProgress || 0}%`
                          : att.compressionStatus === 'error'
                            ? '动态片段处理失败'
                            : '动态片段已配对'}
                      </span>
                    ) : (
                      <label className="editor-live-photo-motion-picker">
                        <input
                          type="file"
                          accept="video/*,.mov"
                          hidden
                          onChange={(event) => onLiveMotionSelected?.(event, i)}
                        />
                        <Film size={12} /> 选择动态片段
                      </label>
                    )}
                  </div>
                ) : null}
                {att.type === 'image' || att.type === 'live-photo' ? renderMetadataOptions(att, i) : null}
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
                  aria-label="移除附件"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {liveImporterOpen ? (
          <section className="editor-live-photo-importer" aria-label="导入实况照片">
            <div className="editor-live-photo-importer-header">
              <div>
                <strong><CircleDot size={14} /> 添加实况照片</strong>
                <span>封面照片与动态视频会作为同一条 Daily 内容发布</span>
              </div>
              <button
                type="button"
                onClick={() => setLiveImporterOpen(false)}
                aria-label="关闭实况照片导入"
              >
                <X size={15} />
              </button>
            </div>

            <label className="editor-live-photo-auto-import">
              <input
                type="file"
                accept="image/*,video/*,.heic,.heif,.mov"
                multiple
                hidden
                onChange={onLivePhotoFilesSelected}
              />
              <span className="editor-live-photo-auto-icon"><CircleDot size={18} /></span>
              <span>
                <strong>同时选择照片和动态视频</strong>
                <small>支持一次选择多组；IMG_1234.HEIC/JPG 与 IMG_1234.MOV 会自动配对</small>
              </span>
            </label>

            <div className="editor-live-photo-divider"><span>手机无法同时选择时</span></div>

            <div className="editor-live-photo-steps">
              <label>
                <input
                  type="file"
                  accept="image/*,.heic,.heif"
                  hidden
                  onChange={(event) => onFilesSelected(event, 'live-photo')}
                />
                <span>1</span>
                <strong>选择封面照片</strong>
              </label>
              <label className={pendingLivePhotoIndex < 0 ? 'is-disabled' : ''}>
                <input
                  type="file"
                  accept="video/*,.mov"
                  hidden
                  disabled={pendingLivePhotoIndex < 0}
                  onChange={(event) => onLiveMotionSelected?.(event, pendingLivePhotoIndex)}
                />
                <span>2</span>
                <strong>{pendingLivePhotoIndex < 0 ? '等待选择封面' : '选择动态片段'}</strong>
              </label>
            </div>
            <p className={pendingLivePhotoIndex >= 0 ? 'is-warning' : ''}>
              {pendingLivePhotoIndex >= 0
                ? '这张实况照片还缺少动态片段，补选前无法发布。'
                : '拍摄日期和相机信息默认展示；精确位置出于隐私考虑默认关闭。'}
            </p>
          </section>
        ) : null}

        {soundImporterOpen ? (
          <SoundPostcardComposer
            disabled={hasSoundPostcard}
            onFileSelected={async (...args) => {
              const accepted = await onSoundFileSelected?.(...args);
              if (accepted) setSoundImporterOpen(false);
              return accepted;
            }}
          />
        ) : null}

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
            <label className="editor-tool editor-tool-labeled" title="上传图片">
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => onFilesSelected(e, 'image')}
              />
              <ImageIcon size={14} />
              <span>图片</span>
            </label>
            <label className="editor-tool editor-tool-labeled" title="上传视频">
              <input
                type="file"
                accept="video/*"
                multiple
                hidden
                onChange={(e) => onFilesSelected(e, 'video')}
              />
              <Film size={14} />
              <span>视频</span>
            </label>
            <button
              type="button"
              className={`editor-tool editor-tool-labeled editor-tool-live ${liveImporterOpen ? 'is-active' : ''}`.trim()}
              title="添加实况照片"
              aria-expanded={liveImporterOpen}
              onClick={() => {
                setSoundImporterOpen(false);
                setLiveImporterOpen((open) => !open);
              }}
            >
              <CircleDot size={14} />
              <span>实况</span>
            </button>
            <button
              type="button"
              className={`editor-tool editor-tool-labeled editor-tool-sound ${soundImporterOpen ? 'is-active' : ''}`.trim()}
              title={hasSoundPostcard ? '请先移除已有声音明信片' : '添加声音明信片'}
              aria-expanded={soundImporterOpen}
              disabled={hasSoundPostcard && !soundImporterOpen}
              onClick={() => {
                setLiveImporterOpen(false);
                setSoundImporterOpen((open) => !open);
              }}
            >
              <Mic2 size={14} />
              <span>声音</span>
            </button>
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
