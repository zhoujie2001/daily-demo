import React, { useState } from 'react';
import { Edit2, Trash2, VolumeX } from 'lucide-react';
import LazyImage from '../ui/LazyImage';
import VideoLightbox from '../ui/VideoLightbox';
import TravelVideo from '../travel/TravelVideo';
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
  const [isExpanded, setIsExpanded] = useState(false);

  if (isExpanded) {
    return (
      <VideoLightbox
        src={url}
        onClose={() => setIsExpanded(false)}
      />
    );
  }

  return (
    <div className="daily-video-preview">
      <TravelVideo
        src={url}
        muted
        loop
        playsInline
        controls={false}
        playWhenVisible
        disableHover
        onClick={() => setIsExpanded(true)}
        title="Daily"
        className="daily-inline-video"
        style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', cursor: 'pointer' }}
      />
      <button
        type="button"
        className="daily-video-sound-hint"
        onClick={() => setIsExpanded(true)}
        aria-label="打开视频并播放声音"
        title="打开视频并播放声音"
      >
        <VolumeX size={16} />
      </button>
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
