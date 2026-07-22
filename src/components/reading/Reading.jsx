import React, { useMemo, useState } from 'react';
import { Search, X, Plus, Edit3, Trash2, BookOpen } from 'lucide-react';
import { statusLabel } from '../../data/books';
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
    <li className="book-card">
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

export default function Reading({ isAdmin, books, loading, saving, backendReady, onSave, onDelete }) {
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const { confirm, toast } = useDialog();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter((b) => {
      return (
        (b.title || '').toLowerCase().includes(q) ||
        (b.author || '').toLowerCase().includes(q) ||
        (b.note || '').toLowerCase().includes(q)
      );
    });
  }, [books, query]);

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
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="reading-search-clear"
              onClick={() => setQuery('')}
              aria-label="clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <span className="reading-count">
          {query ? `${filtered.length}/${books.length}` : `${books.length} 本`}
        </span>
      </div>

      {loading ? (
        <LoadingBlock label="加载书单..." />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={query ? '没有匹配的书' : '暂无书籍'}
          description={query ? '换个关键词试试' : (isAdmin ? '点右上角"添加"开始记录吧' : '')}
        />
      ) : (
        <ul className="book-list">
          {filtered.map((book) => (
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
