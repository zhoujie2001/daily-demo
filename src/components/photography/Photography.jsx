import React from 'react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { fallbackPhotos } from '../../data/fallbackPhotos';
import { resolveMediaUrl } from '../../utils/media';

export default function Photography({
  isAdmin,
  photos,
  uploading,
  onUpload,
  onUpdate,
  onDelete,
  onOpenLightbox,
}) {
  const isRealData = photos.length > 0;
  const list = isRealData ? photos : fallbackPhotos;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onUpload(file);
    e.target.value = '';
  };

  const handleCardClick = (item) => {
    onOpenLightbox({
      ...item,
      src: resolveMediaUrl(item.url),
    });
  };

  const handleEdit = (item) => {
    const newTitle = prompt('修改图片名称:', item.title);
    const newDesc = prompt('修改图片描述:', item.desc);
    if (newTitle == null && newDesc == null) return;
    onUpdate(item.id, {
      title: newTitle ?? item.title,
      desc: newDesc ?? item.desc,
    });
  };

  const handleDelete = (id) => {
    if (!window.confirm('确定删除这张照片吗？')) return;
    onDelete(id);
  };

  return (
    <section id="photography">
      <h2>Photography</h2>
      <section id="photography-inner">
        <div style={headerRowStyle}>
          <h2 style={{ margin: 0 }}>myCut</h2>
          {isAdmin && (
            <label className={`upload-btn ${uploading ? 'disabled' : ''}`}>
              <Plus size={14} />
              <span>{uploading ? 'Uploading...' : 'Upload Photo'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden-input"
                onChange={handleFile}
                disabled={uploading}
              />
            </label>
          )}
        </div>

        <div className="photo-grid">
          {list.map((item, index) => (
            <div
              className="photo-card"
              key={item.id ?? `static-${index}`}
              onClick={() => handleCardClick(item)}
              style={{ position: 'relative' }}
            >
              {isAdmin && isRealData && (
                <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(item);
                    }}
                    title="Edit Photo"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    className="action-btn delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(item.id);
                    }}
                    title="Delete Photo"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
              <div className="photo-img-wrapper">
                <img src={resolveMediaUrl(item.url)} alt={item.title} />
              </div>
              <div className="photo-info" style={{ position: 'relative' }}>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

const headerRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '20px',
};
