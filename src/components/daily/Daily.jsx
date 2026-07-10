import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tag as TagIcon } from 'lucide-react';
import Timeline from './Timeline';
import DailyEntry from './DailyEntry';
import DailyEditor from './DailyEditor';
import SearchBar from './SearchBar';
import { useDialog } from '../../context/DialogContext';
import EmptyState from '../ui/EmptyState';
import { SkeletonCard, SkeletonText } from '../Skeleton';

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function matchesKeyword(post, keyword) {
  const query = keyword.trim().toLowerCase();
  if (!query) return true;

  const title = (post.title || '').toLowerCase();
  const text = (post.text || '').toLowerCase();
  return title.includes(query) || text.includes(query);
}

export default function Daily({ isAdmin, posts, loading = false, activeDate, onActiveDateChange, onPublish, onDelete }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [tags, setTags] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [activeTag, setActiveTag] = useState(null);
  const [keyword, setKeyword] = useState('');
  const lastSyncKeyRef = useRef('');
  const objectUrlSetRef = useRef(new Set());
  const { confirm, toast } = useDialog();

  const registerObjectUrl = useCallback((url) => {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      objectUrlSetRef.current.add(url);
    }
  }, []);

  const revokeObjectUrl = useCallback((url) => {
    if (!objectUrlSetRef.current.has(url)) {
      return;
    }
    URL.revokeObjectURL(url);
    objectUrlSetRef.current.delete(url);
  }, []);

  const clearObjectUrls = useCallback(() => {
    objectUrlSetRef.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    objectUrlSetRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      clearObjectUrls();
    };
  }, [clearObjectUrls]);

  const today = todayLabel();
  const todayPost = useMemo(() => (posts || []).find((p) => p.date === today) || null, [posts, today]);

  const allTags = useMemo(() => {
    const s = new Set();
    (posts || []).forEach((p) => (p.tags || []).forEach((t) => t && s.add(t)));
    return Array.from(s);
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const tagFiltered = !activeTag ? posts || [] : (posts || []).filter((p) => (p.tags || []).includes(activeTag));
    return tagFiltered.filter((post) => matchesKeyword(post, keyword));
  }, [posts, activeTag, keyword]);

  const currentPost = useMemo(() => {
    if (!filteredPosts || filteredPosts.length === 0) return null;
    return filteredPosts.find((p) => p.id === activeDate) || filteredPosts[0];
  }, [filteredPosts, activeDate]);

  const emptyStateCopy = useMemo(() => {
    if (keyword.trim()) {
      return {
        title: '没有找到相关日记',
        description: activeTag ? `试试清空搜索词，或切换到其他标签“${activeTag}”` : '换个关键词试试看，也许会翻到那篇日记。',
      };
    }
    if (activeTag) {
      return {
        title: `没有带 “${activeTag}” 标签的 Daily`,
        description: '换个标签或点“全部”看看',
      };
    }
    return {
      title: '暂无 Daily',
      description: '等博主慢慢补上吧～',
    };
  }, [activeTag, keyword]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    const editorSource = editingId ? posts.find((p) => p.id === editingId) || null : todayPost;
    const syncKey = `${isAdmin}-${editorSource?.id || 'new'}-${today}`;

    if (syncKey === lastSyncKeyRef.current) {
      return;
    }

    lastSyncKeyRef.current = syncKey;
    queueMicrotask(() => {
      clearObjectUrls();
      if (editorSource) {
        setEditingId(editorSource.id);
        setText(editorSource.text || '');
        setTags(editorSource.tags || []);
        setAttachments(
          (editorSource.media || []).map((m) => ({
            type: m.type,
            url: m.url,
            value: m.value || m.url,
            isExisting: true,
          }))
        );
        return;
      }

      setEditingId(null);
      setText('');
      setTags([]);
      setAttachments([]);
    });
  }, [clearObjectUrls, isAdmin, editingId, posts, today, todayPost]);

  const handleSelectDate = (id) => onActiveDateChange(id);

  const handleTagChange = (nextTag) => {
    setActiveTag(nextTag);
    setKeyword('');
  };

  const handleFileSelect = (e, type) => {
    const files = Array.from(e.target.files || []);
    const newAtt = files.map((file) => {
      const url = URL.createObjectURL(file);
      registerObjectUrl(url);
      return { file, type, url, value: url };
    });
    setAttachments((prev) => [...prev, ...newAtt]);
    e.target.value = '';
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => {
      const target = prev[idx];
      if (target?.file) {
        revokeObjectUrl(target.url);
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  const resetEditorToToday = () => {
    clearObjectUrls();
    lastSyncKeyRef.current = '';
    setEditingId(null);
  };

  const startEdit = (post) => {
    clearObjectUrls();
    lastSyncKeyRef.current = '';
    setEditingId(post.id);
    setText(post.text || '');
    setTags(post.tags || []);
    setAttachments(
      (post.media || []).map((m) => ({
        type: m.type,
        url: m.url,
        value: m.value || m.url,
        isExisting: true,
      }))
    );
  };

  const handlePublish = async () => {
    if (publishing) return;
    setPublishing(true);
    try {
      const editingPost = editingId ? posts.find((p) => p.id === editingId) : null;
      const editingDate = editingPost?.date || '';
      await onPublish({ text, attachments, editingId, tags });
      toast.success(editingId ? `已更新 ${editingDate} 的 Daily` : '已发布');
      resetEditorToToday();
    } catch (err) {
      toast.error(err.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async (post) => {
    const ok = await confirm({
      title: '删除 Daily',
      message: `确定删除 ${post.date} 这条 Daily？`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await onDelete(post.id);
      toast.success('已删除');
      resetEditorToToday();
    } catch (err) {
      toast.error(err.message || '删除失败');
    }
  };

  return (
    <section id="daily" className="daily-section">
      <h2>Daily</h2>

      <div className="daily-toolbar">
        <SearchBar value={keyword} onChange={setKeyword} onClear={() => setKeyword('')} />
        {allTags.length > 0 ? (
          <div className="daily-tag-filter">
            <TagIcon size={12} className="daily-tag-filter-icon" />
            <button type="button" className={`tag-chip ${!activeTag ? 'active' : ''}`} onClick={() => handleTagChange(null)}>
              全部
            </button>
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`tag-chip ${activeTag === t ? 'active' : ''}`}
                onClick={() => handleTagChange(activeTag === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="layout-grid">
        {loading ? (
          <main className="col-content daily-skeleton-list">
            {[0, 1, 2].map((item) => (
              <div key={item} className="daily-skeleton-item">
                <SkeletonCard height={150} />
                <div className="daily-skeleton-text-group">
                  <SkeletonText width="100%" />
                  <SkeletonText width="70%" />
                </div>
              </div>
            ))}
          </main>
        ) : (
          <>
            <Timeline posts={filteredPosts} activeDate={currentPost?.id} onSelect={handleSelectDate} />
            <main className="col-content">
              {currentPost ? (
                <DailyEntry
                  key={currentPost.id}
                  post={currentPost}
                  isAdmin={isAdmin}
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  keyword={keyword}
                />
              ) : (
                <EmptyState title={emptyStateCopy.title} description={emptyStateCopy.description} />
              )}
            </main>
          </>
        )}
        {isAdmin ? (
          <DailyEditor
            editingId={editingId || todayPost?.id || null}
            text={text}
            attachments={attachments}
            tags={tags}
            publishing={publishing}
            onTextChange={setText}
            onTagsChange={setTags}
            onFilesSelected={handleFileSelect}
            onRemoveAttachment={removeAttachment}
            onPublish={handlePublish}
            onCancelEdit={resetEditorToToday}
          />
        ) : null}
      </div>
    </section>
  );
}
