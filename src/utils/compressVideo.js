import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const SKIP_COMPRESS_SIZE = 20 * 1024 * 1024;
const INPUT_NAME = 'input-video';
const OUTPUT_NAME = 'output.mp4';

let ffmpeg;
let loadingPromise;

async function loadFFmpeg() {
  if (!ffmpeg) {
    ffmpeg = new FFmpeg({ log: true });
  }

  if (!ffmpeg.loaded) {
    loadingPromise ||= ffmpeg.load();
    await loadingPromise;
  }

  return ffmpeg;
}

export async function compressVideo(file, onProgress) {
  if (!file || file.size < SKIP_COMPRESS_SIZE) {
    onProgress?.(100);
    return file;
  }

  const instance = await loadFFmpeg();
  onProgress?.(0);

  const inputName = `${INPUT_NAME}-${Date.now()}`;
  instance.on('progress', ({ progress }) => {
    const percent = Math.min(99, Math.max(0, Math.round((progress || 0) * 100)));
    onProgress?.(percent);
  });

  try {
    await instance.writeFile(inputName, await fetchFile(file));
    await instance.exec([
      '-i',
      inputName,
      '-vf',
      'scale=-2:720',
      '-c:v',
      'libx264',
      '-b:v',
      '1500k',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      'faststart',
      OUTPUT_NAME,
    ]);

    const data = await instance.readFile(OUTPUT_NAME);
    const compressedFile = new File([data.buffer], `${file.name.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`, {
      type: 'video/mp4',
      lastModified: Date.now(),
    });

    onProgress?.(100);
    return compressedFile;
  } finally {
    await Promise.allSettled([instance.deleteFile(inputName), instance.deleteFile(OUTPUT_NAME)]);
  }
}
