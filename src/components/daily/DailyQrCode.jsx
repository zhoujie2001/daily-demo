import React, { useMemo } from 'react';
import { createQrGeometry } from '../../utils/dailyQr';

export default function DailyQrCode({ value }) {
  const geometry = useMemo(() => createQrGeometry(value), [value]);

  return (
    <svg
      className="daily-share-qr"
      viewBox={`0 0 ${geometry.size} ${geometry.size}`}
      role="img"
      aria-label="这篇 Daily 的分享二维码"
      shapeRendering="crispEdges"
    >
      <rect width={geometry.size} height={geometry.size} rx="1.4" fill="#fffdf9" />
      <path d={geometry.path} fill="#2d2822" />
    </svg>
  );
}
