import React, { useState } from 'react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { fallbackVideos } from '../../data/fallbackPhotos';
import { resolveMediaUrl } from '../../utils/media';
import { useDialog } from '../../context/DialogContext';
import { LoadingSpinner, LoadingBlock } from '../ui/Loading';
import TravelVideo from './TravelVideo';

export default function Travel({
  isAdmin,
  videos,
  loading,
  uploading,
  onUpload,
  onUpdate,
  onDelete,
}) {
  const { confirm, prompt, toast } = useDialog();
  const [expandedVideo, setExpandedVideo] = useState(null);

  const isRealData = videos.length > 0;
  const list = isRealData ? videos : fallbackVideos;
  const displayList = [
    ...list.map((v, i) => ({ ...v, _key: `a-${v.id ?? i}`, _dup: false })),
    ...list.map((v, i) => ({ ...v, _key: `b-${v.id ?? i}`, _dup: true })),
  ];

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await onUpload(file);
      toast.success('视频上传成功');
    } catch {
      toast.error('视频上传失败，请稍后重试');
    }
  };

  const handleEditTitle = async (video) => {
    const newTitle = await prompt({
      title: '编辑视频名称',
      label: '标题',
      defaultValue: video.title,
      placeholder: '视频名称',
      confirmText: '保存',
    });
    if (newTitle === null) return;
    try {
      await onUpdate(video.id, { title: newTitle || video.title });
      toast.success('已更新');
    } catch {
      toast.error('更新失败');
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: '删除视频',
      message: '删除后不可恢复，确定要删除这个视频吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await onDelete(id);
      toast.success('已删除');
    } catch {
      toast.error('删除失败');
    }
  };

  return (
    <section id="travel">
      <div style={headerRowStyle}>
        <h2 style={{ margin: 0 }}>Travel</h2>
        {isAdmin ? (
          <label className={`upload-btn ${uploading ? 'disabled' : ''}`}>
            {uploading ? <LoadingSpinner size={12} /> : <Plus size={14} />}
            <span>{uploading ? 'Uploading...' : 'Upload Video'}</span>
            <input
              type="file"
              accept="video/*"
              className="hidden-input"
              onChange={handleFile}
              disabled={uploading}
            />
          </label>
        ) : null}
      </div>
      <p style={{ marginTop: 0, color: '#666', fontSize: '14px' }}>嘿！快看那边。</p>

      {loading && !isRealData ? (
        <LoadingBlock label="Loading videos..." />
      ) : (
        <div className="slider-wrapper">
          <div className="video-track video-track-infinite">
            {displayList.map((video) => (
              <div key={video._key} className="video-card">
                <TravelVideo
                  src={resolveMediaUrl(video.url)}
                  muted
                  loop
                  playsInline
                  controls={false}
                  onClick={() => setExpandedVideo(video)}
                  title={video.title}
                  style={{ width: '200px', height: '280px', objectFit: 'cover', cursor: 'pointer' }}
                  className="travel-video"
                />
                {isAdmin && isRealData && !video._dup ? (
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
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {expandedVideo && (
        <div
          className="lightbox"
          onClick={() => setExpandedVideo(null)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <button
            className="lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedVideo(null);
            }}
            style={{ zIndex: 1000 }}
          >
            ×
          </button>
          <div
            className="lightbox-content"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '90%', maxWidth: '1200px', backgroundColor: '#000', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.4)' }}
          >
            <TravelVideo
              src={resolveMediaUrl(expandedVideo.url)}
              autoPlay
              controls
              muted={false}
              disableHover
              playsInline
              title={expandedVideo.title}
              style={{ width: '100%', height: 'auto', maxHeight: '85vh', display: 'block', objectFit: 'contain' }}
            />
            {expandedVideo.title && (
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px', background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)', color: 'white' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '500' }}>{expandedVideo.title}</h3>
              </div>
            )}
          </div>
        </div>
      )}
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
