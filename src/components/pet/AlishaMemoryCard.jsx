import React from 'react';
import { ArrowRight, X } from 'lucide-react';

export default function AlishaMemoryCard({ memory, onOpen, onDismiss, onForget }) {
  if (!memory) return null;
  return (
    <section className="alisha-memory-card" aria-label="阿丽莎带来的旧记忆">
      <button
        type="button"
        className="alisha-memory-card-close"
        aria-label="今天先不看"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <p className="alisha-memory-card-kicker">{memory.reason}</p>
      <strong>{memory.title}</strong>
      <time>{memory.date}</time>
      <p className="alisha-memory-card-excerpt">{memory.excerpt}</p>
      <button type="button" className="alisha-memory-card-open" onClick={onOpen}>
        跟我去看看
        <ArrowRight size={14} aria-hidden="true" />
      </button>
      <button type="button" className="alisha-memory-card-forget" onClick={onForget}>
        让阿丽莎忘记我
      </button>
    </section>
  );
}
