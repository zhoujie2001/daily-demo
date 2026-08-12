import React, { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Pencil, X } from 'lucide-react';
import { siteBrand } from '../data/site';
import { loadSiteProfile, saveSiteProfile } from '../api/siteProfile';
import {
  DEFAULT_SITE_PROFILE,
  SITE_PROFILE_LIMITS,
  validateSiteProfile,
} from '../utils/siteProfile';
import { useDialog } from '../context/DialogContext';
import AboutFilm from './about/AboutFilm';

export default function About({ isAdmin, adminToken, onRequestLogin, onFilmVisibilityChange }) {
  const { toast } = useDialog();
  const [profile, setProfile] = useState(DEFAULT_SITE_PROFILE);
  const [draft, setDraft] = useState(DEFAULT_SITE_PROFILE);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [saveScope, setSaveScope] = useState('');
  const taglineRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadSiteProfile().then((result) => {
      if (cancelled) return;
      setProfile(result.profile);
      setDraft(result.profile);
      setSaveScope(result.source === 'local' ? 'local' : '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isEditing = editing && isAdmin;

  const startEditing = () => {
    setDraft(profile);
    setErrors({});
    setEditing(true);
    window.requestAnimationFrame(() => taglineRef.current?.focus());
  };

  const cancelEditing = () => {
    setDraft(profile);
    setErrors({});
    setEditing(false);
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!isAdmin || !adminToken || saving) return;

    const validation = validateSiteProfile(draft);
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      const result = await saveSiteProfile({ token: adminToken, value: validation.profile });
      setProfile(result.profile);
      setDraft(result.profile);
      setSaveScope(result.synchronized ? 'remote' : 'local');
      setEditing(false);
      if (result.synchronized) toast.success('首页简介已同步');
      else toast.info('已保存到当前设备，内容服务暂未支持简介同步');
    } catch (error) {
      if (error?.code === 'AUTH_EXPIRED') toast.error('登录已过期，请重新登录');
      else toast.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const handleEditorKeyDown = (event) => {
    if (event.key === 'Escape') cancelEditing();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  return (
    <section id="about" className="about-section about-film-section">
      <AboutFilm onVisibilityChange={onFilmVisibilityChange} />
      <div className="about-film-content">
        <h1
          onDoubleClick={() => !isAdmin && onRequestLogin()}
          style={{ cursor: isAdmin ? 'default' : 'pointer' }}
          title={!isAdmin ? '双击进入管理登录' : ''}
        >
          <span className="about-lockup-name">{siteBrand.name}</span>
          <span className="about-lockup-owner"> / {siteBrand.ownerAlias}</span>
        </h1>
        <div className={`about-profile-copy ${isEditing ? 'is-editing' : ''}`.trim()}>
          {isEditing ? (
            <form
              className="about-profile-editor"
              onSubmit={handleSave}
              onKeyDown={handleEditorKeyDown}
              aria-label="编辑首页简介"
            >
              <label className="about-profile-field">
                <span>英文简介</span>
                <textarea
                  ref={taglineRef}
                  value={draft.tagline}
                  maxLength={SITE_PROFILE_LIMITS.tagline}
                  rows={2}
                  disabled={saving}
                  aria-invalid={Boolean(errors.tagline)}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, tagline: event.target.value }));
                    setErrors((current) => ({ ...current, tagline: '' }));
                  }}
                />
                <small className={errors.tagline ? 'is-error' : ''}>
                  {errors.tagline || `${draft.tagline.length} / ${SITE_PROFILE_LIMITS.tagline}`}
                </small>
              </label>
              <label className="about-profile-field">
                <span>中文说明</span>
                <textarea
                  value={draft.intro}
                  maxLength={SITE_PROFILE_LIMITS.intro}
                  rows={2}
                  disabled={saving}
                  aria-invalid={Boolean(errors.intro)}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, intro: event.target.value }));
                    setErrors((current) => ({ ...current, intro: '' }));
                  }}
                />
                <small className={errors.intro ? 'is-error' : ''}>
                  {errors.intro || `${draft.intro.length} / ${SITE_PROFILE_LIMITS.intro}`}
                </small>
              </label>
              <div className="about-profile-editor-actions">
                <span>Esc 取消 · Ctrl/⌘ + Enter 保存</span>
                <button type="button" onClick={cancelEditing} disabled={saving}>
                  <X size={14} /> 取消
                </button>
                <button type="submit" className="is-primary" disabled={saving}>
                  {saving ? <LoaderCircle className="is-spinning" size={14} /> : <Check size={14} />}
                  {saving ? '保存中' : '保存'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="subtitle">{profile.tagline}</p>
              <p className="about-intro">{profile.intro}</p>
              {isAdmin ? (
                <button
                  type="button"
                  className="about-profile-edit-button"
                  onClick={startEditing}
                  aria-label="编辑首页简介"
                  title="编辑首页简介"
                >
                  <Pencil size={13} />
                  <span>编辑简介</span>
                </button>
              ) : null}
              {isAdmin && saveScope === 'local' ? (
                <span className="about-profile-sync-note" aria-live="polite">仅当前设备</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
