import React from 'react';
import { siteBrand } from '../data/site';
import AboutFilm from './about/AboutFilm';

export default function About({ isAdmin, onRequestLogin, onFilmVisibilityChange }) {
  return (
    <section id="about" className="about-section about-film-section">
      <AboutFilm onVisibilityChange={onFilmVisibilityChange} />
      <div className="about-film-content">
        <h1
          onDoubleClick={() => !isAdmin && onRequestLogin()}
          style={{ cursor: isAdmin ? 'default' : 'pointer' }}
          title={!isAdmin ? '双击进入管理登录' : ''}
        >
          <span className="about-lockup-name">{siteBrand.name}</span>
          <span className="about-lockup-owner"> / {siteBrand.ownerAlias}</span>
        </h1>
        <p className="subtitle">{siteBrand.tagline}</p>
        <p className="about-intro">{siteBrand.intro}</p>
      </div>
    </section>
  );
}
