import React, { useState } from 'react';
import { navItems } from '../data/nav';

export default function Sidebar({ isAdmin, onRequestLogin, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);

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
        <nav className="mobile-nav-links">
          {navItems.map((item) => (
            <a key={item.id} href={`#${item.id}`} onClick={closeMenu}>
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
        </h2>
        <nav>
          {navItems.map((item) => (
            <a key={item.id} href={`#${item.id}`}>
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
