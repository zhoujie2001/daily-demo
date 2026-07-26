import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  X,
  Plus,
  Edit3,
  Trash2,
  BookOpen,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { statusLabel } from '../../data/books';
import {
  READING_FILTERS,
  filterReadingBooks,
  getReadingPageSize,
  getReadingSwipeDirection,
  paginateReadingBooks,
} from '../../utils/readingPagination';
import BookEditor from './BookEditor';
import Button from '../ui/Button';
import { LoadingBlock } from '../ui/Loading';
import EmptyState from '../ui/EmptyState';
import SectionHeading from '../ui/SectionHeading';
import { useDialog } from '../../context/DialogContext';

function Stars({ value }) {
  if (!value) return null;
  const rounded = Math.round(value);
  return (
    <span className="book-stars" aria-label={`${rounded} 星`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= rounded ? 'filled' : ''}>★</span>
      ))}
    </span>
  );
}

function BookCard({ book, isAdmin, onEdit, onDelete }) {
  const [failedCoverUrl, setFailedCoverUrl] = useState('');
  const showCover = Boolean(book.cover_url) && failedCoverUrl !== book.cover_url;

  return (
    <li className={`book-card ${isAdmin ? 'is-admin' : ''}`.trim()}>
      <div className="book-cover">
        {showCover ? (
          <img
            src={book.cover_url}
            alt={`《${book.title}》封面`}
            loading="lazy"
            onError={() => setFailedCoverUrl(book.cover_url)}
          />
        ) : (
          <div className="book-cover-placeholder" role="img" aria-label={`《${book.title}》暂无封面`}>
            <BookOpen size={22} />
          </div>
        )}
      </div>
      <div className="book-body">
        <div className="book-title-row">
          <h3 className="book-title">《{book.title}》</h3>
          {book.status && book.status !== 'read' && (
            <span className={`book-status book-status-${book.status}`}>{statusLabel(book.status)}</span>
          )}
        </div>
        <div className="book-meta">
          {book.author && <span className="book-author">{book.author}</span>}
          {book.year && <span className="book-year">{book.year}</span>}
          <Stars value={book.rating} />
        </div>
        {book.note && <p className="book-note">{book.note}</p>}
      </div>
      {isAdmin && (
        <div className="book-actions">
          <button className="book-action-btn" onClick={() => onEdit(book)} aria-label="编辑">
            <Edit3 size={14} />
          </button>
          <button className="book-action-btn danger" onClick={() => onDelete(book)} aria-label="删除">
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </li>
  );
}

function readPageSize() {
  if (typeof window === 'undefined') return getReadingPageSize();
  return getReadingPageSize(window.innerWidth);
}

function useReadingPageSize() {
  const [pageSize, setPageSize] = useState(readPageSize);

  useEffect(() => {
    const handleResize = () => {
      setPageSize((current) => {
        const next = readPageSize();
        return current === next ? current : next;
      });
    };

    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return pageSize;
}

export default function Reading({ isAdmin, books, loading, saving, backendReady, onSave, onDelete }) {
  const [query, setQuery] = useState('');
  const [activeStatus, setActiveStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [pageDirection, setPageDirection] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const touchStartRef = useRef(null);
  const pageSize = useReadingPageSize();
  const { confirm, toast } = useDialog();

  const filtered = useMemo(() => {
    return filterReadingBooks(books, { query, status: activeStatus });
  }, [activeStatus, books, query]);

  const paginated = useMemo(
    () => paginateReadingBooks(filtered, page, pageSize),
    [filtered, page, pageSize]
  );

  const resetPage = () => {
    setPageDirection('');
    setPage(1);
  };

  const changePage = (nextPage) => {
    const next = Math.min(Math.max(1, nextPage), paginated.pageCount);
    if (next === paginated.page) return;
    setPageDirection(next > paginated.page ? 'next' : 'previous');
    setPage(next);
  };

  const handleTouchStart = (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event) => {
    const start = touchStartRef.current;
    const touch = event.changedTouches[0];
    touchStartRef.current = null;
    if (!start || !touch || paginated.pageCount <= 1) return;

    const direction = getReadingSwipeDirection(start, { x: touch.clientX, y: touch.clientY });
    if (!direction) return;
    changePage(direction === 'next' ? paginated.page + 1 : paginated.page - 1);
  };

  const openAdd = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (book) => {
    setEditing(book);
    setEditorOpen(true);
  };

  const closeEditor = () => setEditorOpen(false);

  const handleSubmit = async (form) => {
    try {
      await onSave({ ...form, id: editing?.id });
      resetPage();
      toast.success(editing ? '已更新' : '已添加');
      setEditorOpen(false);
    } catch (err) {
      toast.error(err.message || '保存失败');
    }
  };

  const handleDelete = async (book) => {
    const ok = await confirm({
      title: '删除书籍',
      message: `确定要从书单中删除《${book.title}》吗？`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await onDelete(book.id);
      resetPage();
      toast.success('已删除');
    } catch (err) {
      toast.error(err.message || '删除失败');
    }
  };

  return (
    <section id="reading" className="reading-section">
      <SectionHeading
        title="Reading"
        description="读过的书，也在慢慢塑造生活。"
        action={isAdmin ? (
          <Button size="sm" onClick={openAdd}>
            <Plus size={14} /> 添加
          </Button>
        ) : null}
      />

      <div className="reading-toolbar">
        <div className="reading-search">
          <Search size={13} className="reading-search-icon" />
          <input
            type="text"
            className="reading-search-input"
            placeholder="搜索书名 / 作者 / 短评..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              resetPage();
            }}
          />
          {query && (
            <button
              type="button"
              className="reading-search-clear"
              onClick={() => {
                setQuery('');
                resetPage();
              }}
              aria-label="clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <span className="reading-count">
          {query || activeStatus !== 'all'
            ? `${filtered.length}/${books.length} 本`
            : `${books.length} 本`}
        </span>
      </div>

      <div className="reading-filters" role="group" aria-label="按阅读状态筛选">
        {READING_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={`reading-filter ${activeStatus === filter.value ? 'active' : ''}`.trim()}
            aria-pressed={activeStatus === filter.value}
            onClick={() => {
              setActiveStatus(filter.value);
              resetPage();
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div
        className="reading-results"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {loading ? (
          <LoadingBlock label="加载书单..." />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={query || activeStatus !== 'all' ? '没有匹配的书' : '暂无书籍'}
            description={
              query || activeStatus !== 'all'
                ? '换个关键词或状态试试'
                : (isAdmin ? '点右上角"添加"开始记录吧' : '')
            }
          />
        ) : (
          <ul
            key={`${activeStatus}-${query}-${paginated.page}-${pageSize}`}
            className={`book-list ${pageDirection ? `page-enter-${pageDirection}` : ''}`.trim()}
          >
            {paginated.items.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                isAdmin={isAdmin}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>

      <nav className="reading-pagination" aria-label="书籍分页">
        <button
          type="button"
          className="reading-page-button"
          onClick={() => changePage(paginated.page - 1)}
          disabled={paginated.page <= 1}
          aria-label="上一页书籍"
        >
          <ChevronLeft size={17} />
        </button>
        <span className="reading-page-count" aria-live="polite">
          {filtered.length === 0 ? '0 / 0' : `${paginated.page} / ${paginated.pageCount}`}
        </span>
        <button
          type="button"
          className="reading-page-button"
          onClick={() => changePage(paginated.page + 1)}
          disabled={paginated.page >= paginated.pageCount}
          aria-label="下一页书籍"
        >
          <ChevronRight size={17} />
        </button>
      </nav>

      {isAdmin && !backendReady && !loading && (
        <p className="reading-hint">
          提示：后端 <code>/api/reading</code> 尚未就绪，当前处于本地演示模式，改动不会持久化。
        </p>
      )}

      <BookEditor
        open={editorOpen}
        initial={editing}
        onClose={closeEditor}
        onSubmit={handleSubmit}
        saving={saving}
      />
    </section>
  );
}
