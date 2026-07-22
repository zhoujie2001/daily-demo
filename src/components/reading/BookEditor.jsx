import React, { useRef, useState } from 'react';
import { BookOpen, Check, Search } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { BOOK_STATUS_OPTIONS } from '../../data/books';
import { searchBookCovers } from '../../api/reading';

const EMPTY = { title: '', author: '', year: '', rating: 0, status: 'read', note: '', cover_url: '' };

export default function BookEditor({ open, initial, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, ...(initial || {}) }));
  const [lastKey, setLastKey] = useState(() => `${open}-${initial?.id || ''}`);
  const [isbn, setIsbn] = useState('');
  const [coverCandidates, setCoverCandidates] = useState([]);
  const [coverSearching, setCoverSearching] = useState(false);
  const [coverSearchError, setCoverSearchError] = useState('');
  const [lastLookupKey, setLastLookupKey] = useState('');
  const searchRequestRef = useRef(0);

  // 打开或切换编辑对象时，同步表单（render 阶段检测，避开 effect 内 setState 规则）
  const currentKey = `${open}-${initial?.id || ''}`;
  if (open && currentKey !== lastKey) {
    setLastKey(currentKey);
    setForm({ ...EMPTY, ...(initial || {}) });
    setIsbn('');
    setCoverCandidates([]);
    setCoverSearching(false);
    setCoverSearchError('');
    setLastLookupKey('');
  }

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const runCoverSearch = async ({
    silent = false,
    title = form.title,
    author = form.author,
    isbnValue = isbn,
  } = {}) => {
    const query = {
      title: title.trim(),
      author: author.trim(),
      isbn: isbnValue.trim(),
    };
    if (!query.title && query.isbn.length < 10) {
      if (!silent) setCoverSearchError('请先输入书名或 ISBN');
      return;
    }

    const lookupKey = `${query.title}|${query.author}|${query.isbn}`.toLocaleLowerCase();
    if (lookupKey === lastLookupKey && coverCandidates.length) return;

    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setCoverSearching(true);
    setCoverSearchError('');

    try {
      const candidates = await searchBookCovers(query);
      if (requestId !== searchRequestRef.current) return;
      setCoverCandidates(candidates);
      setLastLookupKey(lookupKey);

      const best = candidates[0];
      if (!best) {
        setCoverSearchError('没有找到匹配封面，可以补充作者或 ISBN 后重试');
        return;
      }

      setForm((prev) => {
        const canReplaceCover = !prev.cover_url || prev.cover_url.startsWith('/api/book-cover?');
        return {
          ...prev,
          cover_url: canReplaceCover ? best.coverUrl : prev.cover_url,
          author: prev.author || best.authors?.join(' / ') || '',
          year: prev.year || best.year || '',
        };
      });
    } catch (error) {
      if (requestId === searchRequestRef.current) {
        setCoverSearchError(error.message || '封面搜索失败，请稍后重试');
      }
    } finally {
      if (requestId === searchRequestRef.current) setCoverSearching(false);
    }
  };

  const autoLookupOnBlur = (overrides = {}) => {
    const canReplaceCover = !form.cover_url || form.cover_url.startsWith('/api/book-cover?');
    if (canReplaceCover) void runCoverSearch({ silent: true, ...overrides });
  };

  const selectCandidate = (candidate) => {
    setForm((prev) => ({
      ...prev,
      cover_url: candidate.coverUrl,
      author: prev.author || candidate.authors?.join(' / ') || '',
      year: prev.year || candidate.year || '',
    }));
    setCoverSearchError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    await onSubmit(form);
  };

  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? '编辑书籍' : '添加书籍'} size="lg">
      <form className="book-editor" onSubmit={submit}>
        <label>
          <span>书名 *</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setField('title', e.target.value)}
            onBlur={(e) => autoLookupOnBlur({ title: e.currentTarget.value })}
            placeholder="必填"
            autoFocus
          />
        </label>

        <div className="book-editor-row">
          <label>
            <span>作者</span>
            <input
              type="text"
              value={form.author}
              onChange={(e) => setField('author', e.target.value)}
              onBlur={(e) => autoLookupOnBlur({ author: e.currentTarget.value })}
            />
          </label>
          <label>
            <span>年份</span>
            <input
              type="text"
              value={form.year}
              onChange={(e) => setField('year', e.target.value)}
              placeholder="2026"
            />
          </label>
        </div>

        <div className="book-editor-row">
          <label>
            <span>评分</span>
            <div className="rating-input">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`rating-star ${form.rating >= n ? 'filled' : ''}`}
                  onClick={() => setField('rating', form.rating === n ? 0 : n)}
                  aria-label={`${n} 星`}
                >
                  ★
                </button>
              ))}
            </div>
          </label>
          <label>
            <span>状态</span>
            <select value={form.status} onChange={(e) => setField('status', e.target.value)}>
              {BOOK_STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <section className="book-cover-finder" aria-labelledby="book-cover-finder-title">
          <div className="book-cover-finder-header">
            <div>
              <strong id="book-cover-finder-title">自动匹配封面</strong>
              <span>输入书名后会自动查找，也可以用 ISBN 提高准确度</span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={coverSearching}
              onClick={() => runCoverSearch()}
            >
              <Search size={14} /> 查找封面
            </Button>
          </div>

          <label className="book-isbn-field">
            <span>ISBN（可选，不保存）</span>
            <input
              type="text"
              inputMode="numeric"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              onBlur={(e) => autoLookupOnBlur({ isbnValue: e.currentTarget.value })}
              placeholder="978..."
            />
          </label>

          {coverCandidates.length > 0 ? (
            <div className="book-cover-candidates" aria-label="封面候选">
              {coverCandidates.slice(0, 6).map((candidate) => {
                const selected = form.cover_url === candidate.coverUrl;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`book-cover-candidate ${selected ? 'selected' : ''}`}
                    onClick={() => selectCandidate(candidate)}
                    aria-pressed={selected}
                    title={`选择《${candidate.title}》封面`}
                  >
                    <span className="book-cover-candidate-image">
                      <img
                        src={candidate.coverUrl}
                        alt=""
                        loading="lazy"
                        onError={(event) => { event.currentTarget.style.display = 'none'; }}
                      />
                      {selected ? <span className="book-cover-selected-mark"><Check size={13} /></span> : null}
                    </span>
                    <span className="book-cover-candidate-copy">
                      <strong>{candidate.title}</strong>
                      <small>{candidate.authors?.[0] || '作者未知'}{candidate.year ? ` · ${candidate.year}` : ''}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!coverSearching && !coverCandidates.length && !coverSearchError ? (
            <div className="book-cover-empty">
              <BookOpen size={18} aria-hidden="true" />
              填写书名后，系统会自动选择最匹配的封面
            </div>
          ) : null}
          {coverSearchError ? <p className="book-cover-search-message" role="status">{coverSearchError}</p> : null}
        </section>

        <label className="book-cover-url-field">
          <span>封面图 URL（可手动覆盖）</span>
          <input
            type="text"
            value={form.cover_url}
            onChange={(e) => setField('cover_url', e.target.value)}
            placeholder="自动匹配失败时可手动填写 https://..."
          />
        </label>

        <label>
          <span>短评</span>
          <textarea
            rows={3}
            value={form.note}
            onChange={(e) => setField('note', e.target.value)}
            placeholder="随手写点感受..."
          />
        </label>

        <div className="book-editor-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" loading={saving}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
