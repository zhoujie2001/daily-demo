import { useCallback, useState } from 'react';

const TOKEN_KEY = 'adminToken';
const FLAG_KEY = 'isAdmin';

function readInitialAuth() {
  if (typeof window === 'undefined') return { token: null, isAdmin: false };
  try {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedAdmin = localStorage.getItem(FLAG_KEY) === 'true';
    if (storedAdmin && storedToken) return { token: storedToken, isAdmin: true };
  } catch {
    // localStorage 不可用时忽略
  }
  return { token: null, isAdmin: false };
}

/**
 * 管理员登录态：token 持久化到 localStorage，页面刷新自动恢复。
 */
export function useAdminAuth() {
  const [state, setState] = useState(readInitialAuth);

  const login = useCallback((newToken) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(FLAG_KEY, 'true');
    setState({ token: newToken, isAdmin: true });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(FLAG_KEY);
    setState({ token: null, isAdmin: false });
  }, []);

  return { token: state.token, isAdmin: state.isAdmin, login, logout };
}
