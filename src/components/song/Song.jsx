import React, { useEffect, useMemo, useRef, useState } from 'react';
import SongCard from './SongCard';
import { LoadingBlock } from '../ui/Loading';
import { fetchPlaylist } from '../../api/song';

const SWIPE_THRESHOLD = 60;
const SWIPE_OUT_DISTANCE = 240;
const TRANSITION_MS = 300;

function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const PLAYLISTS_META = [
  { id: '8670100374', name: '光和枯树' },
  { id: '8667064202', name: '雨和屋檐' },
  { id: '8667059995', name: '风和草地' },
];

const FALLBACK_PLAYLISTS = [
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
];

export default function Song() {
  const [playlists, setPlaylists] = useState(FALLBACK_PLAYLISTS);
  const [loading, setLoading] = useState(true);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const touchStartXRef = useRef(null);
  const dragXRef = useRef(0);
  const rafRef = useRef(0);
  const animatingRef = useRef(false);

  const total = playlists.length;

  const visiblePlaylists = useMemo(() => {
    if (!total) return [];
    return [0, 1, 2].map((offset) => ({
      playlist: playlists[(currentIndex + offset) % total],
      offset,
    }));
  }, [currentIndex, playlists, total]);

  useEffect(() => {
    let cancelled = false;

    const loadPlaylists = async () => {
      try {
        const results = await Promise.all(
          PLAYLISTS_META.map(async (meta, index) => {
            try {
              const data = await fetchPlaylist(meta.id);
              const songs = Array.isArray(data?.songs) ? data.songs : [];
              if (songs.length === 0) throw new Error('empty songs');

              const picked = pickRandom(songs, 5);
              const fallbackTracks = FALLBACK_PLAYLISTS[index]?.tracks || [];

              const tracks = picked.map((song, idx) => ({
                title: song.name || fallbackTracks[idx]?.title || '',
                artist: song.singer || fallbackTracks[idx]?.artist || '',
                cover: fallbackTracks[idx]?.cover || 'linear-gradient(135deg, #e5e7eb, #9ca3af)',
                albumPic: song.albumPic || '',
                mid: song.mid || '',
              }));

              return {
                id: meta.id,
                title: data.name || meta.name,
                tracks,
              };
            } catch (err) {
              console.error('Fetch playlist failed', meta.id, err);
              return FALLBACK_PLAYLISTS[index];
            }
          })
        );

        if (!cancelled) setPlaylists(results);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadPlaylists();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentIndex >= total) setCurrentIndex(0);
  }, [currentIndex, total]);

  const animateTo = (direction) => {
    if (animatingRef.current || total <= 1) return;
    animatingRef.current = true;
    setDragX(direction === 'left' ? -SWIPE_OUT_DISTANCE : SWIPE_OUT_DISTANCE);

    window.setTimeout(() => {
      setCurrentIndex((prev) => {
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
    setIsSwiping(false);
  };

  const handleTouchMove = (e) => {
    const startX = touchStartXRef.current;
    if (startX === null || animatingRef.current) return;

    const x = e.touches[0]?.clientX ?? null;
    if (x === null) return;

    const delta = x - startX;
    dragXRef.current = delta;
    if (!isSwiping) setIsSwiping(true);

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

    setIsSwiping(false);

    if (Math.abs(delta) >= SWIPE_THRESHOLD) {
      animateTo(delta < 0 ? 'left' : 'right');
      return;
    }

    setDragX(0);
  };

  const getCardStyle = (offset) => {
    if (offset === 0) {
      return {
        transform: `translate3d(calc(-50% + ${dragX}px), 0, 0) rotate(0deg)`,
        transitionDuration: isSwiping ? '0ms' : `${TRANSITION_MS}ms`,
        zIndex: 3,
      };
    }

    if (offset === 1) {
      return {
        transform: 'translate3d(calc(-50% - 20px), 12px, 0) rotate(-6deg)',
        transitionDuration: `${TRANSITION_MS}ms`,
        zIndex: 2,
      };
    }

    return {
      transform: 'translate3d(calc(-50% + 20px), 12px, 0) rotate(6deg)',
      transitionDuration: `${TRANSITION_MS}ms`,
      zIndex: 1,
    };
  };

  return (
    <section id="song" className="song-section">
      <h2>Song</h2>

      {loading ? (
        <div className="song-loading">
          <LoadingBlock label="正在从 QQ 音乐加载歌单..." />
        </div>
      ) : null}

      <div className="song-grid" aria-hidden="true">
        {playlists.map((p, idx) => (
          <SongCard key={p.id} playlist={p} variant={idx} />
        ))}
      </div>

      <div
        className={`song-deck ${isSwiping ? 'swiping' : ''}`.trim()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="song-deck-cards">
          {visiblePlaylists
            .slice()
            .reverse()
            .map(({ playlist, offset }) => (
              <SongCard
                key={`${playlist.id}-${currentIndex}-${offset}`}
                playlist={playlist}
                variant={(currentIndex + offset) % total}
                className={`song-deck-card ${offset === 0 ? 'active' : ''}`.trim()}
                style={getCardStyle(offset)}
              />
            ))}
        </div>

        <div className="song-dots" aria-label="歌单切换进度">
          {playlists.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              className={`song-dot ${idx === currentIndex ? 'active' : ''}`.trim()}
              aria-label={`切换到歌单 ${idx + 1}`}
              onClick={() => {
                if (animatingRef.current) return;
                setCurrentIndex(idx);
                setDragX(0);
                dragXRef.current = 0;
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
