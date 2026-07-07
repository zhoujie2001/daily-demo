import React, { useMemo, useRef, useState } from 'react';
import SongCard from './SongCard';

const SWIPE_THRESHOLD = 70;
const SWIPE_OUT_DISTANCE = 220;
const TRANSITION_MS = 300;

export default function Song() {
  const playlists = useMemo(
    () => [
      {
        id: 'p1',
        title: '光和枯树',
        tracks: [
          { title: '你是我最喜欢的', artist: '落日飞车', cover: 'linear-gradient(135deg, #ffb86b, #ff6b6b)' },
          { title: "when the party's over", artist: 'Billie Eilish', cover: 'linear-gradient(135deg, #b8c0ff, #7c83fd)' },
          { title: '关于郑州的记忆', artist: '李志', cover: 'linear-gradient(135deg, #7bdff2, #b2f7ef)' },
          { title: 'Such Great Heights', artist: 'The Postal Service', cover: 'linear-gradient(135deg, #a7f3d0, #34d399)' },
          { title: '走马', artist: '陈粒', cover: 'linear-gradient(135deg, #fbcfe8, #fb7185)' },
        ],
      },
      {
        id: 'p2',
        title: '雨和屋檐',
        tracks: [
          { title: '安和桥', artist: '宋冬野', cover: 'linear-gradient(135deg, #60a5fa, #38bdf8)' },
          { title: 'Pink Moon', artist: 'Nick Drake', cover: 'linear-gradient(135deg, #93c5fd, #c4b5fd)' },
          { title: '丸ノ内サディスティック', artist: '椎名林檎', cover: 'linear-gradient(135deg, #a78bfa, #f472b6)' },
          { title: '杀死那个石家庄人', artist: '万青', cover: 'linear-gradient(135deg, #4ade80, #22c55e)' },
          { title: 'Death With Dignity', artist: 'Sufjan Stevens', cover: 'linear-gradient(135deg, #fca5a5, #fb7185)' },
        ],
      },
      {
        id: 'p3',
        title: '风和草地',
        tracks: [
          { title: '梦幻丽莎发廊', artist: '五条人', cover: 'linear-gradient(135deg, #fbbf24, #f97316)' },
          { title: 'Fake Plastic Trees', artist: 'Radiohead', cover: 'linear-gradient(135deg, #94a3b8, #64748b)' },
          { title: '孤独的人是可耻的', artist: '张楚', cover: 'linear-gradient(135deg, #a3e635, #22c55e)' },
          { title: 'White Winter Hymnal', artist: 'Fleet Foxes', cover: 'linear-gradient(135deg, #fde68a, #fef3c7)' },
          { title: '平凡之路', artist: '朴树', cover: 'linear-gradient(135deg, #fda4af, #f97316)' },
        ],
      },
    ],
    []
  );

  const [activeIndex, setActiveIndex] = useState(1);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const touchStartXRef = useRef(null);
  const dragXRef = useRef(0);
  const rafRef = useRef(0);
  const animatingRef = useRef(false);

  const total = playlists.length;

  const getRole = (index) => {
    if (index === activeIndex) return 'active';
    if (index === (activeIndex - 1 + total) % total) return 'left';
    if (index === (activeIndex + 1) % total) return 'right';
    return 'hidden';
  };

  const change = (direction) => {
    if (animatingRef.current || total <= 1) return;
    animatingRef.current = true;
    setDragX(direction === 'left' ? -SWIPE_OUT_DISTANCE : SWIPE_OUT_DISTANCE);

    window.setTimeout(() => {
      setActiveIndex((prev) => {
        if (direction === 'left') return (prev + 1) % total;
        return (prev - 1 + total) % total;
      });
      setDragX(0);
      dragXRef.current = 0;
      animatingRef.current = false;
    }, TRANSITION_MS);
  };

  const handleTouchStart = (e) => {
    if (animatingRef.current) return;
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
    dragXRef.current = 0;
    setDragX(0);
    setIsDragging(false);
  };

  const handleTouchMove = (e) => {
    const startX = touchStartXRef.current;
    if (startX === null || animatingRef.current) return;
    const x = e.touches[0]?.clientX ?? null;
    if (x === null) return;

    const delta = x - startX;
    dragXRef.current = delta;
    if (!isDragging) setIsDragging(true);

    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      setDragX(dragXRef.current);
      rafRef.current = 0;
    });
  };

  const handleTouchEnd = () => {
    const delta = dragXRef.current;
    touchStartXRef.current = null;
    dragXRef.current = 0;
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }

    setIsDragging(false);

    if (Math.abs(delta) >= SWIPE_THRESHOLD) {
      change(delta < 0 ? 'left' : 'right');
      return;
    }

    setDragX(0);
  };

  const getCardStyle = ({ role }) => {
    const parallax = role === 'active' ? 1 : 0.15;
    const dx = dragX * parallax;

    const base = {
      active: { x: 0, rotate: 0, scale: 1, opacity: 1, zIndex: 3 },
      left: { x: -30, rotate: -7, scale: 0.95, opacity: 0.78, zIndex: 2 },
      right: { x: 30, rotate: 7, scale: 0.95, opacity: 0.72, zIndex: 1 },
      hidden: { x: 0, rotate: 0, scale: 0.92, opacity: 0, zIndex: 0 },
    };

    const cfg = base[role];
    const x = cfg.x + dx;

    return {
      zIndex: cfg.zIndex,
      opacity: cfg.opacity,
      transform: `translate3d(calc(-50% + ${x}px), 0, 0) rotate(${cfg.rotate}deg) scale(${cfg.scale})`,
      transitionDuration: isDragging ? '0ms' : `${TRANSITION_MS}ms`,
    };
  };

  return (
    <section id="song" className="song-section">
      <h2>Song</h2>
      <p className="subtitle">三张歌单卡片：电脑端漂浮排列，移动端可左右滑动切换。</p>

      <div className="song-desktop-grid" aria-hidden="true">
        {playlists.map((p, idx) => (
          <div key={p.id} className={`song-float-wrapper song-float-${idx}`.trim()}>
            <SongCard playlist={p} variant={idx} />
          </div>
        ))}
      </div>

      <div
        className={`song-mobile-deck ${isDragging ? 'dragging' : ''}`.trim()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {playlists.map((p, idx) => {
          const role = getRole(idx);
          return (
            <SongCard
              key={p.id}
              playlist={p}
              variant={idx}
              className={`song-deck-card ${role}`.trim()}
              style={getCardStyle({ role })}
            />
          );
        })}

        <div className="song-indicators" aria-label="歌单切换进度">
          {playlists.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              className={`song-dot ${idx === activeIndex ? 'active' : ''}`.trim()}
              aria-label={`切换到歌单 ${idx + 1}`}
              onClick={() => {
                setDragX(0);
                dragXRef.current = 0;
                setActiveIndex(idx);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
