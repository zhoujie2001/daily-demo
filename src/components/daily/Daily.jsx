import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tag as TagIcon } from 'lucide-react';
import Timeline from './Timeline';
import CalendarWidget from './CalendarWidget';
import DailyEntry from './DailyEntry';
import DailyEditor from './DailyEditor';
import SearchBar from './SearchBar';
import { TimeArrival, TimeTravelOverlay } from './TimeMachine';
import MemoryActions from './MemoryActions';
import { useDialog } from '../../context/DialogContext';
import { compressVideo, VIDEO_COMPRESSION_THRESHOLD } from '../../utils/compressVideo';
import { compressImage } from '../../utils/compressImage';
import {
  applyDefaultPhotoMetadataVisibility,
  extractPhotoMetadata,
  normalizePhotoMetadata,
} from '../../utils/photoMetadata';
import { isLivePhotoMotion, pairLivePhotoFiles } from '../../utils/livePhotoImport';
import {
  chooseTimeMachinePost,
  createTravelSequence,
  findPostByTimeKey,
  formatTimeMachineDate,
  getDaysFromToday,
  toDateKey,
} from '../../utils/timeMachine';
import EmptyState from '../ui/EmptyState';
import SectionHeading from '../ui/SectionHeading';
import { SkeletonCard, SkeletonText } from '../Skeleton';

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function matchesKeyword(post, keyword) {
  const query = keyword.trim().toLowerCase();
  if (!query) return true;

  const title = (post.title || '').toLowerCase();
  const text = (post.text || '').toLowerCase();
  return title.includes(query) || text.includes(query);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

let attachmentSequence = 0;

function createAttachmentId(type, file) {
  attachmentSequence += 1;
  return `${type}-${Date.now()}-${attachmentSequence}-${file?.name || 'media'}`;
}

async function createPhotoAttachment(file, type = 'image') {
  const [preparedFile, extractedMetadata] = await Promise.all([
    compressImage(file),
    extractPhotoMetadata(file).catch(() => ({})),
  ]);
  const previewUrl = await readFileAsDataUrl(preparedFile);

  return {
    id: createAttachmentId(type, file),
    file: preparedFile,
    originalFile: file,
    type,
    url: previewUrl,
    value: previewUrl,
    metadata: applyDefaultPhotoMetadataVisibility(extractedMetadata),
    compressionStatus: 'ready',
    originalSize: file.size,
    compressedSize: preparedFile.size,
  };
}

function mediaToAttachment(media) {
  return {
    id: `existing-${media.type}-${media.url || media.value || Math.random().toString(36).slice(2)}`,
    type: media.type,
    url: media.url,
    value: media.value || media.url,
    motionUrl: media.motionUrl || media.motionValue || '',
    motionValue: media.motionValue || media.motionUrl || '',
    metadata: normalizePhotoMetadata(media.metadata),
    compressionStatus: 'ready',
    isExisting: true,
  };
}

const TIME_TRAVEL_MESSAGES = [
  '正在翻阅旧日记…',
  '时间正在倒退…',
  '正在寻找被遗忘的一天…',
  '回到某个平凡但特别的日子…',
];
let arrivalSequence = 0;

function createArrival(post, source = 'random', strategy = 'surprise') {
  arrivalSequence += 1;
  return {
    journeyId: `${toDateKey(post.date) || post.id}-${arrivalSequence}`,
    post,
    source,
    strategy,
    formattedDate: formatTimeMachineDate(post.date),
    daysAgo: getDaysFromToday(post.date),
  };
}

function createShareUrl(post) {
  const url = new URL(window.location.href);
  url.searchParams.set('time', toDateKey(post.date) || post.id);
  url.searchParams.set('from', 'time-machine');
  url.hash = 'daily';
  return url;
}

function clearTimeMachineUrl({ replace = true } = {}) {
  const url = new URL(window.location.href);
  const hadTimeParams = url.searchParams.has('time') || url.searchParams.has('from');
  if (!hadTimeParams) return;

  url.searchParams.delete('time');
  url.searchParams.delete('from');
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', url);
}

function scrollToPost(postId, reducedMotion) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(postId)?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  });
}

function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const copied = document.execCommand('copy');
    return copied ? Promise.resolve() : Promise.reject(new Error('浏览器不支持复制链接'));
  } finally {
    textarea.remove();
  }
}

