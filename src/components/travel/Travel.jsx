import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Edit2, Play, Plus, Trash2 } from 'lucide-react';
import { fallbackVideos } from '../../data/fallbackPhotos';
import { resolveMediaUrl } from '../../utils/media';
import {
  getTravelItemId,
  getTravelPosterUrl,
  nextTravelIndex,
  normalizeTravelIndex,
} from '../../utils/travelCarousel';
import { useDialog } from '../../context/DialogContext';
import { LoadingSpinner, LoadingBlock } from '../ui/Loading';
import PreviewRail from '../ui/PreviewRail';
import SectionHeading from '../ui/SectionHeading';
import VideoLightbox from '../ui/VideoLightbox';
import TravelVideo from './TravelVideo';

const AUTO_ADVANCE_MS = 6500;
const MANUAL_PAUSE_MS = 8000;

function reduceMotionEnabled() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function TravelPreviewFrame({ video, index }) {
  const poster = getTravelPosterUrl(video);
  const [mediaState, setMediaState] = useState('loading');

  return (
    <span className={`travel-preview-frame is-${mediaState}`}>
      {poster ? (
        <img
          src={resolveMediaUrl(poster)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setMediaState('ready')}
          onError={() => setMediaState('error')}
        />
      ) : (
        <video
          src={resolveMediaUrl(video.url)}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            try {
              element.currentTime = Math.min(0.35, Math.max(0, element.duration / 8));
            } catch {
              setMediaState('ready');
            }
          }}
          onLoadedData={() => setMediaState('ready')}
          onSeeked={() => setMediaState('ready')}
          onError={() => setMediaState('error')}
        />
      )}
      <span className="travel-preview-fallback" aria-hidden="true">
        <span>{String(index + 1).padStart(2, '0')}</span>
      </span>
      <span className="travel-preview-play" aria-hidden="true"><Play size={10} fill="currentColor" /></span>
    </span>
  );
}

