import React from 'react';
import { navItems } from '../data/nav';

export default function Sidebar({ isAdmin, onRequestLogin, onLogout }) {
  return (
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
      {isAdmin && (
        <button onClick={onLogout} style={logoutBtnStyle}>
          Logout
        </button>
      )}
    </aside>
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
