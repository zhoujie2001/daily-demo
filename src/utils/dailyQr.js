import qrcode from 'qrcode-generator';

export function createQrMatrix(value, { errorCorrectionLevel = 'M', quietZone = 4 } = {}) {
  const qr = qrcode(0, errorCorrectionLevel);
  qr.addData(String(value || ''));
  qr.make();

  const moduleCount = qr.getModuleCount();
  const rows = Array.from({ length: moduleCount }, (_, row) => (
    Array.from({ length: moduleCount }, (_, column) => qr.isDark(row, column))
  ));

  return {
    moduleCount,
    quietZone,
    size: moduleCount + quietZone * 2,
    rows,
  };
}

export function createQrGeometry(value, options) {
  const matrix = createQrMatrix(value, options);
  const commands = [];

  matrix.rows.forEach((row, rowIndex) => {
    let runStart = -1;

    for (let column = 0; column <= matrix.moduleCount; column += 1) {
      const isDark = column < matrix.moduleCount && row[column];
      if (isDark && runStart < 0) runStart = column;
      if (!isDark && runStart >= 0) {
        const width = column - runStart;
        commands.push(`M${runStart + matrix.quietZone} ${rowIndex + matrix.quietZone}h${width}v1h-${width}z`);
        runStart = -1;
      }
    }
  });

  return {
    path: commands.join(''),
    size: matrix.size,
  };
}

