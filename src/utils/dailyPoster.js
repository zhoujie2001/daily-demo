import { createQrMatrix } from './dailyQr.js';
import { createDailySharePayload } from './dailyShare.js';
import { parsePostDate, toDateKey } from './timeMachine.js';

export const DAILY_POSTER_WIDTH = 1080;
export const DAILY_POSTER_HEIGHT = 1440;

const COLORS = {
  paper: '#f5f0e7',
  surface: '#fffdf9',
  ink: '#29241e',
  muted: '#776f65',
  faint: '#a29a90',
  line: '#d9d0c4',
  accent: '#b16543',
};

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxLength) {
  const text = compactText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function formatPosterDate(value) {
  const parsed = parsePostDate(value);
  if (!parsed) return compactText(value) || '某一天';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).format(parsed);
}

export function createDailyPosterModel(post, payload = createDailySharePayload(post)) {
  const title = truncateText(post?.title, 44);
  const body = truncateText(post?.text, title ? 180 : 220);
  const tags = Array.isArray(post?.tags)
    ? post.tags.map(compactText).filter(Boolean).slice(0, 5)
    : [];

  return {
    siteTitle: '四十四次日落',
    eyebrow: 'A DAILY FROM DYLAN',
    date: formatPosterDate(post?.date),
    title,
    body: body || '把普通日子收进时间里。',
    tags,
    url: payload.url,
    fileName: `四十四次日落-${toDateKey(post?.date) || post?.id || 'daily'}.png`,
  };
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function getWrappedLines(context, text, maxWidth, maxLines) {
  const characters = Array.from(compactText(text));
  const lines = [];
  let current = '';

  characters.forEach((character) => {
    const candidate = current + character;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  });
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  let last = visible[maxLines - 1];
  while (last && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  visible[maxLines - 1] = `${last}…`;
  return visible;
}

function drawLines(context, lines, x, y, lineHeight) {
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
}

function drawQrCode(context, value, x, y, size) {
  const matrix = createQrMatrix(value, { errorCorrectionLevel: 'M', quietZone: 4 });
  const unit = size / matrix.size;

  context.save();
  context.fillStyle = COLORS.surface;
  context.fillRect(x, y, size, size);
  context.fillStyle = COLORS.ink;
  matrix.rows.forEach((row, rowIndex) => {
    row.forEach((isDark, columnIndex) => {
      if (!isDark) return;
      context.fillRect(
        x + (columnIndex + matrix.quietZone) * unit,
        y + (rowIndex + matrix.quietZone) * unit,
        Math.ceil(unit),
        Math.ceil(unit),
      );
    });
  });
  context.restore();
}

export async function createDailyPosterCanvas(post, {
  payload = createDailySharePayload(post),
  documentObject = typeof document === 'undefined' ? null : document,
} = {}) {
  if (!documentObject?.createElement) throw new Error('当前浏览器无法生成分享卡片');
  if (documentObject.fonts?.ready) await documentObject.fonts.ready;

  const model = createDailyPosterModel(post, payload);
  const canvas = documentObject.createElement('canvas');
  canvas.width = DAILY_POSTER_WIDTH;
  canvas.height = DAILY_POSTER_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成分享卡片');

  context.fillStyle = COLORS.paper;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const gradient = context.createRadialGradient(846, 112, 20, 846, 112, 560);
  gradient.addColorStop(0, 'rgba(177, 101, 67, 0.18)');
  gradient.addColorStop(1, 'rgba(177, 101, 67, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, 660);

  roundedRect(context, 58, 58, 964, 1324, 32);
  context.fillStyle = 'rgba(255, 253, 249, 0.72)';
  context.fill();
  context.strokeStyle = COLORS.line;
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = COLORS.accent;
  context.fillRect(108, 124, 48, 5);
  context.font = '500 24px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.letterSpacing = '3px';
  context.fillText(model.eyebrow, 108, 178);
  context.letterSpacing = '0px';

  context.fillStyle = COLORS.ink;
  context.font = '500 60px "Noto Serif SC", "Songti SC", STSong, serif';
  context.fillText(model.siteTitle, 108, 276);

  context.fillStyle = COLORS.faint;
  context.font = '400 24px "Noto Sans SC", system-ui, sans-serif';
  context.fillText('把普通日子收进时间里', 110, 324);

  context.strokeStyle = COLORS.line;
  context.beginPath();
  context.moveTo(108, 378);
  context.lineTo(972, 378);
  context.stroke();

  context.fillStyle = COLORS.ink;
  context.font = 'italic 500 86px Georgia, "Times New Roman", serif';
  const dateLines = getWrappedLines(context, model.date, 830, 2);
  drawLines(context, dateLines, 108, 506, 94);

  let contentY = 666;
  if (model.title) {
    context.font = '500 38px "Noto Serif SC", "Songti SC", STSong, serif';
    const titleLines = getWrappedLines(context, model.title, 710, 2);
    drawLines(context, titleLines, 108, contentY, 56);
    contentY += titleLines.length * 56 + 30;
  }

  context.fillStyle = COLORS.muted;
  context.font = '400 30px "Noto Serif SC", "Songti SC", STSong, serif';
  const bodyLines = getWrappedLines(context, model.body, 710, model.title ? 6 : 8);
  drawLines(context, bodyLines, 108, contentY, 52);

  if (model.tags.length) {
    let tagX = 108;
    const tagY = 1116;
    context.font = '400 22px "Noto Sans SC", system-ui, sans-serif';
    model.tags.forEach((tag) => {
      const label = `#${tag}`;
      const width = context.measureText(label).width + 32;
      if (tagX + width > 712) return;
      roundedRect(context, tagX, tagY, width, 44, 22);
      context.fillStyle = 'rgba(177, 101, 67, 0.09)';
      context.fill();
      context.fillStyle = COLORS.accent;
      context.fillText(label, tagX + 16, tagY + 30);
      tagX += width + 12;
    });
  }

  drawQrCode(context, model.url, 778, 1082, 178);
  context.fillStyle = COLORS.faint;
  context.font = '400 20px "Noto Sans SC", system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('扫码回到这一天', 867, 1292);
  context.textAlign = 'left';

  context.fillStyle = COLORS.ink;
  context.font = '500 23px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.fillText('littlearisa88.com', 108, 1302);

  return { canvas, model };
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('分享卡片生成失败，请重试'));
    }, 'image/png', 1);
  });
}

export function canSharePosterFile(file, navigatorObject = typeof navigator === 'undefined' ? null : navigator) {
  return Boolean(file && navigatorObject?.share && navigatorObject?.canShare?.({ files: [file] }));
}

export function downloadPoster(blobUrl, fileName, documentObject = typeof document === 'undefined' ? null : document) {
  if (!documentObject?.body) throw new Error('当前浏览器无法保存图片');
  const link = documentObject.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  link.rel = 'noopener';
  documentObject.body.appendChild(link);
  link.click();
  link.remove();
}

