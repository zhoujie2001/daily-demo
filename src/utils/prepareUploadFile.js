import { compressImage, isImageFile } from './compressImage.js';
import { compressVideo } from './compressVideo.js';

export async function prepareUploadFile(file) {
  // Some iOS/embedded browsers return an empty or generic MIME type for
  // camera-roll files. File extensions are therefore part of detection.
  if (isImageFile(file)) return compressImage(file);
  if (file?.type?.startsWith('video/') || /\.(?:m4v|mov|mp4|webm)$/i.test(file?.name || '')) {
    return compressVideo(file);
  }
  return file;
}
