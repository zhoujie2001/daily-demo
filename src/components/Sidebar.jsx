import React, { useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { navItems } from '../data/nav';
import NowStatus from './NowStatus';

export default function Sidebar({ isAdmin, adminToken, viewCount, onRequestLogin, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('about');

  const closeMenu = () => setMenuOpen(false);

  const observerStateRef = useRef(new Map());

  useEffect(() => {
    const sections = navItems.map((item) => document.getElementById(item.id)).filter(Boolean);
    if (sections.length === 0) return;

    const observerState = observerStateRef.current;
    const lastSectionId = sections[sections.length - 1]?.id;
    const bottomThresholdPx = 20;

    const syncActiveFromObserverState = () => {
      const candidates = Array.from(observerState.entries())
        .map(([id, state]) => ({ id, ...state }))
        .filter((item) => item.isIntersecting);

      if (candidates.length === 0) return;

      candidates.sort((a, b) => {
        if (b.ratio !== a.ratio) return b.ratio - a.ratio;
        return a.top - b.top;
      });

      setActiveSection(candidates[0].id);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          observerState.set(entry.target.id, {
            isIntersecting: entry.isIntersecting,
            ratio: entry.intersectionRatio,
            top: entry.boundingClientRect.top,
          });
        });

        syncActiveFromObserverState();
      },
      {
        root: null,
        rootMargin: '-96px 0px -20% 0px',
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      }
    );

    sections.forEach((section) => {
      observer.observe(section);
    });

    let ticking = false;
    const updateActiveOnBottom = () => {
      const doc = document.documentElement;
      const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - bottomThresholdPx;

      if (atBottom && lastSectionId) {
        setActiveSection(lastSectionId);
      }
    };

    const onScrollOrResize = () => {
      if (ticking) return;
      ticking = true;

      window.requestAnimationFrame(() => {
        ticking = false;
        updateActiveOnBottom();
      });
    };

    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);

    updateActiveOnBottom();

    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
      observer.disconnect();
      observerState.clear();
    };
  }, []);

  return (
    <>
      <header className="mobile-header">
        <button
          type="button"
          className="mobile-header-title"
          onDoubleClick={() => !isAdmin && onRequestLogin()}
          title={!isAdmin ? 'Double click to login as admin' : ''}
        >
          四十四次日落 / Dylan
        </button>
        <button
          type="button"
          className="mobile-menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? '关闭导航' : '打开导航'}
          aria-expanded={menuOpen}
        >
          {menuOpen ? '✕' : '☰'}
        </button>
      </header>

      <div
        className={`mobile-nav-backdrop ${menuOpen ? 'open' : ''}`}
        onClick={closeMenu}
        aria-hidden={!menuOpen}
      />

      <aside className={`mobile-nav-drawer ${menuOpen ? 'open' : ''}`}>
        <div className="mobile-nav-header">
          <div className="mobile-nav-brand">四十四次日落 / Dylan</div>
          <button type="button" className="mobile-menu-toggle" onClick={closeMenu} aria-label="关闭导航">
            ✕
          </button>
        </div>
        <NowStatus isAdmin={isAdmin} adminToken={adminToken} />
        <nav className="mobile-nav-links">
          {navItems.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={activeSection === item.id ? 'active' : ''}
              onClick={(e) => {
                e.preventDefault();
                closeMenu();
                const target = document.getElementById(item.id);
                if (target) {
                  target.scrollIntoView({ behavior: 'smooth' });
                  setActiveSection(item.id);
                  window.history.pushState(null, '', `#${item.id}`);
                }
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => {
              closeMenu();
              onLogout();
            }}
            style={logoutBtnStyle}
          >
            Logout
          </button>
        ) : null}
      </aside>

      <aside className="sidebar">
        <h2
          onDoubleClick={() => !isAdmin && onRequestLogin()}
          style={{ cursor: isAdmin ? 'default' : 'pointer' }}
          title={!isAdmin ? 'Double click to login as admin' : ''}
        >
          四十四次日落 / Dylan
          {isAdmin ? (
            <span className="view-count-badge">
              <Eye size={14} />
              <span>{viewCount ?? '-'}</span>
            </span>
          ) : null}
        </h2>
        <NowStatus isAdmin={isAdmin} adminToken={adminToken} />
        <nav>
          {navItems.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={activeSection === item.id ? 'active' : ''}
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(item.id);
                if (target) {
                  target.scrollIntoView({ behavior: 'smooth' });
                  setActiveSection(item.id);
                  window.history.pushState(null, '', `#${item.id}`);
                }
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {isAdmin ? (
          <button onClick={onLogout} style={logoutBtnStyle}>
            Logout
          </button>
        ) : null}
      </aside>
    </>
  );
}

const logoutBtnStyle = {
  marginTop: '20px',
  padding: '6px 12px',
  background: '#f0f0f0',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
