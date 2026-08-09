const IMAGE_EXTENSIONS = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;
const MOTION_EXTENSIONS = /\.(?:m4v|mov|mp4|webm)$/i;

function fileName(file) {
  return String(file?.name || '').trim();
}

export function isLivePhotoImage(file) {
  return Boolean(file?.type?.startsWith('image/') || IMAGE_EXTENSIONS.test(fileName(file)));
}

export function isLivePhotoMotion(file) {
  return Boolean(file?.type?.startsWith('video/') || MOTION_EXTENSIONS.test(fileName(file)));
}

export function livePhotoBaseName(file) {
  return fileName(file)
    .replace(/\.[^.]+$/, '')
    .replace(/(?:[-_ ](?:edited|export|original|photo|video|motion))+$/i, '')
    .trim()
    .toLocaleLowerCase();
}

function compareFiles(a, b) {
  const timeDifference = (Number(a?.lastModified) || 0) - (Number(b?.lastModified) || 0);
  return timeDifference || fileName(a).localeCompare(fileName(b), undefined, { numeric: true });
}

/**
 * Pair the still and motion resources exported by iOS/macOS Live Photos.
 * Apple exports normally share the same basename (IMG_1234.HEIC + IMG_1234.MOV).
 * A single image/video selection is also safe to pair even when the names differ.
 */
export function pairLivePhotoFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  const images = list.filter(isLivePhotoImage).sort(compareFiles);
  const motions = list.filter(isLivePhotoMotion).sort(compareFiles);
  const unsupported = list.filter((file) => !isLivePhotoImage(file) && !isLivePhotoMotion(file));
  const usedMotions = new Set();
  const pairs = [];
  const unpairedImages = [];

  images.forEach((image) => {
    const baseName = livePhotoBaseName(image);
    const motion = motions.find(
      (candidate) => !usedMotions.has(candidate) && livePhotoBaseName(candidate) === baseName
    );

    if (motion) {
      usedMotions.add(motion);
      pairs.push({ image, motion, match: 'name' });
    } else {
      unpairedImages.push(image);
    }
  });

  // The common mobile fallback is selecting exactly one still and one motion
  // from different pickers. Pair that unambiguous combination even when the
  // operating system renamed one of the files during export.
  const unusedMotions = motions.filter((motion) => !usedMotions.has(motion));
  if (
    pairs.length === 0
    && images.length === 1
    && motions.length === 1
    && unpairedImages.length === 1
    && unusedMotions.length === 1
  ) {
    const image = unpairedImages.pop();
    const motion = unusedMotions.pop();
    usedMotions.add(motion);
    pairs.push({ image, motion, match: 'single' });
  }

  return {
    pairs,
    unpairedImages,
    unpairedMotions: motions.filter((motion) => !usedMotions.has(motion)),
    unsupported,
  };
}

/**
 * Convert a mixed browser selection into complete logical Live Photos.
 * Motion-only selections are valid because the editor can generate their
 * cover frame. Image-only selections remain ordinary photos instead of
 * creating an incomplete Live Photo that blocks publishing.
 */
export function createLivePhotoImportPlan(files) {
  const {
    pairs,
    unpairedImages,
    unpairedMotions,
    unsupported,
  } = pairLivePhotoFiles(files);

  return {
    livePhotos: [
      ...pairs.map(({ image, motion, match }) => ({ image, motion, match })),
      ...unpairedMotions.map((motion) => ({ image: null, motion, match: 'generated-cover' })),
    ],
    stillImages: unpairedImages,
    unsupported,
  };
}

function posterFileName(videoFile) {
  const baseName = fileName(videoFile).replace(/\.[^.]+$/, '') || 'live-photo';
  return `${baseName}-cover.jpg`;
}

/** Create a browser-compatible JPEG cover from the middle frame of a video. */
export function createLivePhotoPosterFile(videoFile, {
  maxWidth = 1600,
  quality = 0.88,
  timeoutMs = 15_000,
} = {}) {
  if (!videoFile || typeof document === 'undefined' || typeof URL === 'undefined') {
    return Promise.reject(new Error('当前环境无法从动态片段生成实况封面'));
  }

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(videoFile);
    let settled = false;
    let timeoutId;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (message) => finish(() => reject(new Error(message)));

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 0.12
        ? Math.min(Math.max(duration * 0.5, 0.06), duration - 0.06)
        : 0;
    };
    video.onseeked = () => {
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (!sourceWidth || !sourceHeight) {
        fail('动态片段没有可读取的视频画面');
        return;
      }

      const scale = Math.min(1, maxWidth / sourceWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        fail('当前浏览器无法生成实况封面');
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) {
          fail('实况封面生成失败');
          return;
        }
        finish(() => resolve(new File([blob], posterFileName(videoFile), {
          type: 'image/jpeg',
          lastModified: videoFile.lastModified || Date.now(),
        })));
      }, 'image/jpeg', quality);
    };
    video.onerror = () => fail('无法读取动态片段，请选择 iPhone 导出的 MOV 或常见视频文件');
    timeoutId = window.setTimeout(() => fail('生成实况封面超时，请重试'), timeoutMs);
    video.src = objectUrl;
    video.load();
  });
}
