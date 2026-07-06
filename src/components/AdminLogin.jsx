import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import * as authApi from '../api/auth';
import Modal from './ui/Modal';
import Button from './ui/Button';

/**
 * 管理员登录弹窗。
 * 用户名与密码全部由用户输入，源码中不再保留任何默认账号。
 */
export default function AdminLogin({ open, onClose, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await authApi.login({ username, password });
      onLogin(data.token);
      onClose();
      setUsername('');
      setPassword('');
    } catch {
      setError('用户名或密码不正确');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              background: '#f2f2f2',
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Lock size={16} color="#444" />
          </span>
          <span>Admin Access</span>
        </div>
      }
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={loading}
            disabled={!username || !password}
            onClick={handleSubmit}
          >
            Unlock
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="ui-form">
        <div className="ui-form-item">
          <label className="ui-form-label">Username</label>
          <input
            type="text"
            className="ui-input"
            placeholder="Enter username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <div className="ui-form-item">
          <label className="ui-form-label">Password</label>
          <input
            type="password"
            className="ui-input"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p style={{ color: '#e11d48', fontSize: 12, margin: 0 }}>{error}</p>
        )}
        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  );
}
