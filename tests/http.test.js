import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler, AuthThrottle, MAX_BODY_BYTES } from '../http.js';

const ORIGIN = 'http://127.0.0.1:59844';
const TOKEN = 'a'.repeat(43), CSRF = 'b'.repeat(43);
function request(args = { action: 'status' }, headers = {}, options = {}) {
  return new Request('http://dsh.internal/api/lan-workspace', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(args),
    ...options,
  });
}
function fixture(options = {}) {
  const calls = [];
  const service = { async execute(args, caller) { calls.push({ args, caller }); return { accepted: true }; } };
  return { calls, handler: createRequestHandler(service, { origin: ORIGIN, ...options }) };
}
const decode = response => response.json();

test('owner carrier HTTP handler supports its synthetic DSH request URL without trusting it as Origin', async () => {
  const { handler, calls } = fixture();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { ok: true, result: { accepted: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caller.ownerBootstrap, false);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('rejects missing, foreign, null or spoofed-forwarded origins before calling core', async () => {
  const { handler, calls } = fixture();
  for (const origin of ['http://evil.example', 'null', '', 'http://dsh.internal', ORIGIN + '/']) {
    const response = await handler(request(undefined, { origin, 'x-forwarded-host': '127.0.0.1:59844' }));
    assert.equal(response.status, 403, origin);
  }
  const req = request(); req.headers.delete('origin');
  assert.equal((await handler(req)).status, 403);
  assert.equal(calls.length, 0);
});

test('rejects cross-site markers, unsupported methods and non-JSON before core', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request(undefined, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await handler(request(undefined, { 'content-type': 'text/plain' }))).status, 415);
  const get = new Request('http://dsh.internal/api/lan-workspace', { headers: { origin: ORIGIN } });
  assert.equal((await handler(get)).status, 405);
  assert.equal(calls.length, 0);
});

test('only server context, not request arguments, may carry bootstrap authority', async () => {
  const { handler, calls } = fixture();
  const args = { action: 'bootstrap', username: 'admin', displayName: 'Admin', password: 'test-password-long' };
  assert.equal((await handler(request(args))).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request(args, { 'x-lan-owner-setup': 'confirm' }))).status, 200);
  assert.equal(calls[0].caller.ownerBootstrap, true);
  assert.equal(calls[0].args.ownerBootstrap, undefined);
});

test('administrator recovery is unavailable on the Desktop bridge and requires the native owner route plus confirmation', async () => {
  const args = { action: 'owner.recoverAdministrator', username: 'admin', password: 'replacement-admin-password' }, confirm = { 'x-lan-owner-setup': 'confirm' };
  const bridge = fixture();
  assert.equal((await bridge.handler(request(args, confirm))).status, 403); assert.equal(bridge.calls.length, 0);
  const native = fixture({ allowOwnerRecovery: true });
  assert.equal((await native.handler(request(args))).status, 403);
  assert.equal((await native.handler(request(args, { ...confirm, origin: 'dsh-app://dsh' }))).status, 403);
  assert.equal((await native.handler(request(args, confirm))).status, 200);
  assert.equal(native.calls.length, 1); assert.equal(native.calls[0].caller.ownerBootstrap, true);
});

test('requires bearer auth on private actions and passes separate CSRF to core', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request({ action: 'snapshot', token: TOKEN }))).status, 401);
  for (const authorization of ['Basic x', 'Bearer short', 'Bearer ' + TOKEN + ', Bearer x']) {
    assert.equal((await handler(request({ action: 'snapshot' }, { authorization }))).status, 401);
  }
  assert.equal((await handler(request({ action: 'snapshot' }, { authorization: `Bearer ${TOKEN}`, 'x-lan-csrf': CSRF }))).status, 200);
  assert.deepEqual(calls[0].caller, { token: TOKEN, csrf: CSRF, ownerBootstrap: false });
});

test('rejects malformed CSRF header rather than ignoring it', async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ action: 'logout' }, { authorization: `Bearer ${TOKEN}`, 'x-lan-csrf': 'bad' }));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('bounds declared and streamed request bytes', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request(undefined, { 'content-length': String(MAX_BODY_BYTES + 1) }))).status, 413);
  const req = request({ action: 'status', padding: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal((await handler(req)).status, 413);
  assert.equal(calls.length, 0);
});

test('invalid UTF8, malformed JSON and array bodies fail safely', async () => {
  const { handler, calls } = fixture();
  for (const body of ['{', '[]', 'null', '"status"', new Uint8Array([0xff])]) {
    const req = request(undefined, {}, { body });
    assert.equal((await handler(req)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('unexpected backend error does not return secrets, paths or exception details', async () => {
  let logged = false;
  const secret = 'password /administrator/secret';
  const service = { execute() { throw new Error(secret); } };
  const handler = createRequestHandler(service, { origin: ORIGIN, onUnexpectedError: () => { logged = true; } });
  const response = await handler(request());
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(text.includes(secret), false);
  assert.equal(logged, true);
});

test('stable LanError is delivered with status', async () => {
  const service = { execute() { const e = new Error('No runtime'); e.name = 'LanError'; e.code = 'ISOLATION_UNAVAILABLE'; e.status = 503; throw e; } };
  const response = await createRequestHandler(service, { origin: ORIGIN })(request());
  assert.equal(response.status, 503);
  assert.equal((await decode(response)).error.code, 'ISOLATION_UNAVAILABLE');
});

test('fixed-size auth throttle resets without username/IP cache growth', () => {
  let time = 0;
  const throttle = new AuthThrottle({ now: () => time, limit: 2, windowMs: 100 });
  throttle.admit(); throttle.admit();
  assert.throws(() => throttle.admit(), e => e.code === 'AUTH_RATE_LIMIT');
  time = 100; throttle.admit();
  time = 1; throttle.admit();
});

test('read-only status does not consume sign-in attempt budget', async () => {
  const { handler, calls } = fixture();
  for (let i = 0; i < 20; i++) assert.equal((await handler(request())).status, 200);
  assert.equal(calls.length, 20);
  for (let i = 0; i < 15; i++) assert.equal((await handler(request({ action: 'login', username: 'demo', password: 'none' }))).status, 200);
  assert.equal((await handler(request({ action: 'login', username: 'demo', password: 'none' }))).status, 429);
});
