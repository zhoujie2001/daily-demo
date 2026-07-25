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

function toSavePayload(book) {
  return {
    title: book.title || '',
    author: book.author || '',
    year: book.year || '',
    rating: Number(book.rating) || 0,
    status: book.status || 'read',
    note: book.note || '',
    cover_url: book.cover_url || '',
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
        const normalizedBooks = data.map(normalize);
        setBooks(normalizedBooks);
        setBackendReady(true);

        // 为历史记录中没有封面的书籍自动补全。未登录时至少在当前页面展示；
        // 管理员登录后会同步回后端，避免下次访问重复查询。
        void (async () => {
          const missingCovers = normalizedBooks.filter((book) => !book.cover_url).slice(0, 12);
          for (const book of missingCovers) {
            if (cancelled) return;
            try {
              const candidates = await readingApi.searchBookCovers({
                title: book.title,
                author: book.author,
              });
              const best = candidates[0];
              if (!best?.coverUrl || cancelled) continue;

              const enriched = {
                ...book,
                cover_url: best.coverUrl,
                author: book.author || best.authors?.join(' / ') || '',
                year: book.year || best.year || '',
              };
              setBooks((prev) => prev.map((item) => {
                if (item.id !== book.id || item.cover_url) return item;
                return {
                  ...item,
                  cover_url: best.coverUrl,
                  author: item.author || best.authors?.join(' / ') || '',
                  year: item.year || best.year || '',
                };
              }));

              if (token && book.id != null && !String(book.id).startsWith('local-')) {
                await readingApi.updateBook(book.id, toSavePayload(enriched), token).catch(() => {
                  // 展示补全已成功，持久化失败留待下次登录重试。
                });
              }
            } catch {
              // 单本书查询失败不影响列表和其余书籍。
            }
          }
        })();
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
  }, [token]);

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

      setSaving(true);
      try {
        // 用户没有手动选择封面时，保存动作本身也会做一次自动匹配，
        // 避免从书名输入框直接点击“保存”而错过 blur 搜索。
        if (!clean.cover_url) {
          try {
            const candidates = await readingApi.searchBookCovers({
              title: clean.title,
              author: clean.author,
            });
            clean.cover_url = candidates[0]?.coverUrl || '';
            clean.author = clean.author || candidates[0]?.authors?.join(' / ') || '';
            clean.year = clean.year || candidates[0]?.year || '';
          } catch {
            // 自动匹配失败不应阻断书籍保存，交给占位封面兜底。
          }
        }

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
