const IMAGE_EXTENSIONS = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;
const MOTION_EXTENSIONS = /\.mov$/i;

function fileName(file) {
  return String(file?.name || '').trim();
}

export function isLivePhotoImage(file) {
  return Boolean(file?.type?.startsWith('image/') || IMAGE_EXTENSIONS.test(fileName(file)));
}

export function isLivePhotoMotion(file) {
  return Boolean(file?.type === 'video/quicktime' || MOTION_EXTENSIONS.test(fileName(file)));
}

export function livePhotoBaseName(file) {
  return fileName(file)
    .replace(/\.[^.]+$/, '')
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

  return {
    pairs,
    unpairedImages,
    unpairedMotions: motions.filter((motion) => !usedMotions.has(motion)),
    unsupported,
  };
}

/**
 * Convert a mixed browser selection into genuine paired Live Photos.
 * Unpaired stills and videos are returned to the caller and must never be
 * repackaged as Live Photos.
 */
export function createLivePhotoImportPlan(files) {
  const {
    pairs,
    unpairedImages,
    unpairedMotions,
    unsupported,
  } = pairLivePhotoFiles(files);

  return {
    livePhotos: pairs.map(({ image, motion, match }) => ({ image, motion, match })),
    unpairedImages,
    unpairedMotions,
    unsupported,
  };
}
