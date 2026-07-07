import React from 'react';

export default function Timeline({ posts, activeDate, onSelect }) {
  return (
    <aside className="col-timeline">
      <div className="timeline-header">DATE</div>
      <div className="timeline-track scrollable-timeline">
        {posts.length === 0 ? (
          <div className="timeline-empty">没有找到相关日记</div>
        ) : (
          posts.map((post) => (
            <a
              key={post.id}
              href={`#${post.id}`}
              onClick={(e) => {
                e.preventDefault();
                onSelect(post.id);
              }}
              className={`timeline-node ${activeDate === post.id ? 'active' : ''}`}
            >
              {post.date}
            </a>
          ))
        )}
      </div>
    </aside>
  );
}
