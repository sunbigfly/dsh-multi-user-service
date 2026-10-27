import { LOGIN_TOKEN, REMEMBER_MS } from '../core/remember-sessions.js';

export const OWNER_COOKIE_PATH = '/api/lan-workspace';
export const MEMBER_COOKIE_PATH = '/lan/';
export function loginCookieName(origin, audience) {
  if (!['owner', 'member'].includes(audience)) throw new TypeError('Invalid login cookie audience');
  const secure = new URL(origin).protocol === 'https:';
  return `${secure ? '__Secure-' : ''}dsh_lan_${audience}`;
}
export function readLoginCookie(headers, name) {
  const raw = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie;
  if (typeof raw !== 'string' || raw.length > 16384) return null;
  const parts = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (parts.length !== 1) return null;
  const token = parts[0].slice(name.length + 1);
  return LOGIN_TOKEN.test(token) ? token : null;
}
export function loginCookie({ origin, audience, token, remember = true, expired = false }) {
  if (!expired && (typeof token !== 'string' || !LOGIN_TOKEN.test(token))) throw new TypeError('Invalid login cookie token');
  if (typeof remember !== 'boolean') throw new TypeError('Invalid remember option');
  const secure = new URL(origin).protocol === 'https:';
  const path = audience === 'owner' ? OWNER_COOKIE_PATH : audience === 'member' ? MEMBER_COOKIE_PATH : null;
  if (!path) throw new TypeError('Invalid login cookie audience');
  return `${loginCookieName(origin, audience)}=${expired ? '' : token}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${expired ? '; Max-Age=0' : remember ? `; Max-Age=${REMEMBER_MS / 1000}` : ''}`;
}
export function publicLogin(result) {
  if (!result || !LOGIN_TOKEN.test(result.token ?? '') || !LOGIN_TOKEN.test(result.csrf ?? '') || !result.user?.id) throw new TypeError('Login service returned an invalid session');
  return { user: result.user, csrf: result.csrf, remember: result.remember ?? true, expiresAt: result.expiresAt, cookieSession: true };
}
