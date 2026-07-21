import React, { useState } from 'react';
import { Edit2, Trash2, Play } from 'lucide-react';
import LazyImage from '../ui/LazyImage';
import EmojiReactions from './EmojiReactions';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(content, keyword) {
  const text = typeof content === 'string' ? content : '';
  const query = typeof keyword === 'string' ? keyword.trim() : '';

  if (!query) return text;

  const pattern = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const parts = text.split(pattern);
  const normalizedQuery = query.toLowerCase();
  let offset = 0;

  return parts.map((part) => {
    const key = `${part}-${offset}`;
    offset += part.length;

    if (part.toLowerCase() === normalizedQuery) {
      return (
        <mark key={key} className="daily-highlight">
          {part}
        </mark>
      );
    }

    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function LazyVideo({ url }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Expanded Lightbox-style Video View
  if (isExpanded) {
    return (
      <div
        className="lightbox"
        onClick={() => setIsExpanded(false)}
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
            setIsExpanded(false);
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
          <video
            src={url}
            autoPlay
            controls
            playsInline
            style={{ width: '100%', height: 'auto', maxHeight: '85vh', display: 'block', objectFit: 'contain' }}
          />
        </div>
      </div>
    );
  }

  // Loaded Inline View (Auto-playing without sound)
  if (isLoaded) {
    return (
      <div style={{ position: 'relative', width: '100%', borderRadius: '4px', overflow: 'hidden' }}>
        <video
          src={url}
          autoPlay
          muted
          loop
          playsInline
          style={{ width: '100%', height: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block', cursor: 'pointer' }}
          onClick={() => setIsExpanded(true)}
        />
        <div
          onClick={() => setIsExpanded(true)}
          style={{
            position: 'absolute',
            bottom: '12px',
            right: '12px',
            backgroundColor: 'rgba(0,0,0,0.6)',
            color: 'white',
            padding: '6px 12px',
            borderRadius: '20px',
            fontSize: '12px',
            backdropFilter: 'blur(4px)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.8)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
        >
          <Play size={12} fill="white" /> 点击放大并播放声音
        </div>
      </div>
    );
  }

  // Placeholder View
  return (
    <div
      onClick={() => setIsLoaded(true)}
      style={{
        width: '100%',
        aspectRatio: '16/9',
        backgroundColor: 'var(--color-surface, rgba(128, 128, 128, 0.05))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        borderRadius: '4px',
        position: 'relative',
        overflow: 'hidden'
      }}
      className="lazy-video-placeholder"
    >
      <div
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
          border: '1px solid rgba(255,255,255,0.1)',
          transition: 'all 0.4s cubic-bezier(0.19, 1, 0.22, 1)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.15)';
          e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
          e.currentTarget.style.boxShadow = '0 12px 40px rgba(0,0,0,0.25)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
          e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.15)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
        }}
      >
        <Play size={24} color="#fff" fill="#fff" style={{ marginLeft: '4px' }} />
      </div>
    </div>
  );
}

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
    return <LazyVideo key={idx} url={item.url} />;
  }
  return null;
}

export default function DailyEntry({ post, isAdmin, onEdit, onDelete, keyword = '', timeMachineActive = false }) {
  return (
    <article
      className={`entry ${timeMachineActive ? 'time-capsule-active' : ''}`}
      id={post.id}
      data-time-machine-active={timeMachineActive || undefined}
    >
      <div className="entry-header">
        <div className="entry-date">{post.date}</div>
        {isAdmin ? (
          <div className="entry-actions">
            <button className="entry-action-btn edit" onClick={() => onEdit(post)} title="Edit">
              <Edit2 size={14} />
            </button>
            <button className="entry-action-btn delete" onClick={() => onDelete(post)} title="Delete">
              <Trash2 size={14} />
            </button>
          </div>
        ) : null}
      </div>
      {post.title ? <h3 className="entry-title">{highlightText(post.title, keyword)}</h3> : null}
      {post.text && post.text.trim() ? <div className="entry-text">{highlightText(post.text, keyword)}</div> : null}
      {post.tags && post.tags.length > 0 ? (
        <div className="entry-tags">
          {post.tags.map((t) => (
            <span key={t} className="entry-tag">#{t}</span>
          ))}
        </div>
      ) : null}
      {post.media && post.media.length > 0 ? (
        <div className={`entry-media ${post.mediaGrid || 'media-single'}`}>
          {post.media.map(renderMediaItem)}
        </div>
      ) : null}
      <EmojiReactions diaryId={post.id} />
    </article>
  );
}
