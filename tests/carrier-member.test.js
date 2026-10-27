import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { MemberSessions } from '../carrier/auth.mjs';
import { createMemberCarrier, mountMemberCarrier } from '../carrier/member.mjs';

const ORIGIN = 'http://localhost:59844', OWNER = 'http://127.0.0.1:59844';
const TOKEN = 'a'.repeat(43), CSRF = 'b'.repeat(43);
const USER = { id: `usr_${'c'.repeat(32)}`, role: 'member', disabled: false, displayName: '</script><script>bad()</script>' };
const GRAPH = Object.freeze({
  rev: 'rev-9',
  entries: Object.freeze([
    { id: '@deepseek-ai/dsh-client-ui-shell', url: 'plugins/??dsh-client-ui-shell/client.js&rev=9', rev: '9' },
    { id: '@deepseek-ai/dsh-client-ui-chat', url: 'plugins/??dsh-client-ui-chat/client.js&rev=9', rev: '9' },
  ]),
  batches: Object.freeze([
    { phase: 'bootstrap', url: 'plugins/??dsh-client-ui-shell/client.js&rev=9', rev: '9', entries: ['@deepseek-ai/dsh-client-ui-shell'] },
    { phase: 'application', url: 'plugins/??dsh-client-ui-chat/client.js&rev=9', rev: '9', entries: ['@deepseek-ai/dsh-client-ui-chat'] },
  ]),
});
const OWNER_ROWS = [
  { kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: { type: 'baseline', owner: true } },
  { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__={mode:"queue"};' },
  { kind: 'script-preload', placement: 'head', src: 'plugins/??dsh-client-ui-chat/client.js&rev=1' },
  { kind: 'global', name: '__DSH_BOOT__', value: { rev: 'rev-1', entries: [{ id: 'owner-only' }], batches: [] } },
];

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-carrier-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><base href="./"><script type="module" src="./assets/app.js"></script></head><body><div id="root"></div></body></html>');
  await writeFile(join(root, 'assets/app.js'), 'export const originalShell = true;');
  const calls = [], peers = [], registrations = [], actions = [], bundles = [], dispatches = [], channels = [];
  let disabled = false, peerCreates = 0;
  const user = { ...USER, ...options.user };
  const core = { async execute(args, caller) {
    calls.push({ args, caller });
    if (args.action === 'login' || args.action === 'redeem') return { token: TOKEN, csrf: CSRF, user: { ...user } };
    if (args.action === 'me') { if (disabled) throw new Error('revoked'); return { user: { ...user } }; }
    if (args.action === 'logout') return { ok: true };
    throw new Error('unexpected core action');
  } };
  const auth = new MemberSessions({ core, origin: ORIGIN, ownerOrigin: OWNER });
  const streams = [];
  const ctx = {
    webServer: {
      getOrigin: () => OWNER,
      collectIndexInjections: () => OWNER_ROWS,
      applyIndexTaps: html => html,
      register(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
      registerUpgrade(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
    },
    connection: {
      createSharedFetchHandler(channel) {
        channels.push(channel);
        return {
          requestBodyMode: ({ url }) => url.pathname === '/api/session/uploadFileBinary' ? 'streaming' : 'buffered',
          async fetch(request, peer) {
            const body = request.body === null ? null : await request.clone().text();
            dispatches.push({ request, peer, body });
            if (request.url.endsWith('/api/session/list')) return new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value: { sessions: [] } } }), { headers: { 'content-type': 'application/json' } });
            return new Response('forbidden', { status: 403 });
          },
        };
      },
      createPeer({ principal, interactions }) {
        peerCreates++;
        const control = new AbortController();
        const peer = { principal, interactions, signal: control.signal, async dispose() { control.abort(); } };
        peers.push(peer); return peer;
      },
    },
    remoteAccess: {
      invalidate() { calls.push({ invalidated: true }); },
      snapshotFor(principal) { assert.equal(principal.kind, 'lan-member'); return { type: 'baseline', owner: false, grants: [] }; },
    },
    clientModules: { graph: () => GRAPH, async fetchBundle(request) { bundles.push(request.url); return new Response('original bundle'); } },
    typertGateway: {
      wireStream: {
        async *open(endpoint, payload, uplink, peer, signal) { streams.push({ endpoint, payload, uplink, peer, signal }); yield { type: 'member-frame' }; },
        failure() { return { code: 'gateway/forbidden', message: 'Member stream refused.', details: {} }; },
      },
    },
  };
  const onAction = async input => { actions.push(input); return new Response('facade', { headers: { 'content-type': 'text/plain' } }); };
  const carrier = await createMemberCarrier(ctx, { auth, frontendDist: root, memberOrigin: ORIGIN, onAction, ...options });
  t.after(async () => { await carrier.close(); await auth.close(); await rm(root, { recursive: true, force: true }); });
  let cookie;
  const headers = { host: 'localhost:59844', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  function request(path, init = {}) { return new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(cookie ? { cookie } : {}), ...init.headers } }); }
  return { carrier, auth, ctx, root, calls, peers, registrations, actions, bundles, dispatches, channels, streams, headers, request,
    disable() { disabled = true; }, get peerCreates() { return peerCreates; },
    async login() {
      const response = await carrier.handle(request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', username: 'member', password: 'password-value' }) }));
      assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; return response;
    },
  };
}

