import React, { useState } from 'react';
import AdminLogin from './components/AdminLogin';
import Sidebar from './components/Sidebar';
import About from './components/About';
import Reading from './components/Reading';
import Links from './components/Links';
import Lightbox from './components/Lightbox';
import Daily from './components/daily/Daily';
import Travel from './components/travel/Travel';
import Photography from './components/photography/Photography';
import { DialogProvider, useDialog } from './context/DialogContext';
import { useAdminAuth } from './hooks/useAdminAuth';
import { useDiary } from './hooks/useDiary';
import { usePhotos } from './hooks/usePhotos';
import { useVideos } from './hooks/useVideos';

function AppInner() {
  const { token, isAdmin, login, logout } = useAdminAuth();
  const { posts, activeDate, setActiveDate, publish, remove: removeDiary } = useDiary(token);
  const photosState = usePhotos(token);
  const videosState = useVideos(token);
  const { toast } = useDialog();

  const [showLogin, setShowLogin] = useState(false);
  const [activePhoto, setActivePhoto] = useState(null);

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

  return (
    <div className="layout">
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

        <Reading />

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
