import React, { useCallback, useRef, useState } from 'react';
import Timeline from './Timeline';
import DailyEntry from './DailyEntry';
import DailyEditor from './DailyEditor';

export default function Daily({ isAdmin, posts, activeDate, onActiveDateChange, onPublish, onDelete }) {
  const contentRef = useRef(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [editingId, setEditingId] = useState(null);

  const scrollToPost = useCallback((id) => {
    onActiveDateChange(id);
    const el = document.getElementById(id);
    const container = contentRef.current;
    if (el && container) {
      const containerTop = container.getBoundingClientRect().top;
      const elementTop = el.getBoundingClientRect().top;
      const scrollPos = elementTop - containerTop + container.scrollTop;
      container.scrollTo({ top: scrollPos, behavior: 'smooth' });
    }
  }, [onActiveDateChange]);

  const handleScroll = () => {
    const container = contentRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    for (const post of posts) {
      const el = document.getElementById(post.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top >= containerTop - 50 && rect.top <= containerTop + 200) {
        if (activeDate !== post.id) onActiveDateChange(post.id);
        break;
      }
    }
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
    try {
      await onPublish({ text, attachments, editingId });
    } catch (err) {
      console.error('Publish failed:', err);
      return;
    }
    cancelEdit();
  };

  const handleDelete = async (postId) => {
    if (!window.confirm('确定删除这条记录吗？')) return;
    await onDelete(postId);
  };

  return (
    <section id="daily" className="daily-section">
      <h2>Daily</h2>
      <div className="layout-grid">
        <Timeline posts={posts} activeDate={activeDate} onSelect={scrollToPost} />
        <main className="col-content" ref={contentRef} onScroll={handleScroll}>
          {posts.map((post) => (
            <DailyEntry
              key={post.id}
              post={post}
              isAdmin={isAdmin}
              onEdit={startEdit}
              onDelete={handleDelete}
            />
          ))}
        </main>
        {isAdmin && (
          <DailyEditor
            editingId={editingId}
            text={text}
            attachments={attachments}
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
