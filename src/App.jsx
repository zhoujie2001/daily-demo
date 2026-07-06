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
import { useAdminAuth } from './hooks/useAdminAuth';
import { useDiary } from './hooks/useDiary';
import { usePhotos } from './hooks/usePhotos';
import { useVideos } from './hooks/useVideos';

export default function App() {
  const { token, isAdmin, login, logout } = useAdminAuth();
  const { posts, activeDate, setActiveDate, publish, remove: removeDiary } = useDiary(token);
  const photosState = usePhotos(token);
  const videosState = useVideos(token);

  const [showLogin, setShowLogin] = useState(false);
  const [activePhoto, setActivePhoto] = useState(null);

  const openLogin = () => setShowLogin(true);
  const closeLogin = () => setShowLogin(false);

  return (
    <div className="layout">
      {showLogin && <AdminLogin onClose={closeLogin} onLogin={login} />}

      <Sidebar isAdmin={isAdmin} onRequestLogin={openLogin} onLogout={logout} />

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
          uploading={videosState.uploading}
          onUpload={videosState.upload}
          onUpdate={videosState.update}
          onDelete={videosState.remove}
        />

        <Photography
          isAdmin={isAdmin}
          photos={photosState.photos}
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
