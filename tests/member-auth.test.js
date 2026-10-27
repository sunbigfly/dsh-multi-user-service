import test from 'node:test';
import assert from 'node:assert/strict';
import { MemberSessions } from '../carrier/auth.mjs';

const TOKEN = 'a'.repeat(43), CSRF = 'b'.repeat(43);
const MEMBER = { id: `usr_${'c'.repeat(32)}`, role: 'member', disabled: false };
function fixture(options = {}) {
  const calls = [], revoked = [], registered = [];
  let disabled = false;
  const core = { async execute(args, caller) {
    calls.push({ args, caller });
    if (args.action === 'login' || args.action === 'redeem') return { token: TOKEN, csrf: CSRF, user: MEMBER };
    if (args.action === 'me') { if (disabled) throw new Error('revoked'); return { user: MEMBER }; }
    if (args.action === 'logout') { disabled = true; return { ok: true }; }
    throw new Error('unsupported');
  } };
  const sessions = new MemberSessions({ core, origin: 'http://localhost:59844', ownerOrigin: 'http://127.0.0.1:59844', onLogin: async caller => registered.push(caller), onRevoke: async caller => revoked.push(caller), ...options });
  const headers = { host: 'localhost:59844', origin: 'http://localhost:59844', 'sec-fetch-site': 'same-origin' };
  return { sessions, headers, calls, revoked, registered, disable() { disabled = true; } };
}
async function logged(f) {
  const result = await f.sessions.login('login', { username: 'member', password: 'not forwarded elsewhere' });
  return { ...f.headers, cookie: result.cookie.split(';')[0] };
}

test('member origin must have a different hostname, not only another path or port', () => {
  const core = { execute() {} };
  for (const origin of ['http://127.0.0.1:59844', 'http://127.0.0.1:8080']) assert.throws(() => new MemberSessions({ core, origin, ownerOrigin: 'http://127.0.0.1:59844' }));
  assert.throws(() => new MemberSessions({ core, origin: 'http://localhost:59844/path', ownerOrigin: 'http://127.0.0.1:59844' }));
});

test('explicit LAN aliases preserve same-origin boundaries for HTTP and WebSocket', async () => {
  const f = fixture({ aliases: ['http://dsh.local:59844'] });
  const headers = await logged(f), alias = { ...headers, host: 'dsh.local:59844', origin: 'http://dsh.local:59844' };
  assert.equal((await f.sessions.authenticate(alias, { mutation: true, csrf: CSRF })).user.id, MEMBER.id);
  assert.equal((await f.sessions.authenticate(alias, { websocket: true })).user.id, MEMBER.id);
  await assert.rejects(f.sessions.authenticate({ ...alias, origin: headers.origin }, { mutation: true, csrf: CSRF }), e => e.code === 'ORIGIN_DENIED');
  await assert.rejects(f.sessions.authenticate({ ...headers, origin: alias.origin }, { websocket: true }), e => e.code === 'ORIGIN_DENIED');
  await assert.rejects(f.sessions.authenticate({ ...alias, host: 'unlisted.local:59844' }), e => e.code === 'HOST_DENIED');
  for (const value of ['http://127.0.0.1:59844', 'http://localhost:59844', 'https://dsh.local:59844', 'http://dsh.local:59844/path']) assert.throws(() => fixture({ aliases: [value] }));
});

test('own cookie is HttpOnly scoped and stock owner cookies cannot authorize members', async () => {
  const f = fixture();
  const login = await f.sessions.login('login', { username: 'member', password: 'local-password' });
  assert.match(login.cookie, /Path=\/lan\/; HttpOnly; SameSite=Strict;/);
  assert.equal(login.cookie.includes(TOKEN), false);
  await assert.rejects(f.sessions.authenticate({ ...f.headers, cookie: 'stock_owner_token=valid-looking-owner' }));
  const headers = { ...f.headers, cookie: login.cookie.split(';')[0] + '; stock_owner_token=owner' };
  const auth = await f.sessions.authenticate(headers, { mutation: true, csrf: CSRF });
  assert.deepEqual(auth.caller, { token: TOKEN, csrf: CSRF });
  assert.deepEqual(f.registered, [{ token: TOKEN, csrf: CSRF }]);
});

test('host, origin, WS origin and CSRF are enforced independently of cookies', async () => {
  const f = fixture(), headers = await logged(f);
  await assert.rejects(f.sessions.authenticate({ ...headers, host: 'evil.example' }), e => e.code === 'HOST_DENIED');
  await assert.rejects(f.sessions.authenticate({ ...headers, origin: 'http://127.0.0.1:59844' }), e => e.code === 'ORIGIN_DENIED');
  await assert.rejects(f.sessions.authenticate({ ...headers, origin: undefined }, { websocket: true }), e => e.code === 'ORIGIN_DENIED');
  await assert.rejects(f.sessions.authenticate(headers, { mutation: true, csrf: 'bad' }), e => e.code === 'CSRF_INVALID');
  assert.equal((await f.sessions.authenticate(headers)).user.id, MEMBER.id);
});

test('duplicate or malformed member cookies are not unioned or accepted', async () => {
  const f = fixture(), headers = await logged(f);
  await assert.rejects(f.sessions.authenticate({ ...headers, cookie: headers.cookie + '; ' + headers.cookie }));
  await assert.rejects(f.sessions.authenticate({ ...headers, cookie: 'dsh_lan_member=short' }));
});

test('disable, password-reset-style token revocation and sweep close attached peers', async () => {
  const f = fixture(), headers = await logged(f);
  const auth = await f.sessions.authenticate(headers);
  let disposed = 0;
  await f.sessions.attachPeer(auth, { dispose: async () => { disposed += 1; } });
  f.disable(); await f.sessions.sweep();
  assert.equal(disposed, 1); assert.equal(f.revoked.length, 1);
  await assert.rejects(f.sessions.authenticate(headers));
});

test('logout revokes core token and closes all peer scopes', async () => {
  const f = fixture(), headers = await logged(f);
  const auth = await f.sessions.authenticate(headers);
  let disposed = 0;
  await f.sessions.attachPeer(auth, { dispose: async () => disposed++ });
  const result = await f.sessions.logout(auth);
  assert.match(result.cookie, /Max-Age=0/);
  assert.equal(disposed, 1);
  await assert.rejects(f.sessions.authenticate(headers));
});

test('member enrollment cannot invoke bootstrap or create an administrator', async () => {
  const f = fixture();
  await assert.rejects(f.sessions.login('bootstrap', { username: 'owner' }), e => e.code === 'FORBIDDEN');
  assert.equal(f.calls.length, 0);
});

test('expiry and close reject old sessions without persistence of token material', async () => {
  let time = 100;
  const f = fixture({ now: () => time }), headers = await logged(f);
  time += 43200001;
  await assert.rejects(f.sessions.authenticate(headers));
  assert.equal(f.revoked.length, 1);
  await f.sessions.close();
  assert.throws(() => f.sessions.trust(f.headers), e => e.code === 'MEMBER_SERVICE_CLOSED');
});
