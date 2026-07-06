import { useCallback, useEffect, useState } from 'react';
import staticFallback from '../data/dailyData.json';
import * as diaryApi from '../api/diary';
import * as uploadApi from '../api/upload';

/** 把后端返回的一条 diary 归一化为前端使用的 post 结构 */
function normalizePost(item) {
  const tagsRaw = item.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter(Boolean)
    : typeof tagsRaw === 'string' && tagsRaw
    ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  return {
    ...item,
    media: typeof item.media === 'string' ? JSON.parse(item.media || '[]') : item.media || [],
    tags,
    id: `post-${item.id}`,
  };
}

export function useDiary(token) {
  const [posts, setPosts] = useState(staticFallback);
  const [activeDate, setActiveDate] = useState(null);

  useEffect(() => {
    let cancelled = false;
    diaryApi
      .fetchDiary()
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const mapped = data.map(normalizePost);
        setPosts(mapped);
        if (mapped.length > 0) setActiveDate(mapped[0].id);
      })
      .catch(() => {
        // 后端不可用，静默使用静态兜底数据
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

      if (!token) {
        // 本地演示模式
        if (editingId) {
          setPosts((prev) =>
            prev.map((p) =>
              p.id === editingId
                ? { ...p, text: payload.text, media: payload.media, mediaGrid: payload.mediaGrid, tags: payload.tags }
                : p
            )
          );
        } else {
          const localPost = {
            id: `post-local-${Math.random().toString(36).slice(2, 9)}`,
            date: new Date().toLocaleDateString('en-US', {
              month: 'short',
              day: '2-digit',
              year: 'numeric',
            }),
            ...payload,
          };
          setPosts((prev) => [localPost, ...prev]);
        }
        return;
      }

      const realId = editingId ? editingId.replace('post-', '') : null;
      const item = editingId
        ? await diaryApi.updateDiary(realId, payload, token)
        : await diaryApi.createDiary(payload, token);
      const newPost = normalizePost(item);

      setPosts((prev) => {
        if (editingId) return prev.map((p) => (p.id === editingId ? newPost : p));
        return [newPost, ...prev];
      });
    },
    [token]
  );

  const remove = useCallback(
    async (postId) => {
      const realId = postId.replace('post-', '');
      try {
        if (token) await diaryApi.deleteDiary(realId, token);
      } catch (err) {
        console.error('Delete diary failed:', err);
      }
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    },
    [token]
  );

  return { posts, setPosts, activeDate, setActiveDate, publish, remove };
}
