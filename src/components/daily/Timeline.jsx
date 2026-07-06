import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';

export default function Timeline({ posts, activeDate, onSelect }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => {
      const inDate = (p.date || '').toLowerCase().includes(q);
      const inText = (p.text || '').toLowerCase().includes(q);
      return inDate || inText;
    });
  }, [posts, query]);

  return (
    <aside className="col-timeline">
      <div className="timeline-header">DATE</div>
      <div className="timeline-search">
        <Search size={13} className="timeline-search-icon" />
        <input
          type="text"
          className="timeline-search-input"
          placeholder="Search date or text..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="timeline-search-clear"
            onClick={() => setQuery('')}
            aria-label="clear"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="timeline-track scrollable-timeline">
        {filtered.length === 0 ? (
          <div className="timeline-empty">No matches</div>
        ) : (
          filtered.map((post) => (
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
