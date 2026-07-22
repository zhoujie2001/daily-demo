import React from 'react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { fallbackPhotos } from '../../data/fallbackPhotos';
import { resolveMediaUrl } from '../../utils/media';
import { useDialog } from '../../context/DialogContext';
import { LoadingSpinner } from '../ui/Loading';
import EmptyState from '../ui/EmptyState';
import SectionHeading from '../ui/SectionHeading';
import LazyImage from '../ui/LazyImage';
import PhotoCardDeck from './PhotoCardDeck';
import { SkeletonCard, SkeletonText } from '../Skeleton';

export default function Photography({
  isAdmin,
  photos,
  loading,
  uploading,
  onUpload,
  onUpdate,
  onDelete,
  onOpenLightbox,
}) {
  const { confirm, prompt, toast } = useDialog();

  const isRealData = photos.length > 0;
  const list = isRealData ? photos : fallbackPhotos;
  const showEmpty = !loading && !isRealData && !isAdmin && list.length === 0;

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await onUpload(file);
      toast.success('照片上传成功');
    } catch {
      toast.error('照片上传失败，请稍后重试');
    }
  };

  const handleCardClick = (item) => {
    onOpenLightbox({ ...item, src: resolveMediaUrl(item.url) });
  };

  const handleEdit = async (item) => {
    const result = await prompt({
      title: '编辑图片信息',
      fields: [
        { name: 'title', label: '标题', defaultValue: item.title, placeholder: '图片标题' },
        {
          name: 'desc',
          label: '描述',
          defaultValue: item.desc,
          placeholder: '图片描述',
          type: 'textarea',
        },
      ],
      confirmText: '保存',
    });
    if (!result) return;
    try {
      await onUpdate(item.id, { title: result.title, desc: result.desc });
      toast.success('已更新');
    } catch {
      toast.error('更新失败');
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: '删除照片',
      message: '删除后不可恢复，确定要删除这张照片吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await onDelete(id);
      toast.success('已删除');
    } catch {
      toast.error('删除失败');
    }
  };

  return (
    <section id="photography" className="photography-section">
      <SectionHeading
        index="04"
        title="Photography"
        description="光线落下时，替记忆按一次快门。"
        action={isAdmin ? (
            <label className={`upload-btn ${uploading ? 'disabled' : ''}`}>
              {uploading ? <LoadingSpinner size={12} /> : <Plus size={14} />}
              <span>{uploading ? 'Uploading...' : 'Upload Photo'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden-input"
                onChange={handleFile}
                disabled={uploading}
              />
            </label>
          ) : null}
      />

      <div className="photography-body">

        {loading && !isRealData ? (
          <div className="photo-skeleton-grid">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="photo-skeleton-card">
                <SkeletonCard height="auto" className="photo-skeleton-block" style={{ aspectRatio: '1 / 1', borderRadius: 20 }} />
                <div className="photo-skeleton-copy">
                  <SkeletonText width="70%" />
                  <SkeletonText width="50%" />
                </div>
              </div>
            ))}
          </div>
        ) : showEmpty ? (
          <EmptyState title="暂无照片" description="等博主慢慢补上吧～" />
        ) : (
          <>
            <PhotoCardDeck items={list} />
            <div className="photo-grid">
              {list.map((item, index) => (
                <div
                  className="photo-card"
                  key={item.id ?? `static-${index}`}
                  onClick={() => handleCardClick(item)}
                  style={{ position: 'relative' }}
                >
                  {isAdmin && isRealData ? (
                    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(item);
                        }}
                        title="Edit Photo"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        className="action-btn delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(item.id);
                        }}
                        title="Delete Photo"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : null}
                  <div className="photo-img-wrapper">
                    <LazyImage
                      src={resolveMediaUrl(item.url)}
                      alt={item.title}
                      className="photo-lazy-wrapper"
                      imgClassName="photo-lazy-img"
                      skeletonClassName="photo-lazy-skeleton"
                      errorText="照片加载失败"
                    />
                  </div>
                  <div className="photo-info" style={{ position: 'relative' }}>
                    <h3>{item.title}</h3>
                    <p>{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