test('unauthenticated member root serves only login bootstrap, not owner GUI or token', async t => {
  const f = await fixture(t);
  const response = await f.carrier.handle(f.request('/lan/'));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Service sign in/);
  assert.match(text, /data-member-login/); assert.match(text, /<style>/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
  assert.doesNotMatch(text, /__DSH_BOOT__|ownerToken|type="module"/);
  const ownerCookie = await f.carrier.handle(f.request('/lan/api/session/list', { headers: { cookie: 'dsh_session=stock-owner-cookie' } }));
  assert.equal(ownerCookie.status, 401);
  assert.equal(f.peerCreates, 0);
  assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.channels, ['/api']);
});

test('every unauthenticated member index serves self-contained Chinese login with exact script/style CSP hashes', async t => {
  const f = await fixture(t);
  for (const route of ['/lan/', '/lan/index.html']) {
    const response = await f.carrier.handle(f.request(route)), html = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.equal(styles.length, 1); assert.equal(scripts.length, 1);
    const csp = response.headers.get('content-security-policy'), digest = value => createHash('sha256').update(value).digest('base64');
    const directives = new Map(csp.split(';').map(part => { const [name, ...values] = part.trim().split(/\s+/); return [name, values]; }));
    assert.deepEqual(directives.get('default-src'), ["'none'"]); assert.deepEqual(directives.get('connect-src'), ["'self'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'self'", 'http://127.0.0.1:*', 'http://localhost:*']); assert.deepEqual(directives.get('form-action'), ["'self'"]); assert.deepEqual(directives.get('base-uri'), ["'self'"]);
    assert.deepEqual(directives.get('script-src'), [`'sha256-${digest(scripts[0])}'`]); assert.deepEqual(directives.get('style-src'), [`'sha256-${digest(styles[0])}'`]);
    const embedding = directives.get('frame-ancestors').join(' ');
    assert.match(csp, /img-src data: http: https:;/);
    assert.doesNotMatch(csp.replace(`frame-ancestors ${embedding}`, '').replace(/img-src [^;]+/, ''), /unsafe-inline|unsafe-eval|data:|https?:|\*/);
    assert.match(html, /<html lang="zh-CN">/); assert.match(html, /<h1 data-copy="title">登录多用户服务<\/h1>/);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(html, /<form id="member-auth-form" method="post" action="\/lan\/auth"/);
    assert.match(styles[0], /font-family:[^;]*system[^;]*Segoe UI/); assert.match(styles[0], /width:min\(100% - 48px,400px\)/); assert.match(styles[0], /prefers-color-scheme:dark/);
    assert.doesNotMatch(html, /<link\b|<iframe\b|<script[^>]*\bsrc=|<img\b|<a\b|__DSH_BOOT__|__DSH_REMOTE_ACCESS__|__DSH_LAN_MEMBER__|ownerToken|window\.open/);
    assert.doesNotMatch(html, new RegExp(TOKEN + '|' + CSRF));
    assert.equal(response.headers.get('cache-control'), 'no-store, private'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(f.peerCreates, 0); assert.equal(f.calls.length, 0); assert.equal(f.bundles.length, 0); assert.equal(f.dispatches.length, 0);
});

test('legacy administrator URLs lead to the common entry without elevating a member; legacy auth remains role guarded', async t => {
  const f = await fixture(t);
  let response = await f.carrier.handle(f.request('/lan/admin/'));
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/lan/');
  response = await f.carrier.handle(f.request('/lan/admin/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', username: 'member', password: 'password-value' }) }));
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'ADMINISTRATOR_REQUIRED');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(f.auth.sessions.size, 0);
  assert.ok(f.calls.some(row => row.args.action === 'logout'), 'the rejected role must not keep its newly minted session');
  await f.login(); response = await f.carrier.handle(f.request('/lan/admin/'));
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/lan/');
  const html = await (await f.carrier.handle(f.request('/lan/?role=admin&owner=true'))).text();
  assert.match(html, /"role":"member"/); assert.match(html, /"owner":false/); assert.doesNotMatch(html, /"adminEntry":true/);
  response = await f.carrier.handle(f.request('/lan/admin/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'redeem', inviteToken: 'forbidden' }) }));
  assert.equal(response.status, 403);
});