export default function Travel({
  isAdmin,
  videos,
  loading,
  uploading,
  onUpload,
  onUpdate,
  onDelete,
}) {
  const { confirm, prompt, toast } = useDialog();
  const [expandedVideo, setExpandedVideo] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(
    () => typeof IntersectionObserver !== 'function'
  );
  const [isHoverPaused, setIsHoverPaused] = useState(false);
  const sectionRef = useRef(null);
  const trackRef = useRef(null);
  const cardRefs = useRef([]);
  const scrollFrameRef = useRef(0);
  const manualPauseUntilRef = useRef(0);

  const isRealData = videos.length > 0;
  const list = useMemo(
    () => (isRealData ? videos : fallbackVideos).map((video, index) => ({
      ...video,
      _previewId: getTravelItemId(video, index),
    })),
    [isRealData, videos]
  );
  const currentIndex = normalizeTravelIndex(activeIndex, list.length);

  const scrollToIndex = useCallback((index, behavior = 'smooth') => {
    const card = cardRefs.current[index];
    const track = trackRef.current;
    if (!card || !track) return;

    const left = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
    track.scrollTo({
      left: Math.max(0, left),
      behavior: reduceMotionEnabled() ? 'auto' : behavior,
    });
  }, []);

  const selectIndex = useCallback((index, { manual = true, behavior = 'smooth' } = {}) => {
    const next = normalizeTravelIndex(index, list.length);
    if (manual) manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
    setActiveIndex(next);
    scrollToIndex(next, behavior);
  }, [list.length, scrollToIndex]);

  useEffect(() => {
    cardRefs.current = cardRefs.current.slice(0, list.length);
  }, [list.length]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver !== 'function') return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting && entry.intersectionRatio >= 0.12),
      { threshold: [0, 0.12, 0.35] }
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (
      list.length <= 1
      || !isVisible
      || isHoverPaused
      || expandedVideo
      || reduceMotionEnabled()
    ) return undefined;

    const timer = window.setInterval(() => {
      if (Date.now() < manualPauseUntilRef.current) return;
      setActiveIndex((current) => {
        const next = nextTravelIndex(current, list.length);
        scrollToIndex(next);
        return next;
      });
    }, AUTO_ADVANCE_MS);

    return () => window.clearInterval(timer);
  }, [expandedVideo, isHoverPaused, isVisible, list.length, scrollToIndex]);

  useEffect(() => () => {
    window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const handleTrackScroll = () => {
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const track = trackRef.current;
      if (!track) return;
      const center = track.scrollLeft + track.clientWidth / 2;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      cardRefs.current.forEach((card, index) => {
        if (!card) return;
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const distance = Math.abs(cardCenter - center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      setActiveIndex(closestIndex);
    });
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await onUpload(file);
      toast.success('视频上传成功');
    } catch {
      toast.error('视频上传失败，请稍后重试');
    }
  };

  const handleEditTitle = async (video) => {
    const newTitle = await prompt({
      title: '编辑视频名称',
      label: '标题',
      defaultValue: video.title,
      placeholder: '视频名称',
      confirmText: '保存',
    });
    if (newTitle === null) return;
    try {
      await onUpdate(video.id, { title: newTitle || video.title });
      toast.success('已更新');
    } catch {
      toast.error('更新失败');
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: '删除视频',
      message: '删除后不可恢复，确定要删除这个视频吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await onDelete(id);
      toast.success('已删除');
    } catch {
      toast.error('删除失败');
    }
  };

  return (
    <section id="travel" ref={sectionRef} className="travel-section">
      <SectionHeading
        title="Travel"
        description="路过的风景，和当时的呼吸。"
        action={isAdmin ? (
          <label className={`upload-btn ${uploading ? 'disabled' : ''}`}>
            {uploading ? <LoadingSpinner size={12} /> : <Plus size={14} />}
            <span>{uploading ? '上传中...' : '上传视频'}</span>
            <input
              type="file"
              accept="video/*"
              className="hidden-input"
              onChange={handleFile}
              disabled={uploading}
            />
          </label>
        ) : null}
      />

      {loading && !isRealData ? (
        <LoadingBlock label="正在加载视频..." />
      ) : (
        <div
          className="travel-carousel"
          onMouseEnter={() => setIsHoverPaused(true)}
          onMouseLeave={() => setIsHoverPaused(false)}
        >
          <div className="slider-wrapper travel-carousel-viewport">
            <div
              ref={trackRef}
              className="video-track travel-carousel-track"
              onScroll={handleTrackScroll}
              onPointerDown={() => {
                manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
              }}
              onWheel={() => {
                manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
              }}
            >
            {list.map((video, index) => (
              <div
                key={video._previewId}
                ref={(node) => { cardRefs.current[index] = node; }}
                className={`video-card ${index === currentIndex ? 'is-active' : ''}`.trim()}
                aria-current={index === currentIndex ? 'true' : undefined}
              >
                <TravelVideo
                  src={resolveMediaUrl(video.url)}
                  poster={getTravelPosterUrl(video) ? resolveMediaUrl(getTravelPosterUrl(video)) : undefined}
                  muted
                  loop
                  playsInline
                  controls={false}
                  playWhenVisible={index === currentIndex}
                  disableHover={index !== currentIndex}
                  onClick={() => {
                    selectIndex(index);
                    setExpandedVideo(video);
                  }}
                  title={video.title}
                  className="travel-video"
                />
                {isAdmin && isRealData ? (
                  <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="action-btn"
                      onClick={() => handleEditTitle(video)}
                      title={video.title || '编辑视频'}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      className="action-btn delete"
                      onClick={() => handleDelete(video.id)}
                      title="删除视频"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            </div>
          </div>

          <div className="travel-preview-controls" data-pet-avoid>
            <button
              type="button"
              className="travel-preview-arrow"
              onClick={() => selectIndex(nextTravelIndex(currentIndex, list.length, -1))}
              aria-label="上一个旅行片段"
              disabled={list.length <= 1}
            >
              <ChevronLeft size={16} />
            </button>
            <PreviewRail
              items={list.map((video, index) => ({ ...video, id: video._previewId, _index: index }))}
              activeId={list[currentIndex]?._previewId}
              onSelect={(video) => selectIndex(video._index)}
              renderPreview={(video) => (
                <TravelPreviewFrame video={video} index={video._index} />
              )}
              getLabel={(video) => `查看旅行片段 ${video._index + 1}${video.title ? `：${video.title}` : ''}`}
              ariaLabel="旅行视频预览"
              className="travel-preview-rail"
            />
            <button
              type="button"
              className="travel-preview-arrow"
              onClick={() => selectIndex(nextTravelIndex(currentIndex, list.length))}
              aria-label="下一个旅行片段"
              disabled={list.length <= 1}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <span className="preview-rail-status" aria-live="polite">
            当前为第 {currentIndex + 1} 个旅行片段，共 {list.length} 个
          </span>
        </div>
      )}

      {expandedVideo && (
        <VideoLightbox
          src={resolveMediaUrl(expandedVideo.url)}
          title={expandedVideo.title}
          onClose={() => setExpandedVideo(null)}
        />
      )}
    </section>
  );
}
