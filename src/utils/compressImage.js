import { MAX_UPLOAD_REQUEST_BYTES } from './uploadLimits';

const MAX_IMAGE_EDGE = 2048;
const MIN_IMAGE_EDGE = 960;
const JPEG_QUALITIES = [0.84, 0.76, 0.68, 0.6];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('当前浏览器无法读取这张图片，请先在相册中导出为 JPEG 后重试'));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('浏览器未能生成压缩图片'));
      },
      'image/jpeg',
      quality
    );
  });
}

function fitWithin(width, height, maxEdge) {
  const largestEdge = Math.max(width, height);
  if (largestEdge <= maxEdge) return { width, height };
  const ratio = maxEdge / largestEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function createOutputName(name) {
  const baseName = (name || 'image').replace(/\.[^.]+$/, '') || 'image';
  return `${baseName}-optimized.jpg`;
}

async function renderJpeg(image, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片压缩');

  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvasToBlob(canvas, quality);
}

export async function compressImage(file) {
  if (!file || !file.type?.startsWith('image/') || file.size <= MAX_UPLOAD_REQUEST_BYTES) {
    return file;
  }

  const image = await loadImage(file);
  let dimensions = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height, MAX_IMAGE_EDGE);
  let bestBlob;

  for (const quality of JPEG_QUALITIES) {
    bestBlob = await renderJpeg(image, dimensions.width, dimensions.height, quality);
    if (bestBlob.size <= MAX_UPLOAD_REQUEST_BYTES) break;
  }

  // Very detailed screenshots can remain large even after lowering JPEG
  // quality. Reduce dimensions gradually while preserving the aspect ratio.
  for (let attempt = 0; bestBlob?.size > MAX_UPLOAD_REQUEST_BYTES && attempt < 3; attempt += 1) {
    const currentEdge = Math.max(dimensions.width, dimensions.height);
    const sizeRatio = Math.sqrt(MAX_UPLOAD_REQUEST_BYTES / bestBlob.size) * 0.9;
    const nextEdge = Math.max(MIN_IMAGE_EDGE, Math.floor(currentEdge * Math.min(0.9, sizeRatio)));
    dimensions = fitWithin(dimensions.width, dimensions.height, nextEdge);
    bestBlob = await renderJpeg(
      image,
      dimensions.width,
      dimensions.height,
      JPEG_QUALITIES[JPEG_QUALITIES.length - 1]
    );
  }

  if (!bestBlob || bestBlob.size > MAX_UPLOAD_REQUEST_BYTES) {
    throw new Error('图片压缩后仍然过大，请裁剪图片后重试');
  }

  return new File([bestBlob], createOutputName(file.name), {
    type: 'image/jpeg',
    lastModified: file.lastModified || Date.now(),
  });
}