test('administrator sign-in reuses the guarded DSH shell without owner authority and retains origin and logout guards', async t => {
  const f = await fixture(t, { user: { role: 'admin' } });
  const fields = JSON.stringify({ action: 'login', username: 'administrator', password: 'password-value' });
  assert.equal((await f.carrier.handle(f.request('/lan/admin/auth', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: fields }))).status, 403);
  const login = await f.carrier.handle(f.request('/lan/admin/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: fields }));
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const redirect = await f.carrier.handle(f.request('/lan/admin/', { headers: { cookie } }));
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/lan/');
  const response = await f.carrier.handle(f.request('/lan/', { headers: { cookie } }));
  const html = await response.text(); assert.equal(response.status, 200); assert.match(html, /"role":"admin"/); assert.match(html, /"owner":false/); assert.match(html, /__DSH_LAN_MEMBER__/);
  const logout = await f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: JSON.stringify({ action: 'logout' }) }));
  assert.equal(logout.status, 200);
  const after = await f.carrier.handle(f.request('/lan/', { headers: { cookie } })); assert.match(await after.text(), /Service sign in/);
});

test('service administrators cannot disable authentication through bundle, component or removal APIs; optional plugins still forward', async t => {
  const f = await fixture(t, { user: { role: 'admin' } }); await f.login();
  const packageName = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name;
  f.ctx.pluginManager = {
    listBundles: async () => [{ name: packageName, rows: [{ moduleName: packageName }] }, { name: 'dsh-office', rows: [{ moduleName: 'dsh-office' }] }],
    listPlugins: async () => [{ entryId: 'include:multi-user-service', moduleName: packageName }, { entryId: 'include:office', moduleName: 'dsh-office' }],
  };
  const invoke = (method, args) => f.carrier.handle(f.request('/lan/api/pluginManager/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: JSON.stringify({ type: 'client-request', rpcId: 'protected-plugin', method: 'pluginManager/' + method, payload: { args } }) }));
  const initial = f.dispatches.length;
  for (const [method, args] of [['setBundleEnabled', { name: packageName, enabled: false }], ['setPluginEnabled', { id: 'include:multi-user-service', enabled: false }], ['removeBundle', { name: packageName }]]) {
    const result = await invoke(method, args); assert.equal(result.status, 403); assert.equal((await result.json()).error.code, 'SECURITY_PLUGIN_REQUIRED');
  }
  assert.equal(f.dispatches.length, initial, 'refused mutations never reach the native owner API');
  await invoke('setBundleEnabled', { name: 'dsh-office', enabled: false });
  assert.equal(f.dispatches.length, initial + 1); assert.equal(f.dispatches.at(-1).peer.principal.kind, 'owner');
});

test('a normal service account cannot obtain plugin management by using an administrator URL or role hints', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.carrier.handle(f.request('/lan/api/pluginManager/removeBundle?role=admin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: JSON.stringify({ type: 'client-request', method: 'pluginManager/removeBundle', payload: { args: { name: 'dsh-office' } } }) }));
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'MEMBER_PLUGIN_MANAGEMENT_DENIED');
  assert.equal(f.dispatches.length, 0);
});

test('login bootstrap has explicit invitation mode, safe remember storage and same-service return', async t => {
  const f = await fixture(t), html = await (await f.carrier.handle(f.request('/lan/'))).text();
  assert.equal((html.match(/<button[^>]*role="tab"/g) || []).length, 2);
  assert.match(html, /data-mode="login" aria-selected="true"/); assert.match(html, /data-mode="redeem" aria-selected="false"/);
  assert.match(html, /<div class="invitation" hidden>/);
  for (const name of ['inviteToken', 'displayName']) {
    const tag = html.match(new RegExp('<input name="' + name + '"[^>]*>'))[0]; assert.match(tag, /\bdisabled\b/); assert.doesNotMatch(tag, /\brequired\b/);
  }
  assert.match(html, /name="username" autocomplete="username" required maxlength="64"/);
  assert.match(html, /name="password" type="password" autocomplete="current-password" required maxlength="1024"/);
  assert.match(html, /type="checkbox" name="remember" checked/); assert.match(html, /保持登录（30 天）/);
  assert.match(html, /管理员和成员使用同一入口/); assert.match(html, /管理员身份由服务端授权决定/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /invitation\.hidden = mode !== 'redeem'/); assert.match(script, /input\.disabled = mode !== 'redeem'; input\.required = mode === 'redeem'/);
  assert.match(script, /autocomplete = mode === 'redeem' \? 'new-password' : 'current-password'/);
  assert.match(script, /fieldset\.disabled = true/); assert.match(script, /if \(pending\) return/);
  assert.match(script, /status\.textContent = error\.message/); assert.doesNotMatch(script, /innerHTML|document\.cookie|sessionStorage/);
  assert.match(script, /try \{ const name = localStorage\.getItem\(key\)/);
  assert.match(script, /key = 'lan-workspace\.member\.username'/); assert.match(script, /localStorage\.setItem\(key, form\.elements\.username\.value\.trim\(\)\)/);
  assert.match(script, /fetch\('\/lan\/auth',\{method:'POST'/); assert.match(script, /location\.replace\('\/lan\/'\)/);
  assert.doesNotMatch(script, /location\.(?:href|assign)|fetch\(['"]https?:/);
});

test('unauthenticated HEAD and canonical member redirect never emit login credentials or create peers', async t => {
  const f = await fixture(t);
  const redirect = await f.carrier.handle(f.request('/lan'));
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/lan/'); assert.equal(redirect.headers.get('set-cookie'), null);
  for (const route of ['/lan/', '/lan/index.html']) {
    const head = await f.carrier.handle(f.request(route, { method: 'HEAD' })); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.match(head.headers.get('content-security-policy'), /style-src 'sha256-/); assert.equal(head.headers.get('set-cookie'), null);
  }
  const formFallback = await f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=member&password=not-for-query' }));
  assert.equal(formFallback.status, 415); assert.doesNotMatch(await formFallback.text(), /not-for-query/);
  assert.equal(f.peerCreates, 0); assert.equal(f.calls.length, 0);
});

test('exact authority, Origin, no URL credential and separate hostname fail closed', async t => {
  const f = await fixture(t); await f.login();
  for (const headers of [{ host: '127.0.0.1:59844' }, { host: 'localhost:59844.evil' }, { origin: OWNER }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.carrier.handle(f.request('/lan/', { headers }))).status, 403);
  }
  assert.equal((await f.carrier.handle(f.request('/lan/?token=owner-launch-token'))).status, 403);
  assert.equal((await f.carrier.handle(f.request('/lan/?csrf=query-secret'))).status, 403);
  await assert.rejects(createMemberCarrier(f.ctx, { auth: { origin: OWNER }, frontendDist: f.root, memberOrigin: OWNER }));
});

test('login permits only login/redeem, strict JSON fields, 32KiB and no token response', async t => {
  const f = await fixture(t);
  const call = body => f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await call({ action: 'bootstrap', username: 'owner' })).status, 403);
  assert.equal((await call({ action: 'login', username: 'member', password: 'x', role: 'admin' })).status, 400);
  assert.equal((await call({ action: 'login', username: 'member', password: 'x'.repeat(33000) })).status, 413);
  assert.equal((await f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status, 415);
  const login = await f.login(), text = await login.text();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(f.calls.some(c => c.args?.action === 'bootstrap'), false);
});

test('authenticated document uses the full client graph and replaces the owner boot rows', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.carrier.handle(f.request('/lan/'));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<head><base href="\/lan\/">/);
  assert.equal((html.match(/<base\b/g) ?? []).length, 1);
  assert.match(html, /type="module" src="\.\/assets\/app.js"/);
  for (const entry of GRAPH.entries) assert.ok(html.includes(entry.url), `missing ${entry.id}`);
  for (const batch of GRAPH.batches) assert.ok(html.includes(batch.url.replaceAll('&', '&amp;')), `missing ${batch.url}`);
  assert.equal((html.match(/__DSH_BOOT__/g) ?? []).length > 0, true);
  assert.equal(html.includes('owner-only'), false);
  assert.equal(html.includes('"owner":true'), false);
  assert.ok(html.lastIndexOf('"owner":false') > 0);
  assert.ok(html.indexOf('window.__DSH_LAN_MEMBER__') < html.indexOf('</head>'));
  assert.equal(html.includes(USER.displayName), false);
  assert.equal(html.includes(TOKEN), false);
  assert.match(html, /\\u003c\/script>/);
  assert.equal(f.peers[0].principal.kind, 'lan-member');
  assert.equal(f.peers[0].interactions, 'answer');
  const session = await (await f.carrier.handle(f.request('/lan/auth/session'))).json();
  assert.equal(session.result.csrf, CSRF); assert.equal(session.result.token, undefined);
});

test('member transport hook adds CSRF only on its exact same-origin mount and preserves Request headers', async t => {
  const f = await fixture(t); await f.login();
  const html = await (await f.carrier.handle(f.request('/lan/'))).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const source = scripts.map(match => match[1]).find(text => text.includes('__DSH_LAN_MEMBER__'));
  assert.ok(source);
  const sent = [], window = { fetch: async request => { sent.push(request); return new Response('ok'); }, __DSH_TRANSPORT__: { loadBundle: 'preserved' } };
  vm.runInNewContext(source, { window, Request, Response, URL, Headers, document: { baseURI: ORIGIN + '/lan/' }, location: { origin: ORIGIN } });
  assert.equal(window.__DSH_TRANSPORT__.loadBundle, 'preserved');
  assert.equal(window.__DSH_TRANSPORT__.ownsHost, undefined);
  await window.__DSH_TRANSPORT__.fetch(new Request(ORIGIN + '/lan/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json', custom: 'keep' }, body: '{}' }));
  assert.equal(sent[0].headers.get('x-lan-csrf'), CSRF); assert.equal(sent[0].headers.get('custom'), 'keep');
  assert.equal(await sent[0].text(), '{}');
  await assert.rejects(window.__DSH_TRANSPORT__.fetch(OWNER + '/api/session/prompt', { method: 'POST' }));
  await assert.rejects(window.__DSH_TRANSPORT__.fetch('/api/session/prompt', { method: 'POST' }));
  assert.equal(sent.length, 1);
  const blob = new Blob(['private upload']);
  await window.__DSH_FILE_UPLOAD__.fetch('api/session/uploadFileBinary?sessionId=owned-session&name=private.txt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob });
  assert.equal(sent.length, 2); assert.equal(new URL(sent[1].url).pathname, '/lan/api/session/uploadFileBinary');
  assert.equal(sent[1].headers.get('x-lan-csrf'), CSRF); assert.equal(await sent[1].text(), 'private upload');
  for (const path of [OWNER + '/api/session/uploadFileBinary', '/api/session/uploadFileBinary', 'api/session/prompt', 'api/session/uploadFileBinary/extra']) await assert.rejects(window.__DSH_FILE_UPLOAD__.fetch(path, { method: 'POST', body: blob }));
  assert.equal(sent.length, 2);
});

test('member RPC rewrites /lan/api to the stock /api channel with the member Peer and its CSRF', async t => {
  const f = await fixture(t); await f.login();
  assert.deepEqual(f.channels, ['/api']);
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'member-list', method: 'session/list', payload: { args: { request: {} } } });
  const response = await f.carrier.handle(f.request('/lan/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope }));
  assert.equal(response.status, 200);
  assert.equal(f.dispatches.length, 1);
  const { request, peer, body } = f.dispatches[0];
  assert.equal(new URL(request.url).pathname, '/api/session/list');
  assert.equal(request.method, 'POST'); assert.equal(body, envelope);
  assert.equal(request.headers.get('host'), null); assert.equal(request.headers.get('x-lan-csrf'), CSRF);
  assert.equal(peer.principal.kind, 'lan-member'); assert.equal(peer.principal.userId, USER.id);
  // A mutation without the member CSRF never reaches the shared channel.
  assert.equal((await f.carrier.handle(f.request('/lan/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope }))).status, 403);
  assert.equal(f.dispatches.length, 1);
  // Stock 403 from the shared handler is passed through unchanged; nothing is retried elsewhere.
  const denied = await f.carrier.handle(f.request('/lan/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope }));
  assert.equal(denied.status, 403);
  assert.equal(f.dispatches.length, 2);
  // Revocation re-authenticates and aborts the cached peer.
  f.disable();
  assert.equal((await f.carrier.handle(f.request('/lan/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope }))).status, 401);
  assert.equal(f.peers[0].signal.aborted, true);
  assert.equal(f.dispatches.length, 2);
});

test('member mux wire streams delegate to the stock typert gateway and refuse after close', async t => {
  const f = await fixture(t); await f.login();
  const member = f.carrier.wireStream, { peer } = await f.carrier.admitUpgrade(f.request('/lan/api/remote.mux')), uplink = async () => {};
  assert.equal(typeof member.open, 'function'); assert.equal(typeof member.failure, 'function');
  assert.notEqual(member, f.ctx.typertGateway.wireStream);
  const frames = [];
  for await (const frame of member.open('remote.mux/event', { type: 'bind' }, uplink, peer, peer.signal)) frames.push(frame);
  assert.deepEqual(frames, [{ type: 'member-frame' }]);
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].peer, peer); assert.equal(f.streams[0].endpoint, 'remote.mux/event');
  assert.deepEqual(member.failure(Object.assign(new Error('denied'), { code: 'gateway/forbidden' })), { code: 'gateway/forbidden', message: 'Member stream refused.', details: {} });
  await f.carrier.close();
  assert.throws(() => member.open('remote.mux/event', {}, uplink, peer, peer.signal), /Member native stream is unavailable/);
});

test('dedicated action facade is exact, bounded and authenticated, not generic stock route', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.carrier.handle(f.request('/lan/api/lan-workspace', { method: 'POST', headers: { 'x-lan-csrf': CSRF, 'content-type': 'application/json' }, body: '{"action":"snapshot"}' }));
  assert.equal(await response.text(), 'facade');
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].auth.user.id, USER.id);
  assert.equal(f.actions[0].request.url, ORIGIN + '/lan/api/lan-workspace');
  assert.equal(await f.actions[0].request.text(), '{"action":"snapshot"}');
  assert.equal(f.dispatches.length, 0);
  // A suffix is not the facade: it falls through to the stock `/api` channel.
  await f.carrier.handle(f.request('/lan/api/lan-workspace/extra', { method: 'POST', headers: { 'x-lan-csrf': CSRF }, body: '{}' }));
  assert.equal(f.actions.length, 1);
  assert.equal(f.dispatches.length, 1);
  assert.equal((await f.carrier.handle(f.request('/lan/api/lan-workspace', { method: 'POST', headers: { 'x-lan-csrf': CSRF }, body: 'x'.repeat(50 * 1024) }))).status, 200);
  assert.equal((await f.carrier.handle(f.request('/lan/api/lan-workspace', { method: 'POST', headers: { 'x-lan-csrf': CSRF }, body: 'x'.repeat(180 * 1024) }))).status, 200);
  assert.equal((await f.carrier.handle(f.request('/lan/api/lan-workspace', { method: 'POST', headers: { 'x-lan-csrf': CSRF }, body: 'x'.repeat(192 * 1024 + 1) }))).status, 413);
});

test('bundles use canonical /plugins preserving query; assets are contained and HMR not provided', async t => {
  const f = await fixture(t); await f.login();
  assert.equal(await (await f.carrier.handle(f.request('/lan/plugins/p/client.js?rev=abc&x=1'))).text(), 'original bundle');
  assert.deepEqual(f.bundles, ['http://dsh.internal/plugins/p/client.js?rev=abc&x=1']);
  assert.equal(await (await f.carrier.handle(f.request('/lan/assets/app.js'))).text(), 'export const originalShell = true;');
  assert.equal((await f.carrier.handle(f.request('/lan/assets/%2e%2e%2findex.html'))).status, 400);
  assert.equal((await f.carrier.handle(f.request('/lan/package.json'))).status, 404);
  assert.equal((await f.carrier.handle(f.request('/lan/hmr'))).status, 404);
  const outside = join(f.root, '..', 'outside-' + Math.random().toString(36).slice(2) + '.js');
  await writeFile(outside, 'must not serve'); t.after(() => rm(outside, { force: true }));
  try { await symlink(outside, join(f.root, 'assets/escape.js')); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  assert.equal((await f.carrier.handle(f.request('/lan/assets/escape.js'))).status, 403);
});

test('member bundle prepends member identity source ahead of the plugin bundle', async t => {
  const f = await fixture(t); await f.login();
  const original = "__registry.register({id: '@sunbigfly/dsh-multi-user-service',nativeOwnerFactory:true});";
  f.ctx.clientModules.fetchBundle = async request => { f.bundles.push(request.url); return new Response(original, { headers: { 'content-type': 'application/javascript', etag: 'owner-etag', 'content-length': String(original.length) } }); };
  const response = await f.carrier.handle(f.request('/lan/plugins/native/client.js?rev=one')), source = await response.text();
  const memberSource = await readFile(new URL('../native-client.js', import.meta.url), 'utf8');
  assert.equal(response.status, 200); assert.ok(source.startsWith(memberSource + '\n'));
  assert.match(source, /id: '@sunbigfly\/dsh-multi-user-service\/member-client'/);
  assert.doesNotMatch(source, /class MemberSessionController|class MemberHistory|override.*ClientSessions/);
  assert.ok(source.endsWith(original)); assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('etag'), null); assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(f.bundles, ['http://dsh.internal/plugins/native/client.js?rev=one']);
});

test('WS admission uses member cookie and exact Origin, revalidates frames and closes peer on logout', async t => {
  const f = await fixture(t); await f.login();
  const admitted = await f.carrier.admitUpgrade(f.request('/lan/api/remote.mux'));
  assert.equal(admitted.peer.principal.kind, 'lan-member');
  await admitted.authenticate();
  await assert.rejects(f.carrier.admitUpgrade(f.request('/lan/api/remote.mux', { headers: { origin: OWNER } })));
  await assert.rejects(f.carrier.admitUpgrade(f.request('/lan/api/remote.mux?csrf=not-accepted')));
  assert.equal((await f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"logout"}' }))).status, 403);
  const response = await f.carrier.handle(f.request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: '{"action":"logout"}' }));
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(admitted.peer.signal.aborted, true); await assert.rejects(admitted.authenticate());
});

test('Node HTTP bridge validates raw authority/path and size before reading untrusted bodies', async t => {
  const f = await fixture(t);
  const dispose = await mountMemberCarrier(f.ctx, { auth: f.auth, frontendDist: f.root, memberOrigin: ORIGIN }, { mux: { handleUpgrade() {}, async close() {} } });
  t.after(dispose);
  const handler = f.registrations.find(route => route.kind === 'prefix').handler;
  class ResponseMock extends EventEmitter {
    chunks = []; headersSent = false;
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
    write(bytes) { this.chunks.push(Buffer.from(bytes)); return true; }
    end() { this.ended = true; }
    destroy() { this.destroyed = true; }
    text() { return Buffer.concat(this.chunks).toString(); }
  }
  async function call(url, headers = {}, rawHeaders = [], method = 'GET', content = []) {
    const req = Readable.from(content); req.url = url; req.method = method; req.headers = { ...f.headers, ...headers }; req.rawHeaders = rawHeaders;
    const res = new ResponseMock(); await handler(req, res); return res;
  }
  assert.equal((await call('/lan/')).status, 200);
  assert.equal((await call('/lan/', {}, ['Host', 'localhost:59844', 'Host', 'evil'])).status, 403);
  for (const url of ['/lan/assets/../index.html', '/lan/assets/%2e%2e/index.html', '//evil/lan/', 'http://evil/lan/']) assert.equal((await call(url)).status, 400);
  assert.equal((await call('/lan/auth', { 'content-length': '33000', 'content-type': 'application/json' }, [], 'POST')).status, 413);
  const login = await call('/lan/auth', { 'content-type': 'application/json' }, [], 'POST', [Buffer.from('{"action":"login","username":"member","password":"test"}')]);
  assert.equal(login.status, 200); assert.ok(Array.isArray(login.headers['set-cookie'])); assert.equal(login.text().includes(TOKEN), false);
});

test('mount registers the protected root, own prefix and exact upgrade, and fully disposes', async t => {
  const f = await fixture(t); let muxClosed = 0;
  await f.login();
  const dispose = await mountMemberCarrier(f.ctx, { auth: f.auth, frontendDist: f.root, memberOrigin: ORIGIN }, { mux: { handleUpgrade() {}, async close() { muxClosed++; } } });
  assert.deepEqual(f.registrations.map(({ kind, path }) => ({ kind, path })), [{ kind: 'exact', path: '/' }, { kind: 'prefix', path: '/lan' }, { kind: undefined, path: '/lan/api/remote.mux' }]);
  await dispose(); await dispose(); assert.equal(muxClosed, 1); assert.equal(f.registrations.length, 0);
  assert.ok(f.peers.every(peer => peer.signal.aborted));
});
