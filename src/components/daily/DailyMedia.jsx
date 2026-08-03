import React, { useState } from 'react';
import { CalendarDays, Camera, MapPin, VolumeX } from 'lucide-react';
import LazyImage from '../ui/LazyImage';
import VideoLightbox from '../ui/VideoLightbox';
import TravelVideo from '../travel/TravelVideo';
import LivePhoto from './LivePhoto';
import { resolveMediaUrl } from '../../utils/media';
import {
  formatCamera,
  formatCapturedAt,
  formatPhotoLocation,
  normalizePhotoMetadata,
} from '../../utils/photoMetadata';

function PhotoMetadata({ metadata }) {
  const value = normalizePhotoMetadata(metadata);
  const rows = [
    value.showCapturedAt && value.capturedAt
      ? { icon: CalendarDays, label: formatCapturedAt(value.capturedAt) }
      : null,
    value.showLocation && Number.isFinite(value.latitude)
      ? { icon: MapPin, label: formatPhotoLocation(value) }
      : null,
    value.showCamera && (value.make || value.model)
      ? { icon: Camera, label: formatCamera(value) }
      : null,
  ].filter(Boolean);
  if (!rows.length) return null;

  return (
    <div className="daily-photo-metadata" aria-label="照片拍摄信息">
      {rows.map(({ icon: Icon, label }) => (
        <span key={label}><Icon size={13} />{label}</span>
      ))}
    </div>
  );
}

function DailyVideo({ url, title }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isExpanded) {
    return (
      <VideoLightbox
        src={url}
        title={title}
        onClose={() => setIsExpanded(false)}
      />
    );
  }

  return (
    <div className="daily-video-preview">
      <TravelVideo
        src={url}
        muted
        loop
        playsInline
        controls={false}
        playWhenVisible
        disableHover
        onClick={() => setIsExpanded(true)}
        title={title}
        className="daily-inline-video"
        style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', cursor: 'pointer' }}
      />
      <button
        type="button"
        className="daily-video-sound-hint"
        onClick={() => setIsExpanded(true)}
        aria-label="打开视频并播放声音"
        title="打开视频并播放声音"
      >
        <VolumeX size={16} />
      </button>
    </div>
  );
}

function renderMediaItem(item, index, title) {
  const key = item.url || item.value || `${item.type}-${index}`;
  const resolvedUrl = resolveMediaUrl(item.url || item.value);

  if (item.type === 'color') {
    return <div key={key} style={{ backgroundColor: item.value }} />;
  }

  if (item.type === 'video-placeholder') {
    return (
      <div
        key={key}
        className="daily-video-placeholder"
        style={{ backgroundColor: item.value }}
      >
        [ Video Player · 悬停播放 ]
      </div>
    );
  }

  if (item.type === 'image') {
    const image = (
      <LazyImage
        src={resolvedUrl}
        alt={title || 'Daily 图片'}
        className="daily-lazy-wrapper"
        imgClassName="daily-lazy-img"
        skeletonClassName="daily-lazy-skeleton"
        errorText="图片加载失败"
      />
    );
    const metadata = normalizePhotoMetadata(item.metadata);
    if (metadata.showCapturedAt || metadata.showLocation || metadata.showCamera) {
      return (
        <div key={key} className="daily-photo-with-metadata">
          {image}
          <PhotoMetadata metadata={metadata} />
        </div>
      );
    }
    return React.cloneElement(image, { key });
  }

  if (item.type === 'live-photo') {
    return (
      <LivePhoto
        key={key}
        imageSrc={resolvedUrl}
        motionSrc={resolveMediaUrl(item.motionUrl || item.motionValue)}
        metadata={item.metadata}
        title={title}
      />
    );
  }

  if (item.type === 'video') {
    return <DailyVideo key={key} url={resolvedUrl} title={title} />;
  }

  return null;
}

export default function DailyMedia({
  media,
  mediaGrid = 'media-single',
  title = 'Daily',
  variant = 'entry',
}) {
  if (!Array.isArray(media) || !media.length) return null;

  return (
    <div className={`entry-media ${mediaGrid || 'media-single'} daily-media-${variant}`}>
      {media.map((item, index) => renderMediaItem(item, index, title))}
    </div>
  );
}
