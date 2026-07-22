import React from 'react';

export default function About({ isAdmin, onRequestLogin }) {
  return (
    <section id="about" className="about-section">
      <h1
        onDoubleClick={() => !isAdmin && onRequestLogin()}
        style={{ cursor: isAdmin ? 'default' : 'pointer' }}
        title={!isAdmin ? 'Double click to login as admin' : ''}
      >
        四十四次日落 / Dylan
      </h1>
      <p className="subtitle">
        A pessimist in the third quadrant, yet passionate about movement.
      </p>
      <p className="about-intro">因为天气好，因为天气不好，因为天气感刚好。现居成都。</p>
    </section>
  );
}
