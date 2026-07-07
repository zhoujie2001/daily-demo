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
import { DialogProvider, useDialog } from './context/DialogContext';
import NetworkAlertDialog from './components/ui/NetworkAlertDialog';
import { apiUrl } from './api/client';
import { useAdminAuth } from './hooks/useAdminAuth';
import { useDiary } from './hooks/useDiary';
import { usePhotos } from './hooks/usePhotos';
import { useVideos } from './hooks/useVideos';
import { useReading } from './hooks/useReading';

function AppInner() {
  const { token, isAdmin, login, logout } = useAdminAuth();
  const { posts, activeDate, setActiveDate, publish, remove: removeDiary } = useDiary(token);
  const photosState = usePhotos(token);
  const videosState = useVideos(token);
  const readingState = useReading(token);
  const { toast } = useDialog();

  const [showLogin, setShowLogin] = useState(false);
  const [activePhoto, setActivePhoto] = useState(null);
  const [networkAlertOpen, setNetworkAlertOpen] = useState(false);
  const [networkRetrying, setNetworkRetrying] = useState(false);
  const hasShownNetworkAlertRef = useRef(false);
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
    async ({ showDialogOnFail }) => {
      setNetworkRetrying(true);
      const ok = await checkBackendReachable();
      setNetworkRetrying(false);
      if (ok) {
        setNetworkAlertOpen(false);
        return true;
      }
      if (showDialogOnFail && !hasShownNetworkAlertRef.current) {
        setNetworkAlertOpen(true);
        hasShownNetworkAlertRef.current = true;
      }
      return false;
    },
    [checkBackendReachable]
  );

  useEffect(() => {
    if (hasCheckedNetworkRef.current) return;
    hasCheckedNetworkRef.current = true;
    runBackendCheck({ showDialogOnFail: true });
  }, [runBackendCheck]);

  return (
    <div className="layout">
      <NetworkAlertDialog
        open={networkAlertOpen}
        retrying={networkRetrying}
        onClose={() => setNetworkAlertOpen(false)}
        onRetry={() => runBackendCheck({ showDialogOnFail: true })}
      />
      <AdminLogin open={showLogin} onClose={closeLogin} onLogin={handleLogin} />

      <Sidebar isAdmin={isAdmin} onRequestLogin={openLogin} onLogout={handleLogout} />

      <main className="content">
        <About isAdmin={isAdmin} onRequestLogin={openLogin} />

        <Daily
          isAdmin={isAdmin}
          posts={posts}
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

        <Links />
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
