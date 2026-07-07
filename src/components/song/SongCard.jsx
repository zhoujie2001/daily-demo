import React from 'react';

export default function SongCard({ playlist, variant = 0, floating = false, style, className = '' }) {
  return (
    <div
      className={`song-card song-card-variant-${variant} ${floating ? `song-float song-float-${variant}` : ''} ${className}`.trim()}
      style={style}
    >
      <div className="song-card-header">
        <div className="song-card-title">{playlist.title}</div>
      </div>

      <ol className="song-track-list">
        {playlist.tracks.map((t) => (
          <li key={`${playlist.id}-${t.title}-${t.artist}`} className="song-track">
            <span className="song-track-cover" style={{ background: t.cover }} aria-hidden="true" />
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
