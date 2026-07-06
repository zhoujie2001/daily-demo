import { useCallback, useEffect, useState } from 'react';
import * as photosApi from '../api/photos';
import * as uploadApi from '../api/upload';

export function usePhotos(token) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    photosApi
      .fetchPhotos()
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) setPhotos(data);
      })
      .catch((err) => console.error('Error fetching photos', err))
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
        const created = await photosApi.createPhoto(
          {
            title: file.name.split('.')[0] || 'New Photo',
            desc: 'New upload',
            url,
          },
          token
        );
        setPhotos((prev) => [created, ...prev]);
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
      const current = photos.find((p) => p.id === id);
      if (!current) throw new Error('photo not found');
      await photosApi.updatePhoto(
        id,
        { title: patch.title ?? current.title, desc: patch.desc ?? current.desc, url: current.url },
        token
      );
      setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [photos, token]
  );

  const remove = useCallback(
    async (id) => {
      if (token) await photosApi.deletePhoto(id, token);
      setPhotos((prev) => prev.filter((p) => p.id !== id));
    },
    [token]
  );

  return { photos, loading, uploading, upload, update, remove };
}
