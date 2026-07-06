import React from 'react';
import { Film, Image as ImageIcon, Link as LinkIcon, Send, X } from 'lucide-react';
import { LoadingSpinner } from '../ui/Loading';

export default function DailyEditor({
  editingId,
  text,
  attachments,
  publishing = false,
  onTextChange,
  onFilesSelected,
  onRemoveAttachment,
  onPublish,
  onCancelEdit,
}) {
  const canPublish = (text.trim().length > 0 || attachments.length > 0) && !publishing;
  return (
    <aside className="col-editor">
      <div className="editor-panel">
        <div className="editor-header">
          <span className="editor-title">{editingId ? 'Edit Update' : 'Write Update'}</span>
          <div className="status-indicator">
            <span className="status-dot" title="System Online" />
            <span className="status-text">Online</span>
          </div>
        </div>

        <div className="editor-body">
          <textarea
            className="editor-textarea"
            placeholder="记录今天的碎片..."
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            disabled={publishing}
          />
          {attachments.length > 0 && (
            <div className="editor-attachments">
              {attachments.map((att) => (
                <div key={att.id} className="attachment-preview">
                  {att.type === 'image' ? (
                    <img src={att.url} alt={att.name || 'attachment'} />
                  ) : (
                    <div className="video-thumbnail">
                      <Film size={20} />
                    </div>
                  )}
                  <button
                    className="remove-att-btn"
                    onClick={() => onRemoveAttachment(att.id)}
                    aria-label="remove attachment"
                    disabled={publishing}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="editor-footer">
          <div className="editor-tools">
            <label className="tool-btn" title="Add Photo/Video">
              <ImageIcon size={18} />
              <input
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden-input"
                onChange={onFilesSelected}
                disabled={publishing}
              />
            </label>
            <button className="tool-btn" title="Add Link" disabled={publishing}>
              <LinkIcon size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button className="publish-btn" disabled={!canPublish} onClick={onPublish}>
              {publishing ? (
                <>
                  <LoadingSpinner size={12} />
                  <span>Publishing...</span>
                </>
              ) : (
                <>
                  <span>{editingId ? 'Update' : 'Publish'}</span>
                  <Send size={14} />
                </>
              )}
            </button>
            {editingId && (
              <button
                className="publish-btn"
                style={{ background: '#fef2f2', color: '#ef4444', marginLeft: '8px' }}
                onClick={onCancelEdit}
                disabled={publishing}
              >
                <span>Cancel</span>
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
