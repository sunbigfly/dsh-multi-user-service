import { createHash, randomBytes } from 'node:crypto';
import { LanError } from './errors.js';
import { LoginLifetime } from './login-lifetime.js';

export const LOGIN_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MS = 12 * 60 * 60 * 1000;
const HASH = /^[0-9a-f]{64}$/;
const USER = /^usr_[0-9a-f]{32}$/;
const AUDIENCES = new Set(['owner', 'member', 'legacy']);
const hash = value => createHash('sha256').update(value).digest('hex');
const csrfFor = token => createHash('sha256').update('dsh-lan-csrf-v1\0').update(token).digest('base64url');
const fingerprint = user => hash(JSON.stringify([user.id, user.passwordSalt, user.passwordHash]));
const failure = (code, message, status = 503) => new LanError(code, message, status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function validate(document) {
  if (document === null) return { version: 1, sessions: [] };
  if (!keys(document, ['version', 'sessions']) || document.version !== 1 || !Array.isArray(document.sessions) || document.sessions.length > 4096) throw failure('SESSION_STORAGE_INVALID', 'Stored login sessions are invalid');
  const seen = new Set();
  for (const session of document.sessions) {
    if (!keys(session, ['tokenHash', 'csrfHash', 'userId', 'credentialFingerprint', 'audience', 'createdAt', 'expiresAt']) || !HASH.test(session.tokenHash) || !HASH.test(session.csrfHash) || !HASH.test(session.credentialFingerprint) || !USER.test(session.userId) || !AUDIENCES.has(session.audience) || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0 || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= session.createdAt || session.expiresAt - session.createdAt > REMEMBER_MS || seen.has(session.tokenHash)) throw failure('SESSION_STORAGE_INVALID', 'Stored login sessions are invalid');
    seen.add(session.tokenHash);
  }
  return structuredClone(document);
}

/** Private hash-only session registry. Passwords, bearer tokens and CSRF
 * plaintext never enter this store. One Host owns its durable writer. */
export class PersistentSessions {
  #lifetime;
  constructor({ store, now = Date.now, hostCapability } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof now !== 'function') throw new TypeError('PersistentSessions requires a dedicated load/save store and clock');
    this.store = store; this.now = now; this.document = null; this.transient = new Map(); this.queue = Promise.resolve(); this.closed = false;
    // Failed revocation also denies locally until a later successful retry.
    this.deniedTokens = new Set(); this.deniedUsers = new Set();
    this.#lifetime=new LoginLifetime({hostCapability,now});
  }
  _serial(operation) { const pending = this.queue.then(operation); this.queue = pending.catch(() => {}); return pending; }
  _time() { let now;try{now=this.now();}catch(error){this.#lifetime.fail();throw error;}if (!Number.isSafeInteger(now) || now < 0) {this.#lifetime.fail();throw failure('SESSION_CLOCK_INVALID', 'Login session clock is unavailable');}return now; }
  captureLogin(auth,cap){return this.#lifetime.capture(auth,cap);}
  resolveLogin(principal,cap){return this.#lifetime.resolve(principal,cap);}
  sealLogin(principal,cap){this.#lifetime.seal(principal,cap);}
  #reconcile(){this.#lifetime.reconcile([...this.document.sessions,...this.transient.values()]);}
  _ready() { if (!this.document || this.closed) throw failure('SESSION_SERVICE_UNAVAILABLE', 'Login session service is unavailable'); }
  async start() {
    return this._serial(async () => {
      if (this.closed) throw failure('SESSION_SERVICE_UNAVAILABLE', 'Login session service is unavailable');
      if (this.document) return;
      try { const loaded=validate(await this.store.load());if(this.closed)throw failure('SESSION_SERVICE_UNAVAILABLE','Login session service is unavailable');this.document=loaded; }
      catch (error) { throw error instanceof LanError ? error : failure('SESSION_STORAGE_INVALID', 'Stored login sessions are unavailable'); }
    });
  }
  async _save(document) {
    try{validate(document);}catch(error){this.#lifetime.fail();throw error;}
    try { await this.store.save(structuredClone(document)); }
    catch { this.#lifetime.fail();throw failure('SESSION_STORAGE_FAILURE', 'Login session changes could not be saved'); }
    if(this.closed)throw failure('SESSION_SERVICE_UNAVAILABLE','Login session service is unavailable');this.document = document;this.#reconcile();
  }
  async issue(user, { remember = true, audience = 'legacy' } = {}) {
    return this._serial(async () => {
      this._ready();
      if (!object(user) || !USER.test(user.id) || user.disabled || typeof user.passwordSalt !== 'string' || typeof user.passwordHash !== 'string' || typeof remember !== 'boolean' || !AUDIENCES.has(audience)) throw failure('INVALID_INPUT', 'Invalid login session request', 400);
      const token = randomBytes(32).toString('base64url'), csrf = csrfFor(token), now = this._time();this._ready();
      const session = { tokenHash: hash(token), csrfHash: hash(csrf), userId: user.id, credentialFingerprint: fingerprint(user), audience, createdAt: now, expiresAt: now + (remember ? REMEMBER_MS : SESSION_MS) };
      for (const [key, entry] of this.transient) if (entry.expiresAt <= now) {this.transient.delete(key);this.#lifetime.denyToken(key);}
      const draft = { version: 1, sessions: this.document.sessions.filter(entry => entry.expiresAt > now && !this.deniedTokens.has(entry.tokenHash) && !this.deniedUsers.has(entry.userId)) };
      const own = [...draft.sessions, ...this.transient.values()].filter(entry => entry.userId === user.id).sort((a, b) => a.createdAt - b.createdAt);
      while (own.length >= 16) { const old = own.shift(); draft.sessions = draft.sessions.filter(entry => entry.tokenHash !== old.tokenHash); if(this.transient.delete(old.tokenHash))this.#lifetime.denyToken(old.tokenHash); }
      while (draft.sessions.length + this.transient.size >= 4096) {
        const durable = draft.sessions[0], transient = this.transient.values().next().value;
        if (durable && (!transient || durable.createdAt <= transient.createdAt)) draft.sessions.shift();
        else {this.transient.delete(transient.tokenHash);this.#lifetime.denyToken(transient.tokenHash);}
      }
      if (remember) draft.sessions.push(session);
      // Persist removals before issuing either kind of replacement session.
      if (remember || JSON.stringify(draft) !== JSON.stringify(this.document)) await this._save(draft);
      this._ready();if (!remember) this.transient.set(session.tokenHash, session);
      this.deniedUsers.delete(user.id);
      return { token, csrf, remember, expiresAt: session.expiresAt };
    });
  }
  async authenticate(token, { audience = 'legacy', lookupUser } = {}) {
    return this._serial(async () => {
      this._ready();
      if (!LOGIN_TOKEN.test(token ?? '') || !AUDIENCES.has(audience) || typeof lookupUser !== 'function') throw failure('UNAUTHENTICATED', 'Sign in is required', 401);
      const tokenHash = hash(token),stamp=this.#lifetime.stamp();
      // Durable truth, not the memory cache, decides whether a token was revoked.
      try { const loaded=validate(await this.store.load());this._ready();this.document=loaded;this.#reconcile(); }
      catch { this.#lifetime.fail();throw failure('SESSION_STORAGE_INVALID', 'Stored login sessions are unavailable'); }
      this._ready();const transient = this.transient.get(tokenHash);
      const session = transient ?? this.document.sessions.find(entry => entry.tokenHash === tokenHash);
      const user = session && await lookupUser(session.userId);this._ready();
      if (!session || session.audience !== audience || session.expiresAt <= this._time() || !user || user.disabled || fingerprint(user) !== session.credentialFingerprint || this.deniedTokens.has(tokenHash) || this.deniedUsers.has(session.userId)) throw failure('UNAUTHENTICATED', 'Sign in is required', 401);
      const csrf = csrfFor(token);
      if (hash(csrf) !== session.csrfHash) throw failure('UNAUTHENTICATED', 'Sign in is required', 401);
      this._ready();const auth={ user, session: { ...structuredClone(session), remember: !transient }, tokenHash, csrf };this.#lifetime.record(auth,session,stamp);return auth;
    });
  }
  async revokeToken(token, { hashed = false } = {}) {
    return this._serial(async () => {
      this._ready();
      if (!(hashed ? HASH : LOGIN_TOKEN).test(token ?? '')) throw failure('INVALID_INPUT', 'Invalid login token', 400);
      const tokenHash = hashed ? token : hash(token); this.deniedTokens.add(tokenHash);this.#lifetime.denyToken(tokenHash);this.transient.delete(tokenHash);
      const draft = { version: 1, sessions: this.document.sessions.filter(entry => entry.tokenHash !== tokenHash) };
      await this._save(draft); this.deniedTokens.delete(tokenHash);
    });
  }
  async revokeUser(userId) {
    return this._serial(async () => {
      this._ready(); if (!USER.test(userId ?? '')) throw failure('INVALID_INPUT', 'Invalid account identity', 400);
      this.deniedUsers.add(userId);this.#lifetime.denyUser(userId);
      for (const [key, session] of this.transient) if (session.userId === userId) this.transient.delete(key);
      await this._save({ version: 1, sessions: this.document.sessions.filter(entry => entry.userId !== userId) });
      this.deniedUsers.delete(userId);
    });
  }
  async close() { this.closed=true;this.#lifetime.close();return this._serial(() => { this.closed = true; this.document = null; this.transient.clear(); this.deniedTokens.clear(); this.deniedUsers.clear(); }); }
}
