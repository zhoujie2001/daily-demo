import React, { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { BOOK_STATUS_OPTIONS } from '../../data/books';

const EMPTY = { title: '', author: '', year: '', rating: 0, status: 'read', note: '', cover_url: '' };

export default function BookEditor({ open, initial, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, ...(initial || {}) }));
  const [lastKey, setLastKey] = useState(() => `${open}-${initial?.id || ''}`);

  // 打开或切换编辑对象时，同步表单（render 阶段检测，避开 effect 内 setState 规则）
  const currentKey = `${open}-${initial?.id || ''}`;
  if (open && currentKey !== lastKey) {
    setLastKey(currentKey);
    setForm({ ...EMPTY, ...(initial || {}) });
  }

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    await onSubmit(form);
  };

  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? '编辑书籍' : '添加书籍'}>
      <form className="book-editor" onSubmit={submit}>
        <label>
          <span>书名 *</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setField('title', e.target.value)}
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

        <label>
          <span>封面图 URL</span>
          <input
            type="text"
            value={form.cover_url}
            onChange={(e) => setField('cover_url', e.target.value)}
            placeholder="https://..."
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
