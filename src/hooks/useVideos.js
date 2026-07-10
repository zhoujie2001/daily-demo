import { useCallback, useEffect, useState } from 'react';
import * as videosApi from '../api/videos';
import * as uploadApi from '../api/upload';

export function useVideos(token) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    videosApi
      .fetchVideos()
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) setVideos(data);
      })
      .catch((err) => console.error('Error fetching videos', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(
    async (file) => {
      if (!file || !token) throw new Error('no file or token');
      setUploading(true);
      try {
        const [url] = await uploadApi.uploadFiles(file, token);
        const created = await videosApi.createVideo(
          { title: file.name.split('.')[0] || 'New Video', url },
          token
        );
        setVideos((prev) => [created, ...prev]);
        return created;
      } finally {
        setUploading(false);
      }
    },
    [token]
  );

  const update = useCallback(
    async (id, patch) => {
      if (!token) throw new Error('not authenticated');
      const current = videos.find((v) => v.id === id);
      if (!current) throw new Error('video not found');
      await videosApi.updateVideo(
        id,
        { title: patch.title ?? current.title, url: current.url },
        token
      );
      setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    },
    [videos, token]
  );

  const remove = useCallback(
    async (id) => {
      if (token) {
        try {
          await videosApi.deleteVideo(id, token);
        } catch (err) {
          console.error('Delete video failed:', err);
          throw new Error('删除失败，请重试');
        }
      }

      setVideos((prev) => prev.filter((v) => v.id !== id));
    },
    [token]
  );

  return { videos, loading, uploading, upload, update, remove };
}
