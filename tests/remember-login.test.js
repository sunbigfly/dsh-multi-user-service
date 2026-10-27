import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, MemoryStore } from '../core/service.js';
import { PersistentSessions, REMEMBER_MS, SESSION_MS } from '../core/remember-sessions.js';
import { MemberSessions } from '../carrier/auth.mjs';
import { createRequestHandler } from '../http.js';

const PASSWORD = 'remember-login-test-password';
const ORIGIN = 'http://127.0.0.1:59072';
const context = (session, audience = 'owner') => ({ token: session.token, csrf: session.csrf, audience });
async function fixture(t) {
  const accounts = new MemoryStore(), logins = new MemoryStore(); let clock = 1000;
  const create = () => new LanService({ store: accounts, now: () => clock, sessions: new PersistentSessions({ store: logins, now: () => clock }) });
  const core = create(); await core.start(); t.after(() => core.close());
  const admin = await core.execute({ action: 'bootstrap', username: 'owner', displayName: 'Owner', password: PASSWORD }, { ownerBootstrap: true, audience: 'owner' });
  return { core, admin, accounts, logins, create, advance(ms) { clock += ms; } };
}
function post(action, fields = {}, headers = {}) { return new Request('http://dsh.internal/api/lan-workspace', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...fields }) }); }

test('remembered login is hash-only durable, audience-bound and restores after core restart', async t => {
  const f = await fixture(t);
  assert.equal(f.admin.remember, true); assert.equal(f.admin.expiresAt, 1000 + REMEMBER_MS);
  const stored = JSON.stringify(await f.logins.load());
  for (const secret of [PASSWORD, f.admin.token, f.admin.csrf]) assert.equal(stored.includes(secret), false);
  assert.match((await f.logins.load()).sessions[0].tokenHash, /^[0-9a-f]{64}$/);
  await f.core.close();
  const restored = f.create(); await restored.start(); t.after(() => restored.close());
  const login = await restored.restoreLogin(f.admin.token, 'owner');
  assert.equal(login.user.id, f.admin.user.id); assert.equal(login.csrf, f.admin.csrf); assert.equal(Object.hasOwn(login, 'token'), false);
  await assert.rejects(restored.restoreLogin(f.admin.token, 'member'), { code: 'UNAUTHENTICATED' });
  await assert.rejects(restored.execute({ action: 'me' }, { token: f.admin.token }), { code: 'UNAUTHENTICATED' });
  f.advance(REMEMBER_MS); await assert.rejects(restored.restoreLogin(f.admin.token, 'owner'), { code: 'UNAUTHENTICATED' });
});

test('remember false is memory-only twelve-hour login and cookie has no persistent age', async t => {
  const f = await fixture(t);
  const current = await f.core.execute({ action: 'login', username: 'owner', password: PASSWORD, remember: false }, { audience: 'owner' });
  assert.equal(current.remember, false); assert.equal(current.expiresAt, 1000 + SESSION_MS);
  assert.equal((await f.logins.load()).sessions.length, 1);
  f.advance(SESSION_MS); await assert.rejects(f.core.restoreLogin(current.token, 'owner'), { code: 'UNAUTHENTICATED' });
  const handler = createRequestHandler(f.core, { origin: ORIGIN });
  const response = await handler(post('login', { username: 'owner', password: PASSWORD, remember: false }));
  assert.equal(response.status, 200); assert.doesNotMatch(response.headers.get('set-cookie'), /Max-Age|Expires|Domain=/i);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  await f.core.close(); const restarted = f.create(); await restarted.start(); t.after(() => restarted.close());
  assert.equal((await createRequestHandler(restarted, { origin: ORIGIN })(post('auth.restore', {}, { cookie }))).status, 401);
});

test('owner cookie login/restore is HttpOnly, same-origin, token-free and mutation still needs CSRF', async t => {
  const f = await fixture(t), handler = createRequestHandler(f.core, { origin: ORIGIN });
  const response = await handler(post('login', { username: 'owner', password: PASSWORD }));
  const result = (await response.json()).result, setCookie = response.headers.get('set-cookie'), cookie = setCookie.split(';')[0];
  assert.equal(result.cookieSession, true); assert.equal(Object.hasOwn(result, 'token'), false);
  assert.match(setCookie, /Path=\/api\/lan-workspace; HttpOnly; SameSite=Strict; Max-Age=2592000/); assert.doesNotMatch(setCookie, /Domain=/);
  assert.equal((await handler(post('auth.restore', {}, { cookie }))).status, 200);
  assert.equal((await handler(post('auth.restore', {}, { cookie, origin: 'http://evil.example' }))).status, 403);
  assert.equal((await handler(post('auth.restore', {}, { cookie: cookie + '; ' + cookie }))).status, 401);
  assert.equal((await handler(post('snapshot', {}, { cookie }))).status, 200);
  assert.equal((await handler(post('logout', {}, { cookie }))).status, 403);
  const logout = await handler(post('logout', {}, { cookie, 'x-lan-csrf': result.csrf }));
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await handler(post('auth.restore', {}, { cookie }))).status, 401);
});

