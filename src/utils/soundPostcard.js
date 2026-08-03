import { MAX_UPLOAD_REQUEST_BYTES, formatFileSize } from './uploadLimits.js';

export const SOUND_POSTCARD_MIN_SECONDS = 10;
export const SOUND_POSTCARD_MAX_SECONDS = 30;

const AUDIO_FILE_PATTERN = /\.(aac|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/i;

export function isSoundPostcardFile(file) {
  const type = String(file?.type || '').toLowerCase();
  return type.startsWith('audio/') || AUDIO_FILE_PATTERN.test(String(file?.name || ''));
}

export function formatSoundDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function validateSoundPostcard(file, duration) {
  if (!file || !isSoundPostcardFile(file)) {
    throw new Error('请选择 MP3、M4A、WebM、OGG 或 WAV 音频');
  }

  if (Number(file.size) > MAX_UPLOAD_REQUEST_BYTES) {
    throw new Error(
      `声音文件为 ${formatFileSize(file.size)}，超过上传上限 ${formatFileSize(MAX_UPLOAD_REQUEST_BYTES)}`
    );
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取声音时长，请换一个音频文件');
  }

  // MediaRecorder and some mobile containers can differ from wall-clock time
  // by a fraction of a second, so keep a small tolerance around the limits.
  if (duration < SOUND_POSTCARD_MIN_SECONDS - 0.35) {
    throw new Error(`声音明信片至少需要 ${SOUND_POSTCARD_MIN_SECONDS} 秒`);
  }
  if (duration > SOUND_POSTCARD_MAX_SECONDS + 0.75) {
    throw new Error(`声音明信片最长只能录制 ${SOUND_POSTCARD_MAX_SECONDS} 秒`);
  }

  return Math.min(SOUND_POSTCARD_MAX_SECONDS, Math.max(SOUND_POSTCARD_MIN_SECONDS, duration));
}

export function readAudioDuration(file, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      reject(new Error('当前环境无法读取音频'));
      return;
    }

    const audio = document.createElement('audio');
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const timeoutId = window.setTimeout(() => finish(new Error('读取声音时长超时')), timeoutMs);

    function cleanup() {
      window.clearTimeout(timeoutId);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(objectUrl);
    }

    function finish(error, duration) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(duration);
    }

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration);
      if (Number.isFinite(duration) && duration > 0) finish(null, duration);
      else finish(new Error('声音文件没有有效时长'));
    };
    audio.onerror = () => finish(new Error('浏览器无法解析这个声音文件'));
    audio.src = objectUrl;
  });
}

export async function inspectSoundPostcard(file, { durationHint } = {}) {
  let duration;
  try {
    duration = await readAudioDuration(file);
  } catch (error) {
    if (!Number.isFinite(durationHint) || durationHint <= 0) throw error;
    duration = durationHint;
  }

  return {
    duration: validateSoundPostcard(file, duration),
    mimeType: file.type || 'audio/mpeg',
    name: String(file.name || '声音明信片'),
  };
}

export function chooseRecorderMimeType(MediaRecorderClass) {
  if (!MediaRecorderClass?.isTypeSupported) return '';
  return [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/webm',
  ].find((type) => MediaRecorderClass.isTypeSupported(type)) || '';
}

export function extensionForAudioMime(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('mp4')) return 'm4a';
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('webm')) return 'webm';
  return 'audio';
}
