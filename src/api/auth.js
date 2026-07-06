import { requestJson } from './client';

/**
 * 登录接口
 * 由前端表单收集用户名 + 密码后调用。
 * 严禁在源码中硬编码任何账号信息。
 */
export function login({ username, password }) {
  return requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}
