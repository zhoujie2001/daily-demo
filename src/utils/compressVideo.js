import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const SKIP_COMPRESS_SIZE = 20 * 1024 * 1024;
let ffmpeg;
let loadingPromise;
let compressionQueue = Promise.resolve();
let jobSequence = 0;

async function loadFFmpeg() {
  if (!ffmpeg) {
    ffmpeg = new FFmpeg({ log: true });
  }

  if (!ffmpeg.loaded) {
    loadingPromise ||= ffmpeg.load().catch((error) => {
      loadingPromise = undefined;
      throw error;
    });
    await loadingPromise;
  }

  return ffmpeg;
}

// A single FFmpeg instance owns one worker and one virtual filesystem. Queue
// jobs so concurrent selections cannot run exec/read/delete against each other.
function enqueueCompression(task) {
  const queuedTask = compressionQueue.then(task, task);
  compressionQueue = queuedTask.catch(() => undefined);
  return queuedTask;
}

function createJobId() {
  jobSequence += 1;
  return `${Date.now()}-${jobSequence}`;
}

export async function compressVideo(file, onProgress) {
  if (!file || file.size < SKIP_COMPRESS_SIZE) {
    onProgress?.(100);
    return file;
  }

  return enqueueCompression(async () => {
    const instance = await loadFFmpeg();
    const jobId = createJobId();
    const inputName = `input-video-${jobId}`;
    const outputName = `output-video-${jobId}.mp4`;
    const handleProgress = ({ progress }) => {
      const percent = Math.min(99, Math.max(0, Math.round((progress || 0) * 100)));
      onProgress?.(percent);
    };

    onProgress?.(0);
    instance.on('progress', handleProgress);

    try {
      await instance.writeFile(inputName, await fetchFile(file));
      const exitCode = await instance.exec([
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
        outputName,
      ]);

      if (exitCode !== 0) {
        throw new Error(`FFmpeg compression failed with exit code ${exitCode}`);
      }

      const data = await instance.readFile(outputName);
      const compressedFile = new File([data], `${file.name.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`, {
        type: 'video/mp4',
        lastModified: Date.now(),
      });

      onProgress?.(100);
      return compressedFile.size < file.size ? compressedFile : file;
    } finally {
      instance.off('progress', handleProgress);
      await Promise.allSettled([instance.deleteFile(inputName), instance.deleteFile(outputName)]);
    }
  });
}