export default function Daily({ isAdmin, posts, loading = false, activeDate, onActiveDateChange, onPublish, onDelete }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [tags, setTags] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [compressingCount, setCompressingCount] = useState(0);
  const [activeTag, setActiveTag] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [isTraveling, setIsTraveling] = useState(false);
  const [travelDate, setTravelDate] = useState('');
  const [travelMessage, setTravelMessage] = useState(TIME_TRAVEL_MESSAGES[0]);
  const [arrival, setArrival] = useState(null);
  const lastSyncKeyRef = useRef('');
  const travelTimersRef = useRef([]);
  const reducedMotionRef = useRef(false);
  const handledInitialTimeLinkRef = useRef(false);
  const { confirm, toast } = useDialog();

  const today = todayLabel();
  const todayPost = useMemo(() => (posts || []).find((p) => p.date === today) || null, [posts, today]);

  const allTags = useMemo(() => {
    const s = new Set();
    (posts || []).forEach((p) => (p.tags || []).forEach((t) => t && s.add(t)));
    return Array.from(s);
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const tagFiltered = !activeTag ? posts || [] : (posts || []).filter((p) => (p.tags || []).includes(activeTag));
    return tagFiltered.filter((post) => matchesKeyword(post, keyword));
  }, [posts, activeTag, keyword]);

  const currentPost = useMemo(() => {
    if (!filteredPosts || filteredPosts.length === 0) return null;
    return filteredPosts.find((p) => p.id === activeDate) || filteredPosts[0];
  }, [filteredPosts, activeDate]);
  const isArrivalCurrent = Boolean(
    arrival?.post && currentPost && toDateKey(arrival.post.date) === toDateKey(currentPost.date)
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      reducedMotionRef.current = mediaQuery.matches;
    };
    updatePreference();
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', updatePreference);
    else mediaQuery.addListener?.(updatePreference);
    return () => {
      if (mediaQuery.removeEventListener) mediaQuery.removeEventListener('change', updatePreference);
      else mediaQuery.removeListener?.(updatePreference);
    };
  }, []);

  useEffect(
    () => () => {
      travelTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      travelTimersRef.current = [];
    },
    []
  );

  useEffect(() => {
    if (loading || handledInitialTimeLinkRef.current || !posts?.length) return;
    handledInitialTimeLinkRef.current = true;

    const key = new URL(window.location.href).searchParams.get('time');
    const linkedPost = findPostByTimeKey(posts, key);
    if (!linkedPost) {
      if (key) clearTimeMachineUrl();
      return;
    }

    setActiveTag(null);
    setKeyword('');
    onActiveDateChange(linkedPost.id);
    setArrival(createArrival(linkedPost, 'link'));
    scrollToPost(linkedPost.id, reducedMotionRef.current);
  }, [loading, onActiveDateChange, posts]);

  useEffect(() => {
    const handlePopState = () => {
      const key = new URL(window.location.href).searchParams.get('time');
      const linkedPost = findPostByTimeKey(posts, key);
      if (!linkedPost) {
        setArrival(null);
        if (key) clearTimeMachineUrl();
        return;
      }

      setActiveTag(null);
      setKeyword('');
      onActiveDateChange(linkedPost.id);
      setArrival(createArrival(linkedPost, 'link'));
      scrollToPost(linkedPost.id, reducedMotionRef.current);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onActiveDateChange, posts]);

  const emptyStateCopy = useMemo(() => {
    if (keyword.trim()) {
      return {
        title: '没有找到相关日记',
        description: activeTag ? `试试清空搜索词，或切换到其他标签“${activeTag}”` : '换个关键词试试看，也许会翻到那篇日记。',
      };
    }
    if (activeTag) {
      return {
        title: `没有带 “${activeTag}” 标签的 Daily`,
        description: '换个标签或点“全部”看看',
      };
    }
    return {
      title: '暂无 Daily',
      description: '等博主慢慢补上吧～',
    };
  }, [activeTag, keyword]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    const editorSource = editingId ? posts.find((p) => p.id === editingId) || null : todayPost;
    const syncKey = `${isAdmin}-${editorSource?.id || 'new'}-${today}`;

    if (syncKey === lastSyncKeyRef.current) {
      return;
    }

    lastSyncKeyRef.current = syncKey;
    queueMicrotask(() => {
      if (editorSource) {
        setEditingId(editorSource.id);
        setText(editorSource.text || '');
        setTags(editorSource.tags || []);
        setAttachments(
          (editorSource.media || []).map(mediaToAttachment)
        );
        return;
      }

      setEditingId(null);
      setText('');
      setTags([]);
      setAttachments([]);
    });
  }, [isAdmin, editingId, posts, today, todayPost]);

  const leaveTimeMachine = () => {
    setArrival(null);
    clearTimeMachineUrl();
  };

  const handleSelectDate = (id) => {
    leaveTimeMachine();
    onActiveDateChange(id);
  };

  const handleKeywordChange = (value) => {
    if (arrival) leaveTimeMachine();
    setKeyword(value);
  };

  const handleTagChange = (nextTag) => {
    if (arrival) leaveTimeMachine();
    setActiveTag(nextTag);
    setKeyword('');
  };

  const startTimeTravel = (strategy = 'surprise') => {
    if (isTraveling || !posts?.length) return;

    const destination = chooseTimeMachinePost(posts, {
      strategy,
      currentId: currentPost?.id || activeDate,
    });
    if (!destination) {
      toast.info('还没有可以穿越的 Daily');
      return;
    }

    travelTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    travelTimersRef.current = [];
    setActiveTag(null);
    setKeyword('');
    setArrival(null);

    const finishTravel = () => {
      onActiveDateChange(destination.id);
      setTravelDate(destination.date);
      setArrival(createArrival(destination, 'random', strategy));
      setIsTraveling(false);
      window.history.pushState({ timeMachine: true }, '', createShareUrl(destination));
      scrollToPost(destination.id, reducedMotionRef.current);
      travelTimersRef.current = [];
    };

    if (reducedMotionRef.current) {
      finishTravel();
      return;
    }

    const sequence = createTravelSequence(posts, destination, { length: 9 });
    setIsTraveling(true);
    setTravelDate(sequence[0]?.date || destination.date);
    setTravelMessage(TIME_TRAVEL_MESSAGES[0]);

    sequence.forEach((post, index) => {
      const timer = window.setTimeout(() => {
        setTravelDate(post.date);
        setTravelMessage(TIME_TRAVEL_MESSAGES[index % TIME_TRAVEL_MESSAGES.length]);
      }, index * 85);
      travelTimersRef.current.push(timer);
    });

    const finishTimer = window.setTimeout(finishTravel, sequence.length * 85 + 120);
    travelTimersRef.current.push(finishTimer);
  };

  const handleReturnToday = () => {
    const destination = todayPost || posts?.[0];
    setArrival(null);
    setActiveTag(null);
    setKeyword('');
    clearTimeMachineUrl({ replace: false });
    if (destination) {
      onActiveDateChange(destination.id);
      scrollToPost(destination.id, reducedMotionRef.current);
    }
  };

  const handleShareTime = async () => {
    if (!arrival?.post) return;
    const shareUrl = createShareUrl(arrival.post).toString();
    try {
      await copyToClipboard(shareUrl);
      toast.success('时光链接已复制');
    } catch (error) {
      toast.error(error.message || '复制失败，请重试');
    }
  };

  const handleFileSelect = async (e, type) => {
    const selectedFiles = Array.from(e.target.files || []);
    const files = type === 'live-photo' ? selectedFiles.slice(0, 1) : selectedFiles;
    e.target.value = '';
    if (files.length === 0) {
      return;
    }

    try {
      if (type === 'image' || type === 'live-photo') {
        const newAttachments = await Promise.all(files.map((file) => createPhotoAttachment(file, type)));
        setAttachments((prev) => [...prev, ...newAttachments]);
        return;
      }

      const [previewUrls, metadataList] = await Promise.all([
        Promise.all(files.map((file) => readFileAsDataUrl(file))),
        Promise.all(files.map(() => Promise.resolve({}))),
      ]);
      const newAtt = files.map((file, index) => {
        const previewUrl = previewUrls[index];
        const id = createAttachmentId(type, file);
        return {
          id,
          file,
          originalFile: file,
          type,
          url: previewUrl,
          value: previewUrl,
          metadata: normalizePhotoMetadata(metadataList[index]),
          compressionStatus: type === 'video' && file.size >= VIDEO_COMPRESSION_THRESHOLD ? 'queued' : 'ready',
          originalSize: file.size,
          compressedSize: type === 'video' && file.size < VIDEO_COMPRESSION_THRESHOLD ? file.size : null,
        };
      });
      setAttachments((prev) => [...prev, ...newAtt]);

      if (type !== 'video') {
        return;
      }

      await Promise.all(
        newAtt.map(async (attachment) => {
          if (attachment.compressionStatus !== 'queued') return;
          setCompressingCount((count) => count + 1);
          setAttachments((prev) =>
            prev.map((att) =>
              att.id === attachment.id
                ? { ...att, compressing: true, compressionStatus: 'queued', compressionProgress: 0, compressionError: null }
                : att
            )
          );

          try {
            const compressedFile = await compressVideo(attachment.originalFile || attachment.file, (percent) => {
              setAttachments((prev) =>
                prev.map((att) =>
                  att.id === attachment.id
                    ? { ...att, compressionStatus: 'compressing', compressionProgress: Math.round(percent) }
                    : att
                )
              );
            });
            setAttachments((prev) =>
              prev.map((att) =>
                att.id === attachment.id
                  ? {
                      ...att,
                      file: compressedFile,
                      compressing: false,
                      compressionStatus: 'ready',
                      compressionProgress: 100,
                      compressedSize: compressedFile.size,
                      compressionError: null,
                    }
                  : att
              )
            );
          } catch (err) {
            toast.error(`${attachment.file.name} 压缩失败：${err.message || '未知错误'}`);
            setAttachments((prev) =>
              prev.map((att) =>
                att.id === attachment.id
                  ? {
                      ...att,
                      compressing: false,
                      compressionStatus: 'error',
                      compressionProgress: null,
                      compressionError: err.message || '视频压缩失败',
                    }
                  : att
              )
            );
          } finally {
            setCompressingCount((count) => Math.max(0, count - 1));
          }
        })
      );
    } catch (err) {
      toast.error(err.message || '文件读取失败');
    }
  };

  const attachLiveMotionFile = async (motionFile, attachmentId) => {
    if (!motionFile || !attachmentId) return false;
    if (!isLivePhotoMotion(motionFile)) {
      toast.error('实况照片的动态片段需要选择视频文件');
      return false;
    }

    try {
      const motionUrl = await readFileAsDataUrl(motionFile);
      const needsCompatibilityTranscode = /\.mov$/i.test(motionFile.name || '') || /quicktime/i.test(motionFile.type || '');
      const shouldCompress = motionFile.size >= VIDEO_COMPRESSION_THRESHOLD || needsCompatibilityTranscode;
      setAttachments((prev) => prev.map((att) => (
        att.id === attachmentId && att.type === 'live-photo'
          ? {
              ...att,
              motionFile,
              motionOriginalFile: motionFile,
              motionUrl,
              motionValue: motionUrl,
              forceVideoCompression: needsCompatibilityTranscode,
              compressionStatus: shouldCompress ? 'queued' : 'ready',
              originalSize: motionFile.size,
              compressedSize: shouldCompress ? null : motionFile.size,
              compressionError: null,
            }
          : att
      )));

      if (!shouldCompress) return true;
      setCompressingCount((count) => count + 1);
      setAttachments((prev) => prev.map((att) => (
        att.id === attachmentId
          ? { ...att, compressing: true, compressionStatus: 'queued', compressionProgress: 0 }
          : att
      )));

      try {
        const compressedFile = await compressVideo(motionFile, (percent) => {
          setAttachments((prev) => prev.map((att) => (
            att.id === attachmentId
              ? { ...att, compressionStatus: 'compressing', compressionProgress: Math.round(percent) }
              : att
          )));
        }, { force: needsCompatibilityTranscode });
        setAttachments((prev) => prev.map((att) => (
          att.id === attachmentId
            ? {
                ...att,
                motionFile: compressedFile,
                compressing: false,
                compressionStatus: 'ready',
                compressionProgress: 100,
                compressedSize: compressedFile.size,
                compressionError: null,
              }
            : att
        )));
      } catch (error) {
        setAttachments((prev) => prev.map((att) => (
          att.id === attachmentId
            ? {
                ...att,
                compressing: false,
                compressionStatus: 'error',
                compressionProgress: null,
                compressionError: error.message || '动态片段压缩失败',
              }
            : att
        )));
        toast.error(`${motionFile.name} 压缩失败：${error.message || '未知错误'}`);
      } finally {
        setCompressingCount((count) => Math.max(0, count - 1));
      }
      return true;
    } catch (error) {
      toast.error(error.message || '动态片段读取失败');
      return false;
    }
  };

  const handleLiveMotionSelect = async (event, attachmentIndex) => {
    const motionFile = Array.from(event.target.files || [])[0];
    event.target.value = '';
    const attachment = attachments[attachmentIndex];
    if (!motionFile || !attachment || attachment.type !== 'live-photo') return;
    await attachLiveMotionFile(motionFile, attachment.id);
  };

  const handleLivePhotoBundleSelect = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    const { pairs, unpairedImages, unpairedMotions, unsupported } = pairLivePhotoFiles(files);
    if (pairs.length === 0 && unpairedImages.length === 0) {
      toast.error('没有找到可作为实况封面的照片，请同时选择照片与对应视频');
      return;
    }

    try {
      const imports = [
        ...pairs.map(({ image, motion }) => ({ image, motion })),
        ...unpairedImages.map((image) => ({ image, motion: null })),
      ];
      const newAttachments = await Promise.all(
        imports.map(({ image }) => createPhotoAttachment(image, 'live-photo'))
      );
      setAttachments((prev) => [...prev, ...newAttachments]);

      await Promise.all(
        imports.map(({ motion }, index) => (
          motion ? attachLiveMotionFile(motion, newAttachments[index].id) : Promise.resolve(false)
        ))
      );

      const missingCount = unpairedImages.length;
      if (missingCount > 0) {
        toast.error(`${missingCount} 张照片没有匹配到动态片段，请在预览卡中补选视频`);
      } else {
        toast.success(`已自动配对 ${pairs.length} 组实况照片`);
      }
      if (unpairedMotions.length > 0 || unsupported.length > 0) {
        toast.error('部分文件无法配对，已跳过没有对应照片的视频或不支持的文件');
      }
    } catch (error) {
      toast.error(error.message || '实况照片导入失败');
    }
  };

  const handleAttachmentMetadataChange = (attachmentIndex, key, checked) => {
    setAttachments((prev) => prev.map((att, index) => {
      if (index !== attachmentIndex || (att.type !== 'image' && att.type !== 'live-photo')) return att;
      return {
        ...att,
        metadata: normalizePhotoMetadata({ ...att.metadata, [key]: checked }),
      };
    }));
  };

  const retryCompression = async (attachmentId) => {
    const attachment = attachments.find((att) => att.id === attachmentId);
    const isLivePhoto = attachment?.type === 'live-photo';
    if (!attachment || (attachment.type !== 'video' && !isLivePhoto) || attachment.compressionStatus !== 'error') return;
    const sourceFile = isLivePhoto
      ? attachment.motionOriginalFile || attachment.motionFile
      : attachment.originalFile || attachment.file;
    if (!sourceFile) return;

    setCompressingCount((count) => count + 1);
    setAttachments((prev) =>
      prev.map((att) =>
        att.id === attachmentId
          ? { ...att, compressing: true, compressionStatus: 'queued', compressionProgress: 0, compressionError: null }
          : att
      )
    );

    try {
      const compressedFile = await compressVideo(sourceFile, (percent) => {
        setAttachments((prev) =>
          prev.map((att) =>
            att.id === attachmentId
              ? { ...att, compressionStatus: 'compressing', compressionProgress: Math.round(percent) }
              : att
          )
        );
      }, { force: Boolean(attachment.forceVideoCompression) });
      setAttachments((prev) =>
        prev.map((att) =>
          att.id === attachmentId
              ? {
                ...att,
                ...(isLivePhoto ? { motionFile: compressedFile } : { file: compressedFile }),
                compressing: false,
                compressionStatus: 'ready',
                compressionProgress: 100,
                compressedSize: compressedFile.size,
              }
            : att
        )
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((att) =>
          att.id === attachmentId
            ? { ...att, compressing: false, compressionStatus: 'error', compressionError: err.message || '视频压缩失败' }
            : att
        )
      );
      toast.error(`${sourceFile.name} 压缩仍然失败：${err.message || '未知错误'}`);
    } finally {
      setCompressingCount((count) => Math.max(0, count - 1));
    }
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const resetEditorToToday = () => {
    lastSyncKeyRef.current = '';
    setEditingId(null);
  };

  const startEdit = (post) => {
    lastSyncKeyRef.current = '';
    setEditingId(post.id);
    setText(post.text || '');
    setTags(post.tags || []);
    setAttachments(
      (post.media || []).map(mediaToAttachment)
    );
  };

  const handlePublish = async () => {
    if (publishing || compressingCount > 0) return;
    if (attachments.some((att) => att.type === 'live-photo' && !att.motionFile && !att.motionUrl)) {
      toast.error('请先为实况照片选择动态片段');
      return;
    }
    if (attachments.some((att) => att.compressionStatus === 'error')) {
      toast.error('请先重试或移除压缩失败的视频');
      return;
    }
    setPublishing(true);
    try {
      const editingPost = editingId ? posts.find((p) => p.id === editingId) : null;
      const editingDate = editingPost?.date || '';
      await onPublish({ text, attachments, editingId, tags });
      toast.success(editingId ? `已更新 ${editingDate} 的 Daily` : '已发布');
      resetEditorToToday();
    } catch (err) {
      toast.error(err.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async (post) => {
    const ok = await confirm({
      title: '删除 Daily',
      message: `确定删除 ${post.date} 这条 Daily？`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await onDelete(post.id);
      toast.success('已删除');
      resetEditorToToday();
    } catch (err) {
      toast.error(err.message || '删除失败');
    }
  };

  return (
    <section id="daily" className="daily-section">
      <SectionHeading
        title="Daily"
        description="把普通日子收进时间里。"
        action={(
          <MemoryActions
            disabled={loading || !posts?.length}
            isTraveling={isTraveling}
            onTimeTravel={startTimeTravel}
            posts={posts}
            currentPostId={currentPost?.id || activeDate}
          />
        )}
      />

      <div className="daily-toolbar">
        <div className="daily-toolbar-row">
          <SearchBar value={keyword} onChange={handleKeywordChange} onClear={() => handleKeywordChange('')} />
        </div>
        {allTags.length > 0 ? (
          <div className="daily-tag-filter">
            <TagIcon size={12} className="daily-tag-filter-icon" />
            <button type="button" className={`tag-chip ${!activeTag ? 'active' : ''}`} onClick={() => handleTagChange(null)}>
              全部
            </button>
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`tag-chip ${activeTag === t ? 'active' : ''}`}
                onClick={() => handleTagChange(activeTag === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="layout-grid">
        {loading ? (
          <div className="col-content daily-skeleton-list" aria-label="日记加载中">
            {[0, 1, 2].map((item) => (
              <div key={item} className="daily-skeleton-item">
                <SkeletonCard height={150} />
                <div className="daily-skeleton-text-group">
                  <SkeletonText width="100%" />
                  <SkeletonText width="70%" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <Timeline posts={filteredPosts} activeDate={currentPost?.id} onSelect={handleSelectDate} />
            <div className="col-content" aria-label="日记内容">
              {currentPost ? (
                <div className="daily-entry-stack">
                  {isArrivalCurrent ? (
                    <TimeArrival
                      key={arrival.journeyId}
                      arrival={arrival}
                      onTravelAgain={() => startTimeTravel('surprise')}
                      onReturnToday={handleReturnToday}
                      onShare={handleShareTime}
                    />
                  ) : null}
                  <DailyEntry
                    key={currentPost.id}
                    post={currentPost}
                    isAdmin={isAdmin}
                    onEdit={startEdit}
                    onDelete={handleDelete}
                    keyword={keyword}
                    timeMachineActive={isArrivalCurrent}
                  />
                </div>
              ) : (
                <EmptyState title={emptyStateCopy.title} description={emptyStateCopy.description} />
              )}
            </div>
            <CalendarWidget posts={filteredPosts} onSelect={handleSelectDate} />
          </>
        )}
        {isAdmin ? (
          <DailyEditor
            editingId={editingId || todayPost?.id || null}
            text={text}
            attachments={attachments}
            tags={tags}
            publishing={publishing || compressingCount > 0}
            hasAttachmentErrors={attachments.some(
              (att) => att.compressionStatus === 'error' || (att.type === 'live-photo' && !att.motionFile && !att.motionUrl)
            )}
            onTextChange={setText}
            onTagsChange={setTags}
            onFilesSelected={handleFileSelect}
            onLivePhotoFilesSelected={handleLivePhotoBundleSelect}
            onLiveMotionSelected={handleLiveMotionSelect}
            onAttachmentMetadataChange={handleAttachmentMetadataChange}
            onRemoveAttachment={removeAttachment}
            onRetryCompression={retryCompression}
            onPublish={handlePublish}
            onCancelEdit={resetEditorToToday}
          />
        ) : null}
      </div>
      {isTraveling ? <TimeTravelOverlay date={travelDate} message={travelMessage} /> : null}
    </section>
  );
}
