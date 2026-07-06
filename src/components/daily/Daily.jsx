import React, { useMemo, useState } from 'react';
import Timeline from './Timeline';
import DailyEntry from './DailyEntry';
import DailyEditor from './DailyEditor';
import { useDialog } from '../../context/DialogContext';
import EmptyState from '../ui/EmptyState';

export default function Daily({ isAdmin, posts, activeDate, onActiveDateChange, onPublish, onDelete }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const { confirm, toast } = useDialog();

  // 单日展示模式：只显示 activeDate 对应的一条；若未选中，默认展示第一条（最新一天）
  const currentPost = useMemo(() => {
    if (!posts || posts.length === 0) return null;
    const target = posts.find((p) => p.id === activeDate);
    return target || posts[0];
  }, [posts, activeDate]);

  const handleSelectDate = (id) => {
    onActiveDateChange(id);
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    const additions = files.map((file) => ({
      id: Math.random().toString(36).slice(2, 11),
      name: file.name,
      file,
      type: file.type.startsWith('image/') ? 'image' : 'video',
      url: URL.createObjectURL(file),
    }));
    setAttachments((prev) => [...prev, ...additions]);
    e.target.value = '';
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed && removed.url && removed.file) URL.revokeObjectURL(removed.url);
      return prev.filter((a) => a.id !== id);
    });
  };

  const startEdit = (post) => {
    setEditingId(post.id);
    setText(post.text || '');
    if (post.media && post.media.length > 0) {
      setAttachments(
        post.media.map((m, i) => ({
          id: `existing-${i}`,
          type: m.type,
          url: m.url,
          value: m.value,
          isExisting: true,
        }))
      );
    } else {
      setAttachments([]);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setText('');
    setAttachments([]);
  };

  const publish = async () => {
    if (!text.trim() && attachments.length === 0) return;
    setPublishing(true);
    try {
      await onPublish({ text, attachments, editingId });
      toast.success(editingId ? '已更新' : '已发布');
      cancelEdit();
    } catch (err) {
      console.error('Publish failed:', err);
      toast.error(editingId ? '更新失败' : '发布失败，请稍后重试');
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async (postId) => {
    const ok = await confirm({
      title: '删除记录',
      message: '删除后不可恢复，确定要删除这条 Daily 吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await onDelete(postId);
      toast.success('已删除');
    } catch (err) {
      console.error(err);
      toast.error('删除失败');
    }
  };

  return (
    <section id="daily" className="daily-section">
      <h2>Daily</h2>
      <div className="layout-grid">
        <Timeline posts={posts} activeDate={currentPost?.id} onSelect={handleSelectDate} />
        <main className="col-content">
          {currentPost ? (
            <DailyEntry
              key={currentPost.id}
              post={currentPost}
              isAdmin={isAdmin}
              onEdit={startEdit}
              onDelete={handleDelete}
            />
          ) : (
            <EmptyState title="暂无 Daily" description="等博主慢慢补上吧～" />
          )}
        </main>
        {isAdmin && (
          <DailyEditor
            editingId={editingId}
            text={text}
            attachments={attachments}
            publishing={publishing}
            onTextChange={setText}
            onFilesSelected={handleFileSelect}
            onRemoveAttachment={removeAttachment}
            onPublish={publish}
            onCancelEdit={cancelEdit}
          />
        )}
      </div>
    </section>
  );
}
