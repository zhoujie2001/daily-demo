import React from 'react';
import { Edit2, Trash2 } from 'lucide-react';
import LazyImage from '../ui/LazyImage';

function renderMediaItem(item, idx) {
  if (item.type === 'color') {
    return <div key={idx} style={{ backgroundColor: item.value }} />;
  }
  if (item.type === 'video-placeholder') {
    return (
      <div
        key={idx}
        style={{
          backgroundColor: item.value,
          height: '400px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)',
        }}
      >
        [ Video Player - 悬停播放 ]
      </div>
    );
  }
  if (item.type === 'image') {
    return (
      <LazyImage
        key={idx}
        src={item.url}
        alt="daily"
        className="daily-lazy-wrapper"
        imgClassName="daily-lazy-img"
        skeletonClassName="daily-lazy-skeleton"
        errorText="图片加载失败"
      />
    );
  }
  if (item.type === 'video') {
    return (
      <video
        key={idx}
        src={item.url}
        muted
        loop
        playsInline
        onMouseEnter={(e) => {
          e.target.play().catch((err) => console.warn('Video playback prevented:', err));
        }}
        onMouseLeave={(e) => e.target.pause()}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  }
  return null;
}

export default function DailyEntry({ post, isAdmin, onEdit, onDelete }) {
  return (
    <article className="entry" id={post.id}>
      <div className="entry-header">
        <div className="entry-date">{post.date}</div>
        {isAdmin && (
          <div className="entry-actions">
            <button
              className="entry-action-btn edit"
              onClick={() => onEdit(post)}
              title="Edit"
            >
              <Edit2 size={14} />
            </button>
            <button
              className="entry-action-btn delete"
              onClick={() => onDelete(post)}
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {post.text && <div className="entry-text">{post.text}</div>}
      {post.tags && post.tags.length > 0 && (
        <div className="entry-tags">
          {post.tags.map((t) => (
            <span key={t} className="entry-tag">#{t}</span>
          ))}
        </div>
      )}
      {post.media && post.media.length > 0 && (
        <div className={`entry-media ${post.mediaGrid || 'media-single'}`}>
          {post.media.map(renderMediaItem)}
        </div>
      )}
    </article>
  );
}
