import React, { useMemo, useRef, useState } from 'react';
import SongCard from './SongCard';

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
  const [swipeDirection, setSwipeDirection] = useState('');
  const touchStartXRef = useRef(null);
  const animatingRef = useRef(false);
  const total = playlists.length;

  const move = (direction) => {
    if (animatingRef.current || total <= 1) return;
    animatingRef.current = true;
    setSwipeDirection(direction);
    window.setTimeout(() => {
      setActiveIndex((prev) => {
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
    move(delta < 0 ? 'left' : 'right');
  };

  const getRole = (index) => {
    if (index === activeIndex) return 'active';
    if (index === (activeIndex - 1 + total) % total) return 'left';
    if (index === (activeIndex + 1) % total) return 'right';
    return 'hidden';
  };

  return (
    <section id="song" className="song-section">
      <h2>Song</h2>
      <p className="subtitle">三张歌单卡片：电脑端漂浮排列，移动端可左右滑动切换。</p>

      <div className="song-desktop-grid" aria-hidden="true">
        {playlists.map((p, idx) => (
          <SongCard key={p.id} playlist={p} variant={idx} floating />
        ))}
      </div>

      <div className="song-mobile-deck" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {playlists
          .map((p, idx) => ({ p, idx, role: getRole(idx) }))
          .filter((x) => x.role !== 'hidden')
          .sort((a, b) => {
            const order = { left: 0, right: 1, active: 2 };
            return order[a.role] - order[b.role];
          })
          .map(({ p, idx, role }) => {
            const isActive = role === 'active';
            const swipeClass = isActive && swipeDirection ? `song-swipe-${swipeDirection}` : '';
            return (
              <SongCard
                key={`${p.id}-${activeIndex}`}
                playlist={p}
                variant={idx}
                className={`song-deck-card ${role} ${swipeClass}`.trim()}
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
              onClick={() => setActiveIndex(idx)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
