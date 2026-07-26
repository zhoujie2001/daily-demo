import React from 'react';

export function BottleIcon({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 3h6v3l1.2 1.4c1.15 1.35 1.8 3.05 1.8 4.82V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6.78c0-1.77.65-3.47 1.8-4.82L9 6V3Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 6h6M9 3h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m9.2 15.2 5.7-1.35.55 3.1-5.7 1.35-.55-3.1Z" fill="currentColor" opacity=".24" />
    </svg>
  );
}

export function BottleCork({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 30 24" aria-hidden="true">
      <defs>
        <linearGradient id="drift-cork-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#efd16f" />
          <stop offset="1" stopColor="#bc7d27" />
        </linearGradient>
      </defs>
      <path d="M5 4.5C5 2.57 6.57 1 8.5 1h13C23.43 1 25 2.57 25 4.5V22H5V4.5Z" fill="url(#drift-cork-fill)" stroke="#8f5b20" strokeWidth="1.4" />
      <path d="M9 4v14M14 3v16M20 4v14" stroke="#fff3ba" strokeWidth="1" opacity=".48" />
    </svg>
  );
}

export default function BottleIllustration({ corked = true, className = '' }) {
  return (
    <svg
      className={`drift-bottle-art ${className}`.trim()}
      viewBox="0 0 86 150"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="drift-glass-fill" x1="11" y1="20" x2="72" y2="135">
          <stop stopColor="#fff" stopOpacity=".92" />
          <stop offset=".5" stopColor="#edf5f2" stopOpacity=".58" />
          <stop offset="1" stopColor="#d7e8e4" stopOpacity=".76" />
        </linearGradient>
        <linearGradient id="drift-paper-fill" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fff9e9" />
          <stop offset="1" stopColor="#e6d6b8" />
        </linearGradient>
        <filter id="drift-bottle-shadow" x="-30%" y="-20%" width="160%" height="170%">
          <feDropShadow dx="0" dy="7" stdDeviation="5" floodColor="#31484b" floodOpacity=".22" />
        </filter>
      </defs>

      <g filter="url(#drift-bottle-shadow)">
        <path
          d="M31 10h24v27c0 5 2.3 8.2 7.4 12.5C71.8 57.4 77 69.3 77 82v43c0 10.5-8.5 19-19 19H28c-10.5 0-19-8.5-19-19V82c0-12.7 5.2-24.6 14.6-32.5C28.7 45.2 31 42 31 37V10Z"
          fill="url(#drift-glass-fill)"
          stroke="#f9ffff"
          strokeWidth="2.4"
        />
        <path
          d="M18 76c2-10.5 7.6-18.5 16-24M17 91v31c0 7 5 12 12 13"
          stroke="#fff"
          strokeWidth="4"
          strokeLinecap="round"
          opacity=".65"
        />
        <path
          d="M29 95c7-4.5 20.5-6.5 29-4l3.8 31.5c-9.4-2.2-20.4.1-29.8 4L29 95Z"
          fill="url(#drift-paper-fill)"
          stroke="#c6ae82"
          strokeWidth="1.2"
        />
        <path d="M33 101c8-2.7 16-3.7 24-2.2M34 108c7.4-2.4 15-3.2 23-1.8M35 115c7-2.1 14-2.7 22-1.4" stroke="#a65f42" strokeWidth="1.2" opacity=".42" />
        <path d="M29 33h28M30 21h26" stroke="#d7e9e6" strokeWidth="2" />
      </g>

      {corked ? (
        <g>
          <path d="M29 5c0-2.76 2.24-5 5-5h18c2.76 0 5 2.24 5 5v18H29V5Z" fill="#d6a23f" stroke="#8f5b20" strokeWidth="1.5" />
          <path d="M35 4v15M42 3v17M50 4v15" stroke="#fff0a8" strokeWidth="1.2" opacity=".52" />
        </g>
      ) : null}
    </svg>
  );
}
