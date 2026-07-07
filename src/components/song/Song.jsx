import React, { useEffect, useState } from 'react';
import SongCard from './SongCard';
import { LoadingBlock } from '../ui/Loading';
import { fetchPlaylist } from '../../api/song';

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

  return (
    <section id="song" className="song-section">
      <h2>Song</h2>

      {loading ? (
        <div className="song-loading">
          <LoadingBlock label="正在从 QQ 音乐加载歌单..." />
        </div>
      ) : null}

      <div className="song-grid">
        {playlists.map((p, idx) => (
          <SongCard key={p.id} playlist={p} variant={idx} />
        ))}
      </div>
    </section>
  );
}