test('member cookies restore after carrier/core restart and cannot authorize owner audience', async t => {
  const f = await fixture(t);
  await f.core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password: PASSWORD, routeIds: [] }, context(f.admin));
  const origin = 'http://localhost:59072', headers = { host: 'localhost:59072', origin };
  const registrations = [];
  const auth = new MemberSessions({ core: f.core, origin, ownerOrigin: ORIGIN, now: () => 1000, onLogin: caller => registrations.push(caller) });
  const signed = await auth.login('login', { username: 'member', password: PASSWORD });
  const cookie = signed.cookie.split(';')[0], token = cookie.split('=')[1];
  assert.match(signed.cookie, /Max-Age=2592000/); assert.equal(registrations[0].audience, 'member');
  await auth.close(); await f.core.close();
  const core = f.create(); await core.start(); t.after(() => core.close());
  const replacement = new MemberSessions({ core, origin, ownerOrigin: ORIGIN, now: () => 1000, onLogin: caller => registrations.push(caller) }); t.after(() => replacement.close());
  const current = await replacement.authenticate({ ...headers, cookie });
  assert.equal(current.user.username, 'member'); assert.equal(current.caller.audience, 'member'); assert.equal(registrations.length, 2);
  await assert.rejects(core.restoreLogin(token, 'owner'), { code: 'UNAUTHENTICATED' });
  assert.equal((await createRequestHandler(core, { origin: ORIGIN })(post('snapshot', {}, { cookie: 'dsh_lan_owner=' + token }))).status, 401);
});

test('logout, reset and disable durably revoke remembered sessions including after reenable/restart', async t => {
  const f = await fixture(t);
  const created = await f.core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password: PASSWORD, routeIds: [] }, context(f.admin));
  const login = () => f.core.execute({ action: 'login', username: 'member', password: PASSWORD }, { audience: 'member' });
  const first = await login();
  await updateAccount(f.core, { action: 'admin.updateUser', userId: created.user.id, disabled: true }, context(f.admin));
  await updateAccount(f.core, { action: 'admin.updateUser', userId: created.user.id, disabled: false }, context(f.admin));
  await assert.rejects(f.core.restoreLogin(first.token, 'member'), { code: 'UNAUTHENTICATED' });
  const second = await login();
  await f.core.execute({ action: 'admin.resetPassword', userId: created.user.id, password: PASSWORD }, context(f.admin));
  await assert.rejects(f.core.restoreLogin(second.token, 'member'), { code: 'UNAUTHENTICATED' });
  const third = await login(); await f.core.execute({ action: 'logout' }, context(third, 'member'));
  await f.core.close(); const restarted = f.create(); await restarted.start(); t.after(() => restarted.close());
  for (const token of [first.token, second.token, third.token]) await assert.rejects(restarted.restoreLogin(token, 'member'), { code: 'UNAUTHENTICATED' });
});

test('failed revoke remains denied and a later login cannot republish its old durable token', async t => {
  const f = await fixture(t);
  const originalSave = f.logins.save.bind(f.logins);
  f.logins.save = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.core.execute({ action: 'logout' }, context(f.admin)), { code: 'SESSION_STORAGE_FAILURE' });
  await assert.rejects(f.core.restoreLogin(f.admin.token, 'owner'), { code: 'UNAUTHENTICATED' });
  f.logins.save = originalSave;
  const replacement = await f.core.execute({ action: 'login', username: 'owner', password: PASSWORD }, { audience: 'owner' });
  assert.ok(replacement.token); await f.core.close();
  const restarted = f.create(); await restarted.start(); t.after(() => restarted.close());
  await assert.rejects(restarted.restoreLogin(f.admin.token, 'owner'), { code: 'UNAUTHENTICATED' });
});

test('session storage failure never emits a remembered cookie or silently resets saved logins', async t => {
  const f = await fixture(t), before = await f.logins.load();
  f.logins.save = async () => { throw new Error('disk unavailable'); };
  const response = await createRequestHandler(f.core, { origin: ORIGIN })(post('login', { username: 'owner', password: PASSWORD }));
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(await f.logins.load(), before);
  const bad = new PersistentSessions({ store: new MemoryStore({ version: 1, sessions: [{ token: 'plaintext-is-invalid' }] }) });
  await assert.rejects(bad.start(), { code: 'SESSION_STORAGE_INVALID' });
});
