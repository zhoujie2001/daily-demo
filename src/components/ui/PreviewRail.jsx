import React, { useEffect, useRef } from 'react';

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function PreviewRail({
  items,
  activeId,
  onSelect,
  renderPreview,
  getLabel = (item) => item?.label || '',
  ariaLabel = '内容预览',
  className = '',
}) {
  const railRef = useRef(null);
  const buttonRefs = useRef(new Map());
  const source = Array.isArray(items) ? items : [];

  useEffect(() => {
    const rail = railRef.current;
    const activeButton = buttonRefs.current.get(String(activeId));
    if (!rail || !activeButton || typeof rail.scrollTo !== 'function') return;

    const targetLeft = activeButton.offsetLeft
      - (rail.clientWidth - activeButton.offsetWidth) / 2;
    rail.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [activeId, source.length]);

  const moveSelection = (event, index, direction) => {
    const nextIndex = Math.min(Math.max(index + direction, 0), source.length - 1);
    if (nextIndex === index) return;
    event.preventDefault();
    const next = source[nextIndex];
    onSelect(next, nextIndex, { keyboard: true });
    buttonRefs.current.get(String(next.id))?.focus();
  };

  if (!source.length) return null;

  return (
    <div
      ref={railRef}
      className={`preview-rail ${className}`.trim()}
      role="listbox"
      aria-label={ariaLabel}
      data-pet-avoid
    >
      {source.map((item, index) => {
        const selected = String(item.id) === String(activeId);
        return (
          <button
            key={item.id}
            ref={(node) => {
              const key = String(item.id);
              if (node) buttonRefs.current.set(key, node);
              else buttonRefs.current.delete(key);
            }}
            type="button"
            className={`preview-rail-item ${selected ? 'is-active' : ''}`.trim()}
            role="option"
            aria-selected={selected}
            aria-label={getLabel(item, index)}
            title={getLabel(item, index)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(item, index, { keyboard: false })}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') moveSelection(event, index, -1);
              if (event.key === 'ArrowRight') moveSelection(event, index, 1);
              if (event.key === 'Home') moveSelection(event, index, -index);
              if (event.key === 'End') moveSelection(event, index, source.length - index - 1);
            }}
          >
            {renderPreview(item, index, selected)}
          </button>
        );
      })}
    </div>
  );
}
