import React from 'react';
import { Edit2, Trash2 } from 'lucide-react';
import EmojiReactions from './EmojiReactions';
import DailyMedia from './DailyMedia';

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
      <DailyMedia
        media={post.media}
        mediaGrid={post.mediaGrid}
        title={post.title || post.date || 'Daily'}
      />
      <EmojiReactions diaryId={post.id} />
    </article>
  );
}
