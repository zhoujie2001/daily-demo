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
  if (unpairedImages.length === 1 && unusedMotions.length === 1) {
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
