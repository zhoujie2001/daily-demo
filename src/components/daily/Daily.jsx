import React, { useMemo, useState } from 'react';
import { Tag as TagIcon } from 'lucide-react';
import Timeline from './Timeline';
import DailyEntry from './DailyEntry';
import DailyEditor from './DailyEditor';
import { useDialog } from '../../context/DialogContext';
import EmptyState from '../ui/EmptyState';

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

export default function Daily({ isAdmin, posts, activeDate, onActiveDateChange, onPublish, onDelete }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [tags, setTags] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [activeTag, setActiveTag] = useState(null);
  const [lastSyncKey, setLastSyncKey] = useState('');
  const { confirm, toast } = useDialog();

  const today = todayLabel();
  const todayPost = useMemo(() => (posts || []).find((p) => p.date === today) || null, [posts, today]);

  const allTags = useMemo(() => {
    const s = new Set();
    (posts || []).forEach((p) => (p.tags || []).forEach((t) => t && s.add(t)));
    return Array.from(s);
  }, [posts]);

  const filteredPosts = useMemo(() => {
    if (!activeTag) return posts;
    return (posts || []).filter((p) => (p.tags || []).includes(activeTag));
  }, [posts, activeTag]);

  const currentPost = useMemo(() => {
    if (!filteredPosts || filteredPosts.length === 0) return null;
    return filteredPosts.find((p) => p.id === activeDate) || filteredPosts[0];
  }, [filteredPosts, activeDate]);

  // 同一天唯一：管理员默认进入“今天”的编辑模式；切换到历史条目时同步预填内容
  const editorSource = editingId ? posts.find((p) => p.id === editingId) || null : todayPost;
  const syncKey = `${isAdmin}-${editorSource?.id || 'new'}-${today}`;
  if (isAdmin && syncKey !== lastSyncKey) {
    setLastSyncKey(syncKey);
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
    } else {
      setEditingId(null);
      setText('');
      setTags([]);
      setAttachments([]);
    }
  }

  const handleSelectDate = (id) => onActiveDateChange(id);

  const handleFileSelect = (e, type) => {
    const files = Array.from(e.target.files || []);
    const newAtt = files.map((file) => {
      const url = URL.createObjectURL(file);
      return { file, type, url, value: url };
    });
    setAttachments((prev) => [...prev, ...newAtt]);
    e.target.value = '';
  };

  const removeAttachment = (idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  const resetEditorToToday = () => {
    setLastSyncKey('');
    setEditingId(null);
  };

  const startEdit = (post) => {
    setLastSyncKey('');
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

      {allTags.length > 0 && (
        <div className="daily-tag-filter">
          <TagIcon size={12} className="daily-tag-filter-icon" />
          <button type="button" className={`tag-chip ${!activeTag ? 'active' : ''}`} onClick={() => setActiveTag(null)}>
            全部
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              className={`tag-chip ${activeTag === t ? 'active' : ''}`}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="layout-grid">
        <Timeline posts={filteredPosts} activeDate={currentPost?.id} onSelect={handleSelectDate} />
        <main className="col-content">
          {currentPost ? (
            <DailyEntry key={currentPost.id} post={currentPost} isAdmin={isAdmin} onEdit={startEdit} onDelete={handleDelete} />
          ) : (
            <EmptyState
              title={activeTag ? `没有带 “${activeTag}” 标签的 Daily` : '暂无 Daily'}
              description={activeTag ? '换个标签或点“全部”看看' : '等博主慢慢补上吧～'}
            />
          )}
        </main>
        {isAdmin && (
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
        )}
      </div>
    </section>
  );
}
