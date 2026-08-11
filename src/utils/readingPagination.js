export const READING_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'reading', label: '在读' },
  { value: 'read', label: '已读' },
  { value: 'want', label: '想读' },
];

export function getReadingPageSize(viewportWidth) {
  const width = Number(viewportWidth);
  if (!Number.isFinite(width)) return 6;
  if (width <= 700) return 3;
  if (width <= 999) return 4;
  return 6;
}

export function filterReadingBooks(books, { query = '', status = 'all' } = {}) {
  const source = Array.isArray(books) ? books : [];
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return source.filter((book) => {
    if (status !== 'all' && book.status !== status) return false;
    if (!normalizedQuery) return true;

    return [book.title, book.author, book.note].some((value) =>
      String(value || '').toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

export function getReadingPageCount(itemCount, pageSize) {
  const size = Math.max(1, Number(pageSize) || 1);
  return Math.max(1, Math.ceil(Math.max(0, Number(itemCount) || 0) / size));
}

export function clampReadingPage(page, pageCount) {
  const total = Math.max(1, Number(pageCount) || 1);
  return Math.min(Math.max(1, Number(page) || 1), total);
}

export function paginateReadingBooks(books, page, pageSize) {
  const source = Array.isArray(books) ? books : [];
  const size = Math.max(1, Number(pageSize) || 1);
  const pageCount = getReadingPageCount(source.length, size);
  const safePage = clampReadingPage(page, pageCount);
  const start = (safePage - 1) * size;

  return {
    items: source.slice(start, start + size),
    page: safePage,
    pageCount,
  };
}

export function createReadingPagePreviews(books, pageSize, previewSize = 2) {
  const source = Array.isArray(books) ? books : [];
  const size = Math.max(1, Number(pageSize) || 1);
  const coverCount = Math.max(1, Number(previewSize) || 1);
  const pageCount = getReadingPageCount(source.length, size);

  if (!source.length) return [];

  return Array.from({ length: pageCount }, (_, index) => {
    const start = index * size;
    const pageBooks = source.slice(start, start + size);
    return {
      id: index + 1,
      page: index + 1,
      books: pageBooks.slice(0, coverCount),
      count: pageBooks.length,
    };
  });
}

export function getReadingSwipeDirection(start, end) {
  if (!start || !end) return null;

  const deltaX = Number(end.x) - Number(start.x);
  const deltaY = Number(end.y) - Number(start.y);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return null;

  return deltaX < 0 ? 'next' : 'previous';
}
