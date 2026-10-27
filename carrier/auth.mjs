import { randomBytes, createHash } from 'node:crypto';
import { loginCookie, loginCookieName, readLoginCookie } from '../runtime/login-sessions.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export class MemberAuthError extends Error {
  constructor(code, message, status = 401) { super(message); this.name = 'MemberAuthError'; this.code = code; this.status = status; }
}
const reject = (code, message, status) => { throw new MemberAuthError(code, message, status); };
function cookieValue(headers, name) {
  const cookie = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie;
  if (typeof cookie !== 'string' || cookie.length > 16384) return null;
  const values = cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}
function header(headers, key) { return typeof headers.get === 'function' ? headers.get(key) : headers[key]; }

export function memberAlias(value, origin, ownerOrigin) {
  let alias;
  try { alias = new URL(value); } catch { reject('SEPARATE_ORIGIN_REQUIRED', 'Use an absolute member HTTP(S) origin.', 400); }
  const member = new URL(origin), owner = new URL(ownerOrigin);
  if (alias.origin !== value || alias.protocol !== member.protocol || alias.hostname === owner.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(alias.hostname)) reject('SEPARATE_ORIGIN_REQUIRED', 'Member aliases must be explicit network origins, separate from the owner.', 400);
  return alias;
}

/** This registry NEVER calls stock connection.admit or reads an owner token.
 * It stores the plugin's in-memory login result behind an independent opaque
 * HttpOnly cookie, and authenticates every HTTP/WS use against core again. */
