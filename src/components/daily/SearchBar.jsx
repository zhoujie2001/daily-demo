import React, { useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export default function SearchBar({ value, onChange, onClear }) {
  const composingValueRef = useRef(value);
  const [isComposing, setIsComposing] = useState(false);
  const [composingValue, setComposingValue] = useState(value);

  const displayValue = isComposing ? composingValue : value;

  return (
    <div className="daily-search-shell">
      <label className="daily-search" aria-label="搜索日记">
        <Search size={15} className="daily-search-icon" />
        <input
          type="text"
          className="daily-search-input"
          placeholder="搜索日记..."
          value={displayValue}
          onCompositionStart={() => {
            composingValueRef.current = value;
            setComposingValue(value);
            setIsComposing(true);
          }}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            composingValueRef.current = '';
            setComposingValue('');
            onChange(e.target.value);
          }}
          onChange={(e) => {
            const nextValue = e.target.value;
            if (isComposing) {
              composingValueRef.current = nextValue;
              setComposingValue(nextValue);
              return;
            }
            onChange(nextValue);
          }}
        />
      </label>
      {displayValue ? (
        <button
          type="button"
          className="daily-search-clear"
          onClick={() => {
            composingValueRef.current = '';
            setComposingValue('');
            setIsComposing(false);
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
