import React, { useEffect, useRef, useState } from 'react';
import { Mic2, Square, Upload, Waves } from 'lucide-react';
import {
  SOUND_POSTCARD_MAX_SECONDS,
  SOUND_POSTCARD_MIN_SECONDS,
  chooseRecorderMimeType,
  extensionForAudioMime,
  formatSoundDuration,
} from '../../utils/soundPostcard';

export default function SoundPostcardComposer({ disabled = false, onFileSelected }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const discardRef = useRef(false);

  const stopTracks = () => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const clearTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  };

  useEffect(() => () => {
    discardRef.current = true;
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks();
  }, []);

  const startRecording = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持直接录音，请选择已有音频');
      return;
    }

    try {
      discardRef.current = false;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const mimeType = chooseRecorderMimeType(MediaRecorder);
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      setElapsed(0);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setError('录音发生错误，请重新尝试');
        clearTimer();
        stopTracks();
        setRecording(false);
      };
      recorder.onstop = async () => {
        const duration = Math.min(
          SOUND_POSTCARD_MAX_SECONDS,
          Math.max(0, (Date.now() - startedAtRef.current) / 1000)
        );
        clearTimer();
        stopTracks();
        setRecording(false);
        recorderRef.current = null;
        if (discardRef.current) return;
        if (duration < SOUND_POSTCARD_MIN_SECONDS - 0.35) {
          setError(`请至少录制 ${SOUND_POSTCARD_MIN_SECONDS} 秒`);
          return;
        }

        const actualType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: actualType });
        const extension = extensionForAudioMime(actualType);
        const file = new File([blob], `sound-postcard-${Date.now()}.${extension}`, {
          type: actualType,
          lastModified: Date.now(),
        });
        const accepted = await onFileSelected?.(file, { durationHint: duration });
        if (accepted === false) setError('声音没有加入 Daily，请根据提示重新选择');
      };

      recorder.start(250);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const seconds = (Date.now() - startedAtRef.current) / 1000;
        setElapsed(Math.min(SOUND_POSTCARD_MAX_SECONDS, seconds));
        if (seconds >= SOUND_POSTCARD_MAX_SECONDS) stopRecording();
      }, 100);
    } catch (cause) {
      clearTimer();
      stopTracks();
      setRecording(false);
      setError(
        cause?.name === 'NotAllowedError'
          ? '未获得麦克风权限，也可以从手机中选择音频'
          : '无法启动录音，请稍后重试'
      );
    }
  };

  const handleUpload = async (event) => {
    const file = Array.from(event.target.files || [])[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    const accepted = await onFileSelected?.(file);
    if (accepted === false) setError('声音没有加入 Daily，请根据提示重新选择');
  };

  const progress = Math.min(100, (elapsed / SOUND_POSTCARD_MAX_SECONDS) * 100);

  return (
    <section className="editor-sound-importer" aria-label="添加声音明信片">
      <div className="editor-sound-heading">
        <span className="editor-sound-icon"><Waves size={18} /></span>
        <span>
          <strong>声音明信片</strong>
          <small>收下一段 10–30 秒的雨声、街道、海浪或当下声音</small>
        </span>
      </div>

      {recording ? (
        <div className="editor-sound-recording" aria-live="polite">
          <span className="editor-sound-recording-dot" aria-hidden="true" />
          <div>
            <strong>{formatSoundDuration(elapsed)}</strong>
            <small>{elapsed < SOUND_POSTCARD_MIN_SECONDS ? `再录 ${Math.ceil(SOUND_POSTCARD_MIN_SECONDS - elapsed)} 秒` : '可以收下这段声音了'}</small>
          </div>
          <button
            type="button"
            onClick={stopRecording}
            disabled={elapsed < SOUND_POSTCARD_MIN_SECONDS - 0.35}
          >
            <Square size={13} fill="currentColor" /> 收下
          </button>
          <span className="editor-sound-recording-progress" style={{ '--sound-progress': `${progress}%` }} />
        </div>
      ) : (
        <div className="editor-sound-actions">
          <button type="button" onClick={startRecording} disabled={disabled}>
            <Mic2 size={15} /> 直接录音
          </button>
          <label className={disabled ? 'is-disabled' : ''}>
            <input
              type="file"
              accept="audio/*,.m4a,.mp3,.ogg,.opus,.wav,.webm"
              hidden
              disabled={disabled}
              onChange={handleUpload}
            />
            <Upload size={15} /> 选择音频
          </label>
        </div>
      )}

      <p className={error ? 'is-error' : ''}>
        {error || '每条 Daily 只放一张声音明信片；建议使用 M4A 或 MP3。'}
      </p>
    </section>
  );
}
