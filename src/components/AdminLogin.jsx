import React, { useState } from 'react';
import { Lock, X } from 'lucide-react';
import * as authApi from '../api/auth';

/**
 * 管理员登录弹窗。
 * 用户名 + 密码均由用户自行输入，源码中不再保留任何默认账号。
 */
export default function AdminLogin({ onClose, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const data = await authApi.login({ username, password });
      onLogin(data.token);
      onClose();
    } catch {
      setError('用户名或密码不正确');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <button onClick={onClose} style={closeBtnStyle} aria-label="close">
          <X size={18} />
        </button>
        <div style={headerStyle}>
          <div style={iconWrapperStyle}>
            <Lock size={20} color="#444" />
          </div>
          <h3 style={titleStyle}>Admin Access</h3>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={inputStyle}
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
          {error && <p style={errorStyle}>{error}</p>}
          <button
            type="submit"
            style={submitBtnStyle(isLoading)}
            disabled={isLoading || !username || !password}
          >
            {isLoading ? 'Verifying...' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};
const modalStyle = {
  background: '#fff',
  borderRadius: '12px',
  padding: '24px',
  width: '90%',
  maxWidth: '320px',
  boxShadow: '0 20px 40px rgba(0,0,0,0.1)',
  position: 'relative',
};
const closeBtnStyle = {
  position: 'absolute',
  top: '12px',
  right: '12px',
  background: 'none',
  border: 'none',
  color: '#888',
  cursor: 'pointer',
  padding: '4px',
};
const headerStyle = { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' };
const iconWrapperStyle = {
  background: '#f0f0f0',
  width: '36px',
  height: '36px',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const titleStyle = { margin: 0, fontSize: '16px', fontWeight: 600, color: '#111' };
const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #ddd',
  borderRadius: '8px',
  fontSize: '14px',
  marginBottom: '12px',
  boxSizing: 'border-box',
  outline: 'none',
};
const errorStyle = { color: '#e11d48', fontSize: '12px', margin: '-4px 0 12px 0' };
const submitBtnStyle = (isLoading) => ({
  width: '100%',
  padding: '10px',
  background: isLoading ? '#666' : '#111',
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: 500,
  cursor: isLoading ? 'wait' : 'pointer',
  transition: 'background 0.2s',
});
