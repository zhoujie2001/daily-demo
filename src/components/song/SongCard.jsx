import React from 'react';

export default function SongCard({ playlist, variant = 0, floating = false, style, className = '' }) {
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];

  return (
    <div
      className={`song-card song-card-variant-${variant} ${floating ? `song-float song-float-${variant}` : ''} ${className}`.trim()}
      style={style}
    >
      <div className="song-card-header">
        <div className="song-card-title">{playlist.title}</div>
      </div>

      <ol className="song-track-list">
        {tracks.map((t) => (
          <li key={`${playlist.id}-${t.title}-${t.artist}`} className="song-track">
            <span className="song-track-cover" style={{ background: t.cover }} aria-hidden="true">
              {t.albumPic ? (
                <img
                  src={t.albumPic}
                  alt=""
                  className="song-track-cover-img"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : null}
            </span>
            <span className="song-track-text">
              <span className="song-track-name">{t.title}</span>
              <span className="song-track-sep"> - </span>
              <span className="song-track-artist">{t.artist}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
