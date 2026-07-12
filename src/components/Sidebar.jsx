import React, { useState, useEffect } from 'react';
import { Eye } from 'lucide-react';
import { navItems } from '../data/nav';
import NowStatus from './NowStatus';

export default function Sidebar({ isAdmin, adminToken, viewCount, onRequestLogin, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('about');

  const closeMenu = () => setMenuOpen(false);

  // Intersection Observer for scroll spy
  useEffect(() => {
    const observers = [];

    // Set up observer for each section
    navItems.forEach(item => {
      const element = document.getElementById(item.id);
      if (!element) return;

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            // When a section comes into view, set it as active
            // We use a threshold of 0.2 (20% visible) to trigger early
            if (entry.isIntersecting) {
              setActiveSection(item.id);
            }
          });
        },
        { rootMargin: '-10% 0px -80% 0px', threshold: 0.1 }
      );

      observer.observe(element);
      observers.push({ element, observer });
    });

    return () => {
      observers.forEach(({ element, observer }) => {
        observer.unobserve(element);
      });
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
          周杰 / Dylan
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
          <div className="mobile-nav-brand">周杰 / Dylan</div>
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
          <button type="button" onClick={() => { closeMenu(); onLogout(); }} style={logoutBtnStyle}>
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
          周杰 / Dylan
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
                // Smooth scroll via JS to prevent URL hash change jumping immediately
                e.preventDefault();
                const target = document.getElementById(item.id);
                if (target) {
                  target.scrollIntoView({ behavior: 'smooth' });
                  setActiveSection(item.id);
                  // Update URL hash without jumping
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
