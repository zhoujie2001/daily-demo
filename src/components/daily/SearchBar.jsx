import React, { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

export default function SearchBar({ value, onChange, onClear }) {
  const [draft, setDraft] = useState(value);
  const [isComposing, setIsComposing] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="daily-search-shell">
      <label className="daily-search" aria-label="搜索日记">
        <Search size={15} className="daily-search-icon" />
        <input
          type="text"
          className="daily-search-input"
          placeholder="搜索日记..."
          value={draft}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            setDraft(e.target.value);
            onChange(e.target.value);
          }}
          onChange={(e) => {
            const nextValue = e.target.value;
            setDraft(nextValue);
            if (isComposing) return;
            onChange(nextValue);
          }}
        />
      </label>
      {draft ? (
        <button
          type="button"
          className="daily-search-clear"
          onClick={() => {
            setDraft('');
            onClear();
          }}
          aria-label="清空搜索"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
