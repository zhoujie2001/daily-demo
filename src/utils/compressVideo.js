import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { MAX_UPLOAD_REQUEST_BYTES, formatFileSize } from './uploadLimits';

export const VIDEO_COMPRESSION_THRESHOLD = MAX_UPLOAD_REQUEST_BYTES;
const FFMPEG_CORE_SOURCES = [
  { baseURL: new URL(`${import.meta.env.BASE_URL}ffmpeg`, window.location.origin).href, useBlob: false },
  { baseURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm', useBlob: true },
  { baseURL: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm', useBlob: true },
];
let ffmpeg;
let loadingPromise;
let compressionQueue = Promise.resolve();
let jobSequence = 0;

async function createLocalWasmURL(baseURL) {
  const partURLs = [`${baseURL}/ffmpeg-core.wasm.part1`, `${baseURL}/ffmpeg-core.wasm.part2`];
  const parts = [];

  for (const partURL of partURLs) {
    const response = await fetch(partURL);
    if (!response.ok) {
      throw new Error(`FFmpeg 核心分片加载失败 (${response.status})`);
    }
    parts.push(await response.arrayBuffer());
  }

  return URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
}

async function loadFFmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;

  if (!loadingPromise) {
    loadingPromise = (async () => {
      let lastError;

      for (const { baseURL, useBlob } of FFMPEG_CORE_SOURCES) {
        let coreURL;
        let wasmURL;
        const candidate = new FFmpeg({ log: true });

        try {
          coreURL = useBlob
            ? await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
            : `${baseURL}/ffmpeg-core.js`;
          wasmURL = useBlob
            ? await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
            : await createLocalWasmURL(baseURL);
          await candidate.load({ coreURL, wasmURL });
          ffmpeg = candidate;
          return ffmpeg;
        } catch (error) {
          lastError = error;
          candidate.terminate();
          console.warn(`Failed to load FFmpeg core from ${baseURL}:`, error);
        } finally {
          if (useBlob && coreURL) URL.revokeObjectURL(coreURL);
          if (wasmURL?.startsWith('blob:')) URL.revokeObjectURL(wasmURL);
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

function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const timeoutId = window.setTimeout(() => finish(new Error('读取视频时长超时')), 8000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (error, duration) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(duration);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        finish(new Error('无法读取视频时长'));
        return;
      }
      finish(null, duration);
    };
    video.onerror = () => finish(new Error('浏览器无法读取视频信息'));
    video.src = objectUrl;
  });
}

function calculateVideoBitrate(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 1500;
  const targetTotalKbps = Math.floor((MAX_UPLOAD_REQUEST_BYTES * 8 * 0.88) / duration / 1000);
  const audioKbps = targetTotalKbps < 360 ? 48 : 64;
  return Math.min(1500, Math.max(160, targetTotalKbps - audioKbps));
}

async function encodeVideo(instance, inputName, outputName, videoBitrate, scaleHeight) {
  return instance.exec([
    '-i',
    inputName,
    '-map_metadata',
    '-1',
    '-vf',
    `scale=-2:${scaleHeight}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${videoBitrate}k`,
    '-maxrate',
    `${videoBitrate}k`,
    '-bufsize',
    `${videoBitrate * 2}k`,
    '-c:a',
    'aac',
    '-b:a',
    videoBitrate < 360 ? '48k' : '64k',
    '-movflags',
    'faststart',
    outputName,
  ]);
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
    const retryOutputName = `output-video-${jobId}-retry.mp4`;
    let encodingPass = 0;
    const handleProgress = ({ progress }) => {
      const normalized = Math.min(1, Math.max(0, progress || 0));
      const percent = encodingPass === 0 ? Math.round(normalized * 70) : 70 + Math.round(normalized * 29);
      onProgress?.(percent);
    };

    onProgress?.(0);
    instance.on('progress', handleProgress);

    try {
      const duration = await readVideoDuration(file).catch(() => 0);
      let videoBitrate = calculateVideoBitrate(duration);
      await instance.writeFile(inputName, await fetchFile(file));
      let finalOutputName = outputName;
      let exitCode = await encodeVideo(instance, inputName, outputName, videoBitrate, 720);

      if (exitCode !== 0) {
        throw new Error(`FFmpeg compression failed with exit code ${exitCode}`);
      }

      let data = await instance.readFile(outputName);
      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('FFmpeg produced an empty video file');
      }

      if (data.byteLength > MAX_UPLOAD_REQUEST_BYTES) {
        encodingPass = 1;
        videoBitrate = Math.max(
          120,
          Math.floor(videoBitrate * (MAX_UPLOAD_REQUEST_BYTES / data.byteLength) * 0.82)
        );
        exitCode = await encodeVideo(instance, inputName, retryOutputName, videoBitrate, videoBitrate < 400 ? 480 : 720);
        if (exitCode !== 0) {
          throw new Error(`FFmpeg retry failed with exit code ${exitCode}`);
        }
        finalOutputName = retryOutputName;
        data = await instance.readFile(finalOutputName);
      }

      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('FFmpeg produced an empty video file');
      }
      if (data.byteLength > MAX_UPLOAD_REQUEST_BYTES) {
        throw new Error(
          `视频压缩后仍有 ${formatFileSize(data.byteLength)}，请缩短视频后重试（安全上限 ${formatFileSize(
            MAX_UPLOAD_REQUEST_BYTES
          )}）`
        );
      }

      const compressedFile = new File([data], `${file.name.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`, {
        type: 'video/mp4',
        lastModified: Date.now(),
      });

      onProgress?.(100);
      return compressedFile;
    } finally {
      instance.off('progress', handleProgress);
      await Promise.allSettled([
        instance.deleteFile(inputName),
        instance.deleteFile(outputName),
        instance.deleteFile(retryOutputName),
      ]);
    }
  });
}
