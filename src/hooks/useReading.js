import { useCallback, useEffect, useState } from 'react';
import { books as fallbackBooks } from '../data/books';
import { resolveBookMetadata } from '../data/bookMetadata';
import * as readingApi from '../api/reading';

function normalize(item) {
  const localMetadata = resolveBookMetadata(item.title);
  return {
    id: item.id,
    title: localMetadata.title,
    author: item.author || '',
    year: localMetadata.year || (item.year != null ? String(item.year) : ''),
    rating: item.rating != null ? Number(item.rating) : 0,
    status: item.status || 'read',
    note: item.note || '',
    cover_url: localMetadata.coverUrl || item.cover_url || item.coverUrl || '',
  };
}

export function useReading(token) {
  const [books, setBooks] = useState(() => fallbackBooks.map(normalize));
  const [loading, setLoading] = useState(true);
  const [backendReady, setBackendReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readingApi
      .fetchBooks()
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setBooks(data.map(normalize));
        setBackendReady(true);
      })
      .catch(() => {
        // 后端未部署 /api/reading —— 静默用兜底
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (payload) => {
      const clean = {
        title: (payload.title || '').trim(),
        author: (payload.author || '').trim(),
        year: (payload.year || '').trim(),
        rating: Number(payload.rating) || 0,
        status: payload.status || 'read',
        note: (payload.note || '').trim(),
        cover_url: (payload.cover_url || '').trim(),
      };
      if (!clean.title) throw new Error('书名不能为空');

      // 本地演示模式（未登录 or 后端未就绪）
      if (!token || !backendReady) {
        if (payload.id) {
          setBooks((prev) => prev.map((b) => (b.id === payload.id ? normalize({ ...b, ...clean }) : b)));
        } else {
          const local = normalize({ id: `local-${Math.random().toString(36).slice(2, 8)}`, ...clean });
          setBooks((prev) => [local, ...prev]);
        }
        return;
      }

      setSaving(true);
      try {
        const item = payload.id
          ? await readingApi.updateBook(payload.id, clean, token)
          : await readingApi.createBook(clean, token);
        const saved = normalize(item);
        setBooks((prev) => {
          if (payload.id) return prev.map((b) => (b.id === payload.id ? saved : b));
          return [saved, ...prev];
        });
      } finally {
        setSaving(false);
      }
    },
    [token, backendReady]
  );

  const remove = useCallback(
    async (id) => {
      if (token && backendReady) {
        try {
          await readingApi.deleteBook(id, token);
        } catch (err) {
          console.error('Delete book failed:', err);
          throw err;
        }
      }
      setBooks((prev) => prev.filter((b) => b.id !== id));
    },
    [token, backendReady]
  );

  return { books, loading, saving, backendReady, save, remove };
}
