import React, { useRef } from 'react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { useHorizontalAutoScroll } from '../../hooks/useHorizontalAutoScroll';
import { fallbackVideos } from '../../data/fallbackPhotos';
import { resolveMediaUrl } from '../../utils/media';

export default function Travel({ isAdmin, videos, uploading, onUpload, onUpdate, onDelete }) {
  const sliderRef = useRef(null);
  useHorizontalAutoScroll(sliderRef, 0.5);

  const list = videos.length > 0 ? videos : fallbackVideos;
  const isRealData = videos.length > 0;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onUpload(file);
    e.target.value = '';
  };

  const handleEditTitle = async (video) => {
    const newTitle = prompt('修改视频名称:', video.title);
    if (newTitle == null) return;
    onUpdate(video.id, { title: newTitle || video.title });
  };

  const handleDelete = (id) => {
    if (!window.confirm('确定删除这个视频吗？')) return;
    onDelete(id);
  };

  return (
    <section id="travel">
      <div style={headerRowStyle}>
        <h2 style={{ margin: 0 }}>Travel</h2>
        {isAdmin && (
          <label className={`upload-btn ${uploading ? 'disabled' : ''}`}>
            <Plus size={14} />
            <span>{uploading ? 'Uploading...' : 'Upload Video'}</span>
            <input
              type="file"
              accept="video/*"
              className="hidden-input"
              onChange={handleFile}
              disabled={uploading}
            />
          </label>
        )}
      </div>
      <p style={{ marginTop: 0, color: '#666', fontSize: '14px' }}>嘿！快看那边。</p>

      <div className="slider-wrapper" ref={sliderRef}>
        <div className="video-track">
          {list.map((video, index) => (
            <div key={video.id ?? `static-${index}`} className="video-card">
              <video
                src={resolveMediaUrl(video.url)}
                muted
                loop
                playsInline
                onMouseEnter={(e) => {
                  e.target.play().catch((err) => console.warn('Video playback prevented:', err));
                }}
                onMouseLeave={(e) => e.target.pause()}
                style={{ width: '200px', height: '280px', objectFit: 'cover' }}
              />
              {isAdmin && isRealData && (
                <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="action-btn"
                    onClick={() => handleEditTitle(video)}
                    title={video.title || 'Edit Video'}
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    className="action-btn delete"
                    onClick={() => handleDelete(video.id)}
                    title="Delete Video"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const headerRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: '60px',
  marginBottom: '10px',
};
