import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, Waves } from 'lucide-react';
import { formatSoundDuration } from '../../utils/soundPostcard';

const WAVE_BARS = [36, 62, 48, 76, 42, 84, 56, 68, 38, 72, 52, 80, 46, 64, 34, 58, 44, 70];
let activeAudio = null;

export default function SoundPostcard({ src, duration: initialDuration, title = '声音明信片', compact = false }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number(initialDuration) || 0);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => {
    if (activeAudio === audioRef.current) activeAudio = null;
    audioRef.current?.pause();
  }, []);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const nextTime = Number(event.target.value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <article className={`daily-sound-postcard ${playing ? 'is-playing' : ''} ${compact ? 'is-compact' : ''}`.trim()}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        playsInline
        onLoadedMetadata={(event) => {
          const nextDuration = Number(event.currentTarget.duration);
          if (Number.isFinite(nextDuration)) setDuration(nextDuration);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        onError={() => setFailed(true)}
      />

      <button
        type="button"
        className="daily-sound-play"
        onClick={togglePlayback}
        aria-label={playing ? '暂停声音明信片' : '播放声音明信片'}
        disabled={failed}
      >
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>

      <div className="daily-sound-body">
        <div className="daily-sound-label">
          <span><Waves size={14} />声音明信片</span>
          <small>{failed ? '声音加载失败' : title}</small>
        </div>
        <div className="daily-sound-wave" aria-hidden="true">
          {WAVE_BARS.map((height, index) => (
            <i key={`${height}-${index}`} style={{ '--wave-height': `${height}%`, '--wave-delay': `${index * -45}ms` }} />
          ))}
        </div>
        <label className="daily-sound-progress">
          <input
            type="range"
            aria-label="声音播放进度"
            min="0"
            max={duration || 0}
            step="0.05"
            value={Math.min(currentTime, duration || 0)}
            onChange={seek}
            disabled={failed || !duration}
          />
          <span>{formatSoundDuration(currentTime)} / {formatSoundDuration(duration)}</span>
        </label>
      </div>

      <Volume2 className="daily-sound-volume" size={15} aria-hidden="true" />
    </article>
  );
}
