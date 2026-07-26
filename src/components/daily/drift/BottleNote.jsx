import React from 'react';
import { Waves } from 'lucide-react';
import DailyMedia from '../DailyMedia';

export default function BottleNote({ post, onReturn }) {
  return (
    <article className="drift-note" aria-label={`来自 ${post.date} 的 Daily`}>
      <div className="drift-note-scroll">
        <header className="drift-note-header">
          <span>一封被海浪送回来的 Daily</span>
          <time>{post.date}</time>
        </header>

        {post.title ? <h2>{post.title}</h2> : null}
        {post.text?.trim() ? <div className="drift-note-text">{post.text}</div> : null}

        {post.tags?.length ? (
          <div className="drift-note-tags">
            {post.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          </div>
        ) : null}

        <DailyMedia
          media={post.media}
          mediaGrid={post.mediaGrid}
          title={`来自 ${post.date} 的 Daily`}
          variant="note"
        />
      </div>

      <footer className="drift-note-footer">
        <button type="button" onClick={onReturn}>
          <Waves size={16} aria-hidden="true" />
          扔回海里
        </button>
      </footer>
    </article>
  );
}
