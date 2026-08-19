import React, { useCallback, useEffect, useRef, useState } from 'react';
import AdminLogin from './components/AdminLogin';
import Sidebar from './components/Sidebar';
import About from './components/About';
import Reading from './components/reading/Reading';
import Links from './components/Links';
import Lightbox from './components/Lightbox';
import Daily from './components/daily/Daily';
import Travel from './components/travel/Travel';
import Photography from './components/photography/Photography';
import Song from './components/song/Song';
import { DialogProvider, useDialog } from './context/DialogContext';
import NetworkStatusNotice from './components/ui/NetworkStatusNotice';
import { apiUrl } from './api/client';
import { useAdminAuth } from './hooks/useAdminAuth';
import { useDiary } from './hooks/useDiary';
import { usePhotos } from './hooks/usePhotos';
import { useVideos } from './hooks/useVideos';
import { useReading } from './hooks/useReading';
import { useAlishaMemory } from './hooks/useAlishaMemory';
import CatPet from './components/pet/CatPet';
import BrandFooter from './components/BrandFooter';

function AppInner() {
  const { token, isAdmin, login, logout } = useAdminAuth();
  const { posts, loading: diaryLoading, activeDate, setActiveDate, publish, remove: removeDiary } = useDiary(token);
  const photosState = usePhotos(token);
  const videosState = useVideos(token);
  const readingState = useReading(token);
  const {
    memoryCue,
    openMemory: openAlishaMemory,
    dismissMemory: dismissAlishaMemory,
    forgetMemory: forgetAlishaMemory,
  } = useAlishaMemory({ posts });
  const { confirm, toast } = useDialog();

  const [showLogin, setShowLogin] = useState(false);
  const [activePhoto, setActivePhoto] = useState(null);
  const [networkNoticeOpen, setNetworkNoticeOpen] = useState(false);
  const [networkRetrying, setNetworkRetrying] = useState(false);
  const [viewCount, setViewCount] = useState(null);
  const [aboutFilmVisible, setAboutFilmVisible] = useState(true);
  const hasShownNetworkNoticeRef = useRef(false);
  const hasCheckedNetworkRef = useRef(false);

  const openLogin = () => setShowLogin(true);
  const closeLogin = () => setShowLogin(false);

  const handleLogin = (newToken) => {
    login(newToken);
    toast.success('登录成功');
  };

  const handleLogout = () => {
    logout();
    toast.info('已退出登录');
  };

  const handleOpenAlishaMemory = useCallback(() => {
    const memory = openAlishaMemory();
    if (!memory?.contentId) return;
    setActiveDate(memory.contentId);
    window.requestAnimationFrame(() => {
      document.getElementById('daily')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      });
    });
  }, [openAlishaMemory, setActiveDate]);

  const handleForgetAlishaMemory = useCallback(async () => {
    const ok = await confirm({
      title: '让阿丽莎忘记你？',
      message: '这会清除访问记录、栏目偏好和已经展示过的记忆，无法撤销。',
      confirmText: '清除记忆',
      danger: true,
    });
    if (!ok) return;
    const result = await forgetAlishaMemory();
    if (result.cloudDeleted) toast.success('阿丽莎已经忘记这些记录');
    else toast.info('本机记忆已清除，云端删除会在下次访问时重试');
  }, [confirm, forgetAlishaMemory, toast]);

  const checkBackendReachable = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(apiUrl('/api/diary'), { signal: controller.signal });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const runBackendCheck = useCallback(
    async ({ showNoticeOnFail }) => {
      setNetworkRetrying(true);
      const ok = await checkBackendReachable();
      setNetworkRetrying(false);
      if (ok) {
        setNetworkNoticeOpen(false);
        return true;
      }
      if (showNoticeOnFail && !hasShownNetworkNoticeRef.current) {
        setNetworkNoticeOpen(true);
        hasShownNetworkNoticeRef.current = true;
      }
      return false;
    },
    [checkBackendReachable]
  );

  useEffect(() => {
    let cancelled = false;

    fetch(apiUrl('/api/views'))
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled && typeof data?.count === 'number') {
          setViewCount(data.count);
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) {
          console.warn('Failed to fetch view count:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hasCheckedNetworkRef.current) return;
    hasCheckedNetworkRef.current = true;
    runBackendCheck({ showNoticeOnFail: true });
  }, [runBackendCheck]);

  return (
    <div className="layout">
      <NetworkStatusNotice
        open={networkNoticeOpen}
        retrying={networkRetrying}
        onClose={() => setNetworkNoticeOpen(false)}
        onRetry={() => runBackendCheck({ showNoticeOnFail: true })}
      />
      <AdminLogin open={showLogin} onClose={closeLogin} onLogin={handleLogin} />
      <CatPet
        suspended={aboutFilmVisible}
        memory={memoryCue}
        onOpenMemory={handleOpenAlishaMemory}
        onDismissMemory={dismissAlishaMemory}
        onForgetMemory={handleForgetAlishaMemory}
      />

      <Sidebar
        isAdmin={isAdmin}
        adminToken={token}
        viewCount={viewCount}
        onRequestLogin={openLogin}
        onLogout={handleLogout}
      />

      <main className="content">
        <About
          isAdmin={isAdmin}
          adminToken={token}
          onRequestLogin={openLogin}
          onFilmVisibilityChange={setAboutFilmVisible}
        />

        <Daily
          isAdmin={isAdmin}
          posts={posts}
          loading={diaryLoading}
          activeDate={activeDate}
          onActiveDateChange={setActiveDate}
          onPublish={publish}
          onDelete={removeDiary}
        />

        <Reading
          isAdmin={isAdmin}
          books={readingState.books}
          loading={readingState.loading}
          saving={readingState.saving}
          backendReady={readingState.backendReady}
          onSave={readingState.save}
          onDelete={readingState.remove}
        />

        <Travel
          isAdmin={isAdmin}
          videos={videosState.videos}
          loading={videosState.loading}
          uploading={videosState.uploading}
          onUpload={videosState.upload}
          onUpdate={videosState.update}
          onDelete={videosState.remove}
        />

        <Photography
          isAdmin={isAdmin}
          photos={photosState.photos}
          loading={photosState.loading}
          uploading={photosState.uploading}
          onUpload={photosState.upload}
          onUpdate={photosState.update}
          onDelete={photosState.remove}
          onOpenLightbox={setActivePhoto}
        />

        <Lightbox photo={activePhoto} onClose={() => setActivePhoto(null)} />

        <Song />

        <Links />

        <BrandFooter />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <DialogProvider>
      <AppInner />
    </DialogProvider>
  );
}
