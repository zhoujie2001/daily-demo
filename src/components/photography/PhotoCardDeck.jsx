import React, { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import LazyImage from '../ui/LazyImage';
import { resolveMediaUrl } from '../../utils/media';

const STACK_STYLES = [
  { rotate: 0, translateX: 0, scale: 1, opacity: 1 },
  { rotate: -3, translateX: -12, scale: 0.98, opacity: 0.92 },
  { rotate: 4, translateX: 14, scale: 0.96, opacity: 0.84 },
  { rotate: -6, translateX: -20, scale: 0.94, opacity: 0.76 },
  { rotate: 7, translateX: 22, scale: 0.92, opacity: 0.68 },
];

export default function PhotoCardDeck({ items }) {
  const [topIndex, setTopIndex] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [swipeDirection, setSwipeDirection] = useState('');
  const touchStartXRef = useRef(null);
  const animatingRef = useRef(false);
  const total = items.length;

  const visibleItems = useMemo(() => {
    if (!total) return [];
    return STACK_STYLES.map((_, offset) => ({
      item: items[(topIndex + offset) % total],
      offset,
    }));
  }, [items, topIndex, total]);

  const changeCard = (direction) => {
    if (animatingRef.current || total <= 1) return;
    animatingRef.current = true;
    setSwipeDirection(direction);
    window.setTimeout(() => {
      setTopIndex((prev) => {
        if (direction === 'left') return (prev + 1) % total;
        return (prev - 1 + total) % total;
      });
      setSwipeDirection('');
      animatingRef.current = false;
    }, 260);
  };

  const handleTouchStart = (e) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (e) => {
    const startX = touchStartXRef.current;
    const endX = e.changedTouches[0]?.clientX ?? null;
    touchStartXRef.current = null;
    if (startX === null || endX === null) return;
    const delta = endX - startX;
    if (Math.abs(delta) < 40) return;
    changeCard(delta < 0 ? 'left' : 'right');
  };

  if (!total) return null;

  return (
    <div className="photo-deck-container">
      <div
        className="photo-deck-wrapper"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {visibleItems
          .slice()
          .reverse()
          .map(({ item, offset }) => {
            const style = STACK_STYLES[offset];
            const isTop = offset === 0;
            const swipeClass = isTop && swipeDirection ? `swiping-${swipeDirection}` : '';
            return (
              <button
                key={`${item.id ?? item.url}-${offset}-${topIndex}`}
                type="button"
                className={`deck-card ${isTop ? 'top-card' : ''} ${swipeClass}`.trim()}
                style={{
                  zIndex: STACK_STYLES.length - offset,
                  opacity: style.opacity,
                  transform: `translateX(calc(-50% + ${style.translateX}px)) rotate(${style.rotate}deg) scale(${style.scale})`,
                }}
                onClick={() => {
                  if (isTop) setExpanded(item);
                }}
              >
                <div className="deck-card-media">
                  <LazyImage
                    src={resolveMediaUrl(item.url)}
                    alt={item.title}
                    className="deck-lazy-wrapper"
                    imgClassName="deck-lazy-img"
                    skeletonClassName="deck-lazy-skeleton"
                    errorText="照片加载失败"
                  />
                </div>
                <div className="deck-card-info">
                  <h3>{item.title}</h3>
                  <p>{item.desc}</p>
                </div>
              </button>
            );
          })}
      </div>

      <div className="deck-controls">
        <button type="button" className="deck-nav-btn" onClick={() => changeCard('right')} aria-label="上一张">
          <ChevronLeft size={16} />
        </button>
        <div className="deck-progress">{topIndex + 1} / {total}</div>
        <button type="button" className="deck-nav-btn" onClick={() => changeCard('left')} aria-label="下一张">
          <ChevronRight size={16} />
        </button>
      </div>

      {expanded ? (
        <div className="deck-expanded-overlay" onClick={() => setExpanded(null)}>
          <div className="deck-expanded-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="deck-expanded-close" onClick={() => setExpanded(null)} aria-label="关闭">
              <X size={18} />
            </button>
            <LazyImage
              src={resolveMediaUrl(expanded.url)}
              alt={expanded.title}
              className="deck-expanded-lazy-wrapper"
              imgClassName="deck-expanded-lazy-img"
              skeletonClassName="deck-expanded-lazy-skeleton"
              errorText="照片加载失败"
            />
            <div className="deck-expanded-info">
              <h3>{expanded.title}</h3>
              <p>{expanded.desc}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