export class MemberSessions {
  constructor({ core, origin, ownerOrigin, aliases = [], now = Date.now, onRevoke = async () => {}, onLogin = async () => {}, authorizeUser = () => {} }) {
    if (!core || typeof core.execute !== 'function') throw new TypeError('MemberSessions requires the live account service');
    const member = new URL(origin), owner = new URL(ownerOrigin);
    if (member.origin !== origin || owner.origin !== ownerOrigin || !['http:', 'https:'].includes(member.protocol) || member.hostname === owner.hostname) throw new MemberAuthError('SEPARATE_ORIGIN_REQUIRED', 'Member access requires a distinct hostname from the owner UI', 400);
    this.core = core; this.origin = member.origin; this.ownerOrigin = owner.origin; this.authority = member.host;
    this.origins = new Map([[member.host, member.origin]]);
    this.addAliases(aliases);
    this.secure = member.protocol === 'https:'; this.cookieName = this.secure ? '__Secure-dsh_lan_member' : 'dsh_lan_member';
    this.persistent = typeof core.restoreLogin === 'function';
    this.cookieName = loginCookieName(origin, 'member');
    this.now = now; this.onRevoke = onRevoke; this.onLogin = onLogin; this.authorizeUser = authorizeUser; this.sessions = new Map();
    this.restoring = new Map();
    this.attempts = new Map(); this.closed = false;
  }
  addAliases(values) {
    const aliases = values.map(value => memberAlias(value, this.origin, this.ownerOrigin));
    for (const alias of aliases) this.origins.set(alias.host, alias.origin);
  }
  trust(headers, { mutation = false, websocket = false } = {}) {
    if (this.closed) reject('MEMBER_SERVICE_CLOSED', 'Member access is unavailable', 503);
    const host = header(headers, 'host');
    const expected = this.origins.get(host);
    if (!expected) reject('HOST_DENIED', 'Untrusted member authority', 403);
    const origin = header(headers, 'origin');
    if ((mutation || websocket || origin != null) && origin !== expected) reject('ORIGIN_DENIED', 'Same-origin member request required', 403);
    const site = header(headers, 'sec-fetch-site');
    if (site === 'cross-site' || (mutation && site && site !== 'same-origin' && site !== 'none')) reject('ORIGIN_DENIED', 'Cross-site member request denied', 403);
  }
  cookie(value, expired = false, remember = true) {
    return loginCookie({ origin: this.origin, audience: 'member', token: value, expired, remember });
  }
  throttle(key = 'all') {
    // No arbitrary per-username/IP cardinality; fixed authority bucket.
    const now = this.now(), previous = this.attempts.get('authority');
    const bucket = !previous || now - previous.at >= 60000 || now < previous.at ? { at: now, count: 0 } : previous;
    bucket.count += 1; this.attempts.set('authority', bucket);
    if (bucket.count > 20) reject('AUTH_RATE_LIMIT', 'Too many sign-in attempts; retry later', 429);
  }
  async login(action, fields, { administratorOnly = false } = {}) {
    if (!['login', 'redeem'].includes(action)) reject('FORBIDDEN', 'Member registration requires an administrator invitation', 403);
    this.throttle();
    const allowed = action === 'login' ? ['username', 'password', 'remember'] : ['inviteToken', 'username', 'password', 'displayName', 'remember'];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !allowed.includes(key))) reject('INVALID_INPUT', 'Invalid member sign-in fields', 400);
    if (fields.remember !== undefined && typeof fields.remember !== 'boolean') reject('INVALID_INPUT', 'Invalid remember option', 400);
    const result = await this.core.execute({ ...fields, action }, this.persistent ? { audience: 'member' } : {});
    if (!TOKEN.test(result?.token) || !TOKEN.test(result?.csrf) || !result?.user?.id) reject('AUTH_SERVICE_FAILED', 'Member sign-in did not complete', 503);
    if (administratorOnly && result.user.role !== 'admin') {
      await this.core.execute({ action: 'logout' }, { token: result.token, csrf: result.csrf, ...(this.persistent ? { audience: 'member' } : {}) });
      reject('ADMINISTRATOR_REQUIRED', 'An administrator account is required.', 403);
    }
    const caller = { token: result.token, csrf: result.csrf, ...(this.persistent ? { audience: 'member' } : {}) };
    try { this.authorizeUser(result.user); await this.onLogin(caller); }
    catch (error) { try { await this.core.execute({ action: 'logout' }, caller); } catch {} throw error; }
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) await this.remove(key, session);
    if (this.sessions.size >= 1024) {
      const [key, session] = this.sessions.entries().next().value;
      await this.remove(key, session);
    }
    const credential = this.persistent ? result.token : randomBytes(32).toString('base64url');
    const remember = fields.remember ?? true;
    const session = { token: result.token, csrf: result.csrf, userId: result.user.id, expiresAt: result.expiresAt ?? now + 43200000, remember, peers: new Set() };
    this.sessions.set(hash(credential), session);
    return { cookie: this.cookie(credential, false, remember), user: result.user, csrf: session.csrf, remember, expiresAt: session.expiresAt };
  }
  async authenticate(headers, { mutation = false, websocket = false, csrf } = {}) {
    this.trust(headers, { mutation, websocket });
    const credential = cookieValue(headers, this.cookieName);
    const key = credential && hash(credential);
    let session = key && this.sessions.get(key);
    if (!session && credential && this.persistent) {
      let restoring = this.restoring.get(key);
      if (!restoring) {
        restoring = (async () => {
          const result = await this.core.restoreLogin(credential, 'member');
          if (!TOKEN.test(result?.csrf ?? '') || !result.user?.id || !Number.isSafeInteger(result.expiresAt)) reject('UNAUTHENTICATED', 'Member session expired');
          this.authorizeUser(result.user);
          const restored = { token: credential, csrf: result.csrf, userId: result.user.id, expiresAt: result.expiresAt, remember: result.remember, peers: new Set() };
          await this.onLogin({ token: credential, csrf: result.csrf, audience: 'member' });
          if (this.closed) reject('MEMBER_SERVICE_CLOSED', 'Member access is unavailable', 503);
          this.sessions.set(key, restored); return restored;
        })();
        this.restoring.set(key, restoring);
        restoring.finally(() => { if (this.restoring.get(key) === restoring) this.restoring.delete(key); }).catch(() => {});
      }
      try { session = await restoring; } catch { reject('UNAUTHENTICATED', 'Member session expired'); }
    }
    if (!session || session.expiresAt <= this.now()) { if (session) await this.remove(key, session); reject('UNAUTHENTICATED', 'Member sign-in required'); }
    try {
      const { user } = await this.core.execute({ action: 'me' }, { token: session.token, ...(this.persistent ? { audience: 'member' } : {}) });
      if (user.id !== session.userId || user.disabled) throw new Error('identity changed');
      this.authorizeUser(user);
      if (mutation && (typeof csrf !== 'string' || csrf !== session.csrf)) reject('CSRF_INVALID', 'Member CSRF verification failed', 403);
      return { session, user, key, caller: { token: session.token, csrf: session.csrf, ...(this.persistent ? { audience: 'member' } : {}) } };
    } catch (error) {
      if (error instanceof MemberAuthError && error.code === 'CSRF_INVALID') throw error;
      await this.remove(key, session);
      reject('UNAUTHENTICATED', 'Member session expired');
    }
  }
  async attachPeer(auth, peer) {
    if (this.closed || !auth?.session || this.sessions.get(auth.key) !== auth.session || auth.session.userId !== auth.user?.id || auth.session.expiresAt <= this.now() || peer?.signal?.aborted || typeof peer?.dispose !== 'function') reject('UNAUTHENTICATED', 'Member session expired');
    auth.session.peers.add(peer);
  }
  detachPeer(auth, peer) { auth.session.peers.delete(peer); }
  async remove(key, session) {
    this.sessions.delete(key);
    for (const peer of session.peers) { try { await peer.dispose(); } catch {} }
    session.peers.clear();
    try { await this.onRevoke({ token: session.token, csrf: session.csrf, ...(this.persistent ? { audience: 'member' } : {}) }); } catch {}
  }
  async logout(auth) {
    try { await this.core.execute({ action: 'logout' }, auth.caller); }
    finally { await this.remove(auth.key, auth.session); }
    return { cookie: this.cookie('', true) };
  }
  async revokeUser(userId) {
    for (const [key, session] of this.sessions) if (session.userId === userId) await this.remove(key, session);
  }
  async sweep() {
    for (const [key, session] of [...this.sessions]) {
      try {
        if (session.expiresAt <= this.now()) throw new Error('expired');
        const { user } = await this.core.execute({ action: 'me' }, { token: session.token, ...(this.persistent ? { audience: 'member' } : {}) });
        if (user.id !== session.userId || user.disabled) throw new Error('revoked');
      } catch { await this.remove(key, session); }
    }
  }
  principalValid(principal) {
    const session = principal?.kind === 'lan-member' && this.sessions.get(principal.sessionId);
    return Boolean(!this.closed && session && session.userId === principal.userId && session.expiresAt > this.now());
  }
  async close() {
    this.closed = true;
    for (const [key, session] of [...this.sessions]) await this.remove(key, session);
  }
}
