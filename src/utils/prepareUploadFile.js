import { compressImage } from './compressImage';
import { compressVideo } from './compressVideo';

export async function prepareUploadFile(file) {
  if (file?.type?.startsWith('image/')) return compressImage(file);
  if (file?.type?.startsWith('video/')) return compressVideo(file);
  return file;
}
