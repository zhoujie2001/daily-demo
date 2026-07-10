import { useCallback, useEffect, useState } from 'react';
import staticFallback from '../data/dailyData.json';
import * as diaryApi from '../api/diary';
import * as uploadApi from '../api/upload';

/** 把后端返回的一条 diary 归一化为前端使用的 post 结构 */
function safeParseMedia(media) {
  if (Array.isArray(media)) return media;
  if (typeof media !== 'string' || !media.trim()) return [];
  try {
    const parsed = JSON.parse(media);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse diary media:', err, media);
    return [];
  }
}

function normalizePost(item) {
  const tagsRaw = item.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter(Boolean)
    : typeof tagsRaw === 'string' && tagsRaw
    ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  return {
    ...item,
    text: typeof item.text === 'string' ? item.text : item.text === null || item.text === undefined ? '' : String(item.text),
    media: safeParseMedia(item.media),
    tags,
    id: `post-${item.id}`,
  };
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function hasMeaningfulText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickPreferredText(existingText, nextText) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const incoming = typeof nextText === 'string' ? nextText : '';
  const existingMeaningful = hasMeaningfulText(existing);
  const incomingMeaningful = hasMeaningfulText(incoming);

  if (existingMeaningful && incomingMeaningful) {
    return incoming.trim().length > existing.trim().length ? incoming : existing;
  }
  if (existingMeaningful) return existing;
  if (incomingMeaningful) return incoming;
  return existing || incoming;
}

function pickPreferredMedia(existingMedia, nextMedia) {
  const existing = Array.isArray(existingMedia) ? existingMedia : [];
  const incoming = Array.isArray(nextMedia) ? nextMedia : [];
  if (existing.length > 0 && incoming.length > 0) {
    return incoming.length > existing.length ? incoming : existing;
  }
  return existing.length > 0 ? existing : incoming;
}

function dedupePostsByDate(list) {
  const map = new Map();
  (list || []).forEach((post) => {
    const key = (post.date || post.id || '').trim();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, post);
      return;
    }
    const mergedMedia = pickPreferredMedia(existing.media, post.media);
    const merged = {
      ...existing,
      ...post,
      text: pickPreferredText(existing.text, post.text),
      media: mergedMedia,
      mediaGrid: mergedMedia === existing.media ? existing.mediaGrid : (post.mediaGrid || existing.mediaGrid || ''),
      tags: Array.from(new Set([...(existing.tags || []), ...(post.tags || [])])),
    };
    map.set(key, merged);
  });
  return Array.from(map.values()).sort((a, b) => {
    const da = new Date(a.date);
    const db = new Date(b.date);
    return db - da;
  });
}

export function useDiary(token) {
  const [posts, setPosts] = useState(staticFallback);
  const [loading, setLoading] = useState(true);
  const [activeDate, setActiveDate] = useState(null);

  useEffect(() => {
    let cancelled = false;
    diaryApi
      .fetchDiary()
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const mapped = dedupePostsByDate(data.map(normalizePost));
        setPosts(mapped);
        if (mapped.length > 0) setActiveDate(mapped[0].id);
      })
      .catch((err) => {
        console.error('Diary API failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const publish = useCallback(
    async ({ text, attachments, editingId, tags = [] }) => {
      const finalMedia = [];

      if (attachments.length > 0 && token) {
        const filesToUpload = attachments.filter((a) => a.file).map((a) => a.file);
        let uploadedUrls = [];
        if (filesToUpload.length > 0) {
          try {
            uploadedUrls = await uploadApi.uploadFiles(filesToUpload, token);
          } catch (err) {
            console.warn('Upload failed, falling back to local URLs.', err);
          }
        }

        let uploadIdx = 0;
        attachments.forEach((att) => {
          if (att.isExisting) {
            finalMedia.push({ type: att.type, url: att.url, value: att.value || att.url });
          } else if (att.file && uploadedUrls[uploadIdx]) {
            const url = uploadedUrls[uploadIdx];
            uploadIdx += 1;
            finalMedia.push({ type: att.type, url, value: url });
          } else {
            finalMedia.push({ type: att.type, url: att.url, value: att.value || att.url });
          }
        });
      } else {
        attachments.forEach((att) => {
          finalMedia.push({ type: att.type, url: att.url, value: att.value || att.url });
        });
      }

      const payload = {
        text: text.trim(),
        media: finalMedia,
        tags: Array.isArray(tags) ? tags : [],
        mediaGrid:
          attachments.length === 1
            ? 'media-single'
            : attachments.length === 2
            ? 'media-grid-2'
            : attachments.length >= 3
            ? 'media-grid-3'
            : '',
      };

      const today = todayLabel();

      if (!token) {
        // 本地演示模式：同一天只保留一条，若今天已存在则转为更新
        const targetId = editingId || posts.find((p) => p.date === today)?.id;
        if (targetId) {
          setPosts((prev) =>
            dedupePostsByDate(
              prev.map((p) =>
                p.id === targetId
                  ? { ...p, text: payload.text, media: payload.media, mediaGrid: payload.mediaGrid, tags: payload.tags }
                  : p
              )
            )
          );
        } else {
          const localPost = {
            id: `post-local-${Math.random().toString(36).slice(2, 9)}`,
            date: today,
            ...payload,
          };
          setPosts((prev) => dedupePostsByDate([localPost, ...prev]));
        }
        return;
      }

      const fallbackTodayPost = posts.find((p) => p.date === today);
      const realId = (editingId || fallbackTodayPost?.id || '').replace('post-', '');
      const item = realId
        ? await diaryApi.updateDiary(realId, payload, token)
        : await diaryApi.createDiary(payload, token);
      const newPost = normalizePost(item);

      setPosts((prev) => {
        if (realId) {
          return dedupePostsByDate(prev.map((p) => ((p.id === `post-${realId}` || p.date === newPost.date) ? newPost : p)));
        }
        return dedupePostsByDate([newPost, ...prev]);
      });
      setActiveDate(newPost.id);
    },
    [token, posts]
  );

  const remove = useCallback(
    async (postId) => {
      const realId = postId.replace('post-', '');
      if (token) {
        try {
          await diaryApi.deleteDiary(realId, token);
        } catch (err) {
          console.error('Delete diary failed:', err);
          throw new Error('删除失败，请重试');
        }
      }

      setPosts((prev) => prev.filter((p) => p.id !== postId));
    },
    [token]
  );

  return { posts, setPosts, loading, activeDate, setActiveDate, publish, remove };
}
