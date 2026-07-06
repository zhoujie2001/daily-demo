import { useCallback, useEffect, useState } from 'react';
import * as videosApi from '../api/videos';
import * as uploadApi from '../api/upload';

export function useVideos(token) {
  const [videos, setVideos] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    videosApi
      .fetchVideos()
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) setVideos(data);
      })
      .catch((err) => console.error('Error fetching videos', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(
    async (file) => {
      if (!file || !token) return;
      setUploading(true);
      try {
        const [url] = await uploadApi.uploadFiles(file, token);
        const created = await videosApi.createVideo(
          { title: file.name.split('.')[0] || 'New Video', url },
          token
        );
        setVideos((prev) => [created, ...prev]);
      } catch (err) {
        console.error('Failed to upload video:', err);
        alert('上传视频失败');
      } finally {
        setUploading(false);
      }
    },
    [token]
  );

  const update = useCallback(
    async (id, patch) => {
      if (!token) return;
      const current = videos.find((v) => v.id === id);
      if (!current) return;
      try {
        await videosApi.updateVideo(
          id,
          { title: patch.title ?? current.title, url: current.url },
          token
        );
        setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
      } catch (err) {
        console.error('Update video failed', err);
      }
    },
    [videos, token]
  );

  const remove = useCallback(
    async (id) => {
      try {
        if (token) await videosApi.deleteVideo(id, token);
      } catch (err) {
        console.error('Delete video failed', err);
      }
      setVideos((prev) => prev.filter((v) => v.id !== id));
    },
    [token]
  );

  return { videos, uploading, upload, update, remove };
}
