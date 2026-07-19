import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export const VIDEO_COMPRESSION_THRESHOLD = 20 * 1024 * 1024;
const FFMPEG_CORE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
];
let ffmpeg;
let loadingPromise;
let compressionQueue = Promise.resolve();
let jobSequence = 0;

async function loadFFmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;

  if (!loadingPromise) {
    loadingPromise = (async () => {
      let lastError;

      for (const baseURL of FFMPEG_CORE_SOURCES) {
        let coreURL;
        let wasmURL;
        const candidate = new FFmpeg({ log: true });

        try {
          coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
          wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
          await candidate.load({ coreURL, wasmURL });
          ffmpeg = candidate;
          return ffmpeg;
        } catch (error) {
          lastError = error;
          candidate.terminate();
          console.warn(`Failed to load FFmpeg core from ${baseURL}:`, error);
        } finally {
          if (coreURL) URL.revokeObjectURL(coreURL);
          if (wasmURL) URL.revokeObjectURL(wasmURL);
        }
      }

      throw new Error(`视频压缩组件加载失败：${lastError?.message || 'CDN 资源不可用'}`, { cause: lastError });
    })().catch((error) => {
      loadingPromise = undefined;
      throw error;
    });
  }

  return loadingPromise;
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
  if (!file || file.size < VIDEO_COMPRESSION_THRESHOLD) {
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
      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('FFmpeg produced an empty video file');
      }
      const compressedFile = new File([data], `${file.name.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`, {
        type: 'video/mp4',
        lastModified: Date.now(),
      });

      if (compressedFile.size >= file.size) {
        throw new Error('压缩后文件没有变小，请缩短视频或降低源视频画质后重试');
      }

      onProgress?.(100);
      return compressedFile;
    } finally {
      instance.off('progress', handleProgress);
      await Promise.allSettled([instance.deleteFile(inputName), instance.deleteFile(outputName)]);
    }
  });
}
