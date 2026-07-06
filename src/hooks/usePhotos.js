import { useCallback, useEffect, useState } from 'react';
import * as photosApi from '../api/photos';
import * as uploadApi from '../api/upload';

export function usePhotos(token) {
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    photosApi
      .fetchPhotos()
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) setPhotos(data);
      })
      .catch((err) => console.error('Error fetching photos', err));
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
        const created = await photosApi.createPhoto(
          {
            title: file.name.split('.')[0] || 'New Photo',
            desc: 'New upload',
            url,
          },
          token
        );
        setPhotos((prev) => [created, ...prev]);
      } catch (err) {
        console.error('Failed to upload photo:', err);
        alert('上传照片失败');
      } finally {
        setUploading(false);
      }
    },
    [token]
  );

  const update = useCallback(
    async (id, patch) => {
      if (!token) return;
      const current = photos.find((p) => p.id === id);
      if (!current) return;
      try {
        await photosApi.updatePhoto(
          id,
          { title: patch.title ?? current.title, desc: patch.desc ?? current.desc, url: current.url },
          token
        );
        setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
      } catch (err) {
        console.error('Update photo failed', err);
      }
    },
    [photos, token]
  );

  const remove = useCallback(
    async (id) => {
      try {
        if (token) await photosApi.deletePhoto(id, token);
      } catch (err) {
        console.error('Delete photo failed', err);
      }
      setPhotos((prev) => prev.filter((p) => p.id !== id));
    },
    [token]
  );

  return { photos, uploading, upload, update, remove };
}
