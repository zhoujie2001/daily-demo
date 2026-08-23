import React, { useMemo } from 'react';
import qrcode from 'qrcode-generator';

function createQrGeometry(value) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4;
  const commands = [];

  for (let row = 0; row < moduleCount; row += 1) {
    let runStart = -1;

    for (let column = 0; column <= moduleCount; column += 1) {
      const isDark = column < moduleCount && qr.isDark(row, column);
      if (isDark && runStart < 0) runStart = column;
      if (!isDark && runStart >= 0) {
        const width = column - runStart;
        commands.push(`M${runStart + quietZone} ${row + quietZone}h${width}v1h-${width}z`);
        runStart = -1;
      }
    }
  }

  return {
    path: commands.join(''),
    size: moduleCount + quietZone * 2,
  };
}

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
