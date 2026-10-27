import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';
import { MemberSessions } from '../carrier/auth.mjs';
import { createMemberCarrier, mountMemberCarrier } from '../carrier/member.mjs';
import { MemberOwnership, memberAccessPolicy, memberToolAllow, memberToolDenial, memberPathDenial, memberSettingsChangeAllowed, MEMBER_GLOBAL_ACTIONS, MEMBER_SESSION_ACTIONS } from '../carrier/access.mjs';
import { memberBootRows, memberClientGraph, MEMBER_BOOT_GLOBAL, MEMBER_READY_MARKUP } from '../carrier/member-boot.mjs';
import { MemberAttachmentAccess } from '../carrier/attachments.mjs';
import { nativeMemberSessions } from '../carrier/native-sessions.mjs';

const ORIGIN = 'http://localhost:59844', OWNER = 'http://127.0.0.1:59844';
const TOKEN = 'a'.repeat(43), CSRF = 'b'.repeat(43);
const USER = { id: `usr_${'c'.repeat(32)}`, role: 'member', disabled: false, displayName: 'Member' };
const OTHER = `usr_${'d'.repeat(32)}`;
const MEMBER_ROOT = `/home/${USER.id}`;

/** A stand-in for the stock `clientModules` graph: two batches, three modules. */
const GRAPH = Object.freeze({
  rev: 'rev-1',
  entries: Object.freeze([
    { id: '@deepseek-ai/dsh-client-ui-shell', url: 'plugins/??dsh-client-ui-shell/client.js&rev=1', rev: '1' },
    { id: '@deepseek-ai/dsh-client-ui-chat', url: 'plugins/??dsh-client-ui-chat/client.js&rev=1', rev: '1' },
    { id: '@sunbigfly/dsh-multi-user-service', url: 'plugins/??@sunbigfly/dsh-multi-user-service/client.js&rev=1', rev: '1' },
  ]),
  batches: Object.freeze([
    { phase: 'bootstrap', url: 'plugins/??dsh-client-ui-shell/client.js&rev=1', rev: '1', entries: ['@deepseek-ai/dsh-client-ui-shell'] },
    { phase: 'application', url: 'plugins/??dsh-client-ui-chat/client.js&rev=1', rev: '1', entries: ['@deepseek-ai/dsh-client-ui-chat', '@sunbigfly/dsh-multi-user-service'] },
  ]),
});

/** Owner-side index rows the member document must re-render, not inherit verbatim. */
const OWNER_ROWS = [
  { kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: { type: 'baseline', owner: true, grants: [] } },
  { kind: 'script', placement: 'head', text: 'globalThis.__DSH_OWNER_QUEUE__ = 1; window.__ModuleLoader__ = { mode: "queue" };' },
  { kind: 'script-preload', placement: 'head', src: 'plugins/??owner-only/client.js&rev=1' },
  { kind: 'global', name: MEMBER_BOOT_GLOBAL, value: { rev: 'rev-0', entries: [{ id: 'owner-only' }], batches: [] } },
  { kind: 'style', placement: 'head', text: '.owner-style{}' },
];

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-transport-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>owner</title><link rel="manifest" href="./manifest.webmanifest" /></head><body><div id="root"></div></body></html>');
  const channels = [], dispatches = [], peers = [], invalidations = [], registrations = [], bundles = [], actions = [];
  let peerCreates = 0;
  const core = { async execute(args) {
    if (args.action === 'login') return { token: TOKEN, csrf: CSRF, user: { ...USER, ...options.user } };
    if (args.action === 'me') return { user: { ...USER, ...options.user } };
    if (args.action === 'logout') return { ok: true };
    throw new Error('unexpected core action');
  } };
  const auth = new MemberSessions({ core, origin: ORIGIN, ownerOrigin: OWNER });
  const respond = options.respond ?? (() => new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value: {} } }), { headers: { 'content-type': 'application/json' } }));
  const ctx = {
    pluginManager: {
      listBundles: async () => [{ name: 'business-plugin', rows: [{ moduleName: 'business-plugin' }] }],
      listPlugins: async () => [{ entryId: 'include:business-plugin', moduleName: 'business-plugin' }],
    },
    get: name => name === 'attachments' ? options.attachments : name === 'subagents' ? options.subagents : undefined,
    webServer: {
      getOrigin: () => OWNER,
      collectIndexInjections: () => OWNER_ROWS,
      applyIndexTaps: html => `${html}<!--owner-taps-->`,
      register(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
      registerUpgrade(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
    },
    connection: {
      createSharedFetchHandler(channel) {
        channels.push(channel);
        return {
          requestBodyMode: ({ url }) => url.pathname === '/api/session/uploadFileBinary' ? 'streaming' : 'buffered',
          async fetch(request, peer) { dispatches.push({ request, peer, body: request.body === null ? null : await request.clone().text() }); return respond(request, peer); },
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
      invalidate(principal) { invalidations.push(principal); },
      snapshotFor(principal) { assert.equal(principal.kind, 'lan-member'); return { type: 'baseline', owner: false, grants: [] }; },
    },
    clientModules: { graph: () => GRAPH, async fetchBundle(request) { bundles.push(request.url); return new Response('bundle'); } },
    typertGateway: { wireStream: { open() { throw new Error('unexpected wire stream'); }, failure() { return { code: 'gateway/forbidden', message: 'unavailable', details: {} }; } } },
  };
  const ownership = options.ownership;
  const carrier = await createMemberCarrier(ctx, {
    auth, frontendDist: root, memberOrigin: ORIGIN,
    onAction: async input => { actions.push(input); return new Response('facade'); },
    memberRoot: options.memberRoot ?? (async () => MEMBER_ROOT),
    ownership, attachmentAccess: options.attachmentAccess, models: options.models, capabilities: options.capabilities,
    streams: options.streams, previews: options.previews, brandingSnapshot: options.brandingSnapshot,
  });
  t.after(async () => { await carrier.close(); await auth.close(); await rm(root, { recursive: true, force: true }); });
  let cookie;
  const headers = { host: 'localhost:59844', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  function request(path, init = {}) { return new Request(ORIGIN + path, { ...init, headers: { ...headers, ...(cookie ? { cookie } : {}), ...init.headers } }); }
  async function login() {
    const response = await carrier.handle(request('/lan/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', username: 'member', password: 'password-value' }) }));
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; return response;
  }
  return { carrier, auth, ctx, root, channels, dispatches, peers, invalidations, registrations, bundles, actions, request, login,
    get peerCreates() { return peerCreates; } };
}

test('LAN administrator manages native provider configuration on the Host authority with CSRF', async t => {
  const f = await fixture(t, { user: { role: 'admin' }, models: { providers() { throw Error('Administrator configuration must retain the full provider directory'); } }, respond(request) {
    const method = new URL(request.url).pathname.split('/api/')[1];
    return new Response(JSON.stringify({ result: { ok: true, value: method === 'settings/describe' ? { writable: true, namespaces: [{ ns: 'llm-provider', value: { endpoint: 'https://synthetic.invalid' } }] } : [{ provider: 'synthetic', settingsNs: 'llm-provider' }] } }), { headers: { 'content-type': 'application/json' } });
  } });
  await f.login();
  for (const method of ['llm/listConfigurableProviders', 'settings/describe', 'settings/mutate', 'credentials/describe', 'credentials/set', 'credentials/unset', 'llm/discoverModels']) {
    const response = await f.carrier.handle(f.request('/lan/api/'+method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope(method, {}) }));
    assert.equal(response.status, 200, method); assert.equal(f.dispatches.at(-1).peer.principal.kind, 'owner');
    if (method === 'settings/describe') assert.equal((await response.json()).result.value.namespaces[0].ns, 'llm-provider');
  }
  const before = f.dispatches.length;
  const rejected = await f.carrier.handle(f.request('/lan/api/credentials/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope('credentials/set', {}) }));
  assert.equal(rejected.status, 403); assert.equal(f.dispatches.length, before);
});

test('plugin inventory preserves the real Host management flag only for LAN administrators', async t => {
  for (const role of ['admin', 'member']) {
    const f = await fixture(t, { user: { role }, respond() {
      return new Response(JSON.stringify({ result: { ok: true, value: { managementAvailable: true, entries: [{ name: 'synthetic-plugin' }], agentPresets: [] } } }), { headers: { 'content-type': 'application/json' } });
    } });
    await f.login();
    const response = await f.carrier.handle(f.request('/lan/api/pluginInventory/list', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('pluginInventory/list', {}) }));
    assert.equal(response.status, 200);
    const value = (await response.json()).result.value;
    assert.deepEqual(value.entries, [{ name: 'synthetic-plugin' }]);
    assert.equal(value.managementAvailable, role === 'admin' ? true : undefined);
    assert.equal(f.dispatches.at(-1).peer.principal.kind, 'owner');
  }
  const noManager = await fixture(t, { user: { role: 'admin' } }); await noManager.login();
  const response = await noManager.carrier.handle(noManager.request('/lan/api/pluginInventory/list', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('pluginInventory/list', {}) }));
  assert.equal((await response.json()).result.value.managementAvailable, undefined, 'never invent a manageable profile when the Host has none');
});

test('native plugin management uses Host authority only for the authenticated administrator and known methods', async t => {
  const methods = ['listBundles', 'listPlugins', 'registries', 'inspect', 'setBundleEnabled', 'setPluginEnabled', 'installBundle', 'waitForInstall', 'cancelInstall', 'removeBundle'];
  for (const role of ['admin', 'member']) {
    const user = { role }, f = await fixture(t, { user }); await f.login();
    for (const method of methods) {
      const endpoint = 'pluginManager/' + method, before = f.dispatches.length;
      const args = method === 'setPluginEnabled' ? { id: 'include:business-plugin', enabled: false } : ['setBundleEnabled', 'removeBundle'].includes(method) ? { name: 'business-plugin', enabled: false } : { synthetic: method };
      const response = await f.carrier.handle(f.request('/lan/api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope(endpoint, args) }));
      assert.equal(response.status, role === 'admin' ? 200 : 403, role + ':' + method);
      if (role === 'admin') {
        assert.equal(f.dispatches.at(-1).peer.principal.kind, 'owner');
        assert.deepEqual(JSON.parse(f.dispatches.at(-1).body).payload.args, args);
      } else assert.equal(f.dispatches.length, before, 'members never dispatch plugin administration to the Host');
    }
    const before = f.dispatches.length;
    const post = (method, headers = {}) => f.carrier.handle(f.request('/lan/api/pluginManager/' + method, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: envelope('pluginManager/' + method, {}) }));
    assert.equal((await post('setBundleEnabled')).status, 403, 'administrator calls still require CSRF');
    assert.equal((await post('unknownMethod', { 'x-lan-csrf': CSRF })).status, 403);
    assert.equal(f.dispatches.length, before);
    if (role === 'admin') {
      user.role = 'member';
      assert.equal((await post('listBundles', { 'x-lan-csrf': CSRF })).status, 403, 'role is checked again after demotion');
      assert.equal(f.dispatches.length, before);
    }
  }
});

function ownershipStore(initial = { sessions: {}, projects: {} }) {
  const saved = [];
  return { saved, async load() { return structuredClone(initial); }, async save(state) { saved.push(structuredClone(state)); } };
}

test('account capability enforcement precedes HTTP dispatch and every native stream pull', async t => {
  let denied = false, opened = 0, reads = 0;
  const capabilities = { assertEndpoint(userId, endpoint) {
    assert.equal(userId, USER.id);
    if (denied && endpoint.startsWith('terminal/')) throw Object.assign(new Error('Terminal disabled'), { name: 'MemberCarrierError', code: 'MEMBER_CAPABILITY_DENIED', status: 403 });
  } };
  const f = await fixture(t, { capabilities, streams: { open() { opened++; return { async *[Symbol.asyncIterator]() { while (true) { reads++; yield { type: 'data' }; } } }; } } });
  await f.login();
  const peer = await f.carrier.admitUpgrade(f.request('/lan/api/remote.mux'));
  const stream = f.carrier.wireStream.open('terminal/attach', { args: {} }, undefined, peer.peer, peer.peer.signal)[Symbol.asyncIterator]();
  await stream.next(); assert.equal(opened, 1); assert.equal(reads, 1);
  denied = true;
  await assert.rejects(stream.next(), { code: 'MEMBER_CAPABILITY_DENIED' }); assert.equal(reads, 1);
  const response = await f.carrier.handle(f.request('/lan/api/terminal/create', { method: 'POST', headers: { 'x-lan-csrf': CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'terminal/create', payload: { args: {} } }) }));
  assert.equal(response.status, 403); assert.equal(f.dispatches.length, 0);
  assert.equal((await response.json()).error.code, 'MEMBER_CAPABILITY_DENIED');
  await stream.return();
});

test('an account without model grants cannot enqueue a native prompt', async t => {
  const f = await fixture(t, { models: { assertAvailable(userId) {
    assert.equal(userId, USER.id);
    throw Object.assign(new Error('Model access disabled'), { name: 'MemberCarrierError', code: 'MEMBER_MODEL_DENIED', status: 403 });
  } } });
  await f.login();
  const response = await f.carrier.handle(f.request('/lan/api/session/prompt', { method: 'POST', headers: { 'x-lan-csrf': CSRF, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'session/prompt', payload: { args: { request: { sessionId: 'own-session', content: [] } } } }) }));
  assert.equal(response.status, 403); assert.equal(f.dispatches.length, 0);
  assert.equal((await response.json()).error.code, 'MEMBER_MODEL_DENIED');
});

function envelope(method, args, rpcId = 'rpc-1') { return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }); }

test('member catalogs are filtered and Host provider configuration cannot be read or changed', async t => {
  const source = { groups: [{ id: 'allowed' }, { id: 'denied' }] };
  const models = {
    catalog(userId, value) { assert.equal(userId, USER.id); assert.deepEqual(value, source); return { groups: value.groups.slice(0, 1) }; },
    providers(userId, value) { assert.equal(userId, USER.id); return value.filter(row => row.id === 'allowed'); },
  };
  const f = await fixture(t, { models, respond(request) {
    const method = new URL(request.url).pathname.split('/api/')[1];
    const value = method === 'session/modelCatalog' ? source : method === 'settings/describe'
      ? { namespaces: [{ ns: 'llm-provider', value: { apiKey: 'synthetic-private-key' } }, { ns: 'mcp', value: { token: 'synthetic-secret' } }, { ns: 'ui-preview', value: { seen: true } }] }
      : [{ id: 'allowed' }, { id: 'denied' }];
    return new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value } }), { headers: { 'content-type': 'application/json' } });
  } });
  await f.login();
  const call = (method, args = {}) => f.carrier.handle(f.request('/lan/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope(method, args) }));
  assert.deepEqual((await (await call('session/modelCatalog')).json()).result.value, { groups: [{ id: 'allowed' }] });
  assert.deepEqual((await (await call('llm/listProviders')).json()).result.value, [{ id: 'allowed' }]);
  assert.deepEqual((await (await call('llm/listConfigurableProviders')).json()).result.value, [{ id: 'allowed' }]);
  const settings = await (await call('settings/describe')).json();
  assert.deepEqual(settings.result.value.namespaces, [{ ns: 'ui-preview', value: { seen: true } }]);
  assert.doesNotMatch(JSON.stringify(settings), /synthetic-private-key|synthetic-secret/);
  const before = f.dispatches.length;
  assert.equal((await call('settings/update', { ns: 'llm-provider', patch: { model: 'denied' } })).status, 403);
  assert.equal((await call('settings/mutate', { ns: 'llm-provider', mutations: [] })).status, 403);
  assert.equal((await call('llm/discoverModels', { request: { provider: 'denied' } })).status, 403);
  assert.equal(f.dispatches.length, before, 'configuration bypasses never reach Host authority');
});

test('workspace previews and change streams confine the owned wire scope, baseFile and symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lan-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mine = join(root, 'mine'), theirs = join(root, 'theirs');
  await mkdir(mine); await mkdir(theirs);
  await writeFile(join(mine, 'hello.txt'), 'hi');
  await writeFile(join(theirs, 'canary.txt'), 'synthetic');
  await symlink(theirs, join(mine, 'link'));
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'ses_preview', projectId: 'mine', cwd: mine });
  await ownership.record({ userId: OTHER, sessionId: 'ses_foreign', projectId: 'theirs', cwd: theirs });
  const opened = [];
  const f = await fixture(t, { ownership, streams: {
    open(endpoint, payload) { opened.push({ endpoint, payload }); return { async *[Symbol.asyncIterator]() { yield { type: 'snapshot' }; } }; },
  } });
  await f.login();
  const call = args => f.carrier.handle(f.request('/lan/api/workspaceFiles/readBytes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('workspaceFiles/readBytes', args),
  }));
  const own = { workspaceFileScopeId: 'ses_preview', path: 'hello.txt', options: {} };
  assert.equal((await call(own)).status, 200);
  assert.equal((await call({ ...own, options: { baseFile: 'hello.txt' } })).status, 200);
  const denied = [
    { ...own, workspaceFileScopeId: 'ses_foreign' }, { ...own, workspaceFileScopeId: undefined },
    { ...own, path: '../theirs/canary.txt' }, { ...own, path: join(theirs, 'canary.txt') },
    { ...own, path: 'link/canary.txt' }, { ...own, path: 'link\\canary.txt' },
    { ...own, path: 'canary.txt', options: { baseFile: '../theirs/canary.txt' } },
    { ...own, path: '../theirs/canary.txt', options: { baseFile: 'hello.txt' } },
  ];
  for (const args of denied) assert.equal((await call(args)).status, 403, JSON.stringify(args));
  assert.equal(f.dispatches.length, 2, 'denied requests never enter the native service');
  const peer = f.peers.find(item => item.principal.kind === 'lan-member');
  const watch = args => f.carrier.wireStream.open('workspaceFiles/changes', { args }, undefined, peer, peer.signal)[Symbol.asyncIterator]();
  assert.deepEqual((await watch({ ...own, path: '.' }).next()).value, { type: 'snapshot' });
  for (const args of denied) await assert.rejects(watch(args).next(), error => error.code === 'MEMBER_FILE_DENIED');
  assert.equal(opened.length, 1, 'denied streams never enter the native service');
});

test('login documents use the latest shared branding without requiring authentication', async t => {
  let branding = { name: 'First team', badge: 'TEAM', logo: null };
  const f = await fixture(t, { brandingSnapshot: () => branding });
  for (const path of ['/lan/', '/lan/admin/']) {
    let response = await f.carrier.handle(f.request(path));
    if (path === '/lan/admin/') { assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/lan/'); response = await f.carrier.handle(f.request('/lan/')); }
    assert.equal(response.status, 200); assert.match(await response.text(), /data-login-brand-name>First team/);
  }
  branding = { name: 'Updated team', badge: '', logo: null };
  const next = await f.carrier.handle(f.request('/lan/'));
  const html = await next.text(); assert.match(html, /data-login-brand-name>Updated team/); assert.doesNotMatch(html, /<small>/);
});

test('previewing another member file preserves the container session tree and confines the additional leased read root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lan-preview-container-')); t.after(() => rm(root, { recursive: true, force: true }));
  const mine = join(root, 'mine'), leased = join(root, 'leased'), unrelated = join(root, 'unrelated');
  for (const path of [mine, leased, unrelated]) { await mkdir(path); await writeFile(join(path, 'file.md'), path); }
  await symlink(unrelated, join(mine, 'escape'));
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'container-session', projectId: 'mine', cwd: mine });
  let active = true;
  const f = await fixture(t, { ownership, user: { role: 'admin' }, previews: { fileRoot: (principal, id) => active && principal?.userId === USER.id && id === 'container-session' ? leased : undefined } });
  await f.login();
  const call = path => f.carrier.handle(f.request('/lan/api/workspaceFiles/list', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('workspaceFiles/list', { workspaceFileScopeId: 'container-session', path }) }));
  assert.equal((await call(mine)).status, 200);
  assert.equal((await call(leased)).status, 200);
  assert.equal((await call(unrelated)).status, 403);
  assert.equal((await call(join(mine, 'escape/file.md'))).status, 403);
  active = false; assert.equal((await call(leased)).status, 403); assert.equal((await call(mine)).status, 200);
});

test('member RPC is rewritten from /lan/api to /api and dispatched with the member Peer', async t => {
  const f = await fixture(t); await f.login();
  assert.deepEqual(f.channels, ['/api']);
  const body = envelope('session/list', { request: {} });
  const response = await f.carrier.handle(f.request('/lan/api/session/list?revision=7', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body }));
  assert.equal(response.status, 200);
  assert.equal(f.dispatches.length, 1);
  const [{ request, peer, body: forwarded }] = f.dispatches;
  const url = new URL(request.url);
  assert.equal(url.pathname, '/api/session/list');
  assert.equal(url.search, '?revision=7');
  assert.equal(request.method, 'POST');
  assert.equal(forwarded, body);
  assert.equal(request.headers.get('host'), null);
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.equal(peer.principal.kind, 'lan-member');
  assert.equal(peer.principal.userId, USER.id);
  assert.equal(peer.interactions, 'answer');
  // One stable member Peer per authenticated member session.
  await f.carrier.handle(f.request('/lan/api/session/page', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('session/page', { request: { sessionId: 's' } }) }));
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.dispatches[1].peer, peer);
  assert.equal(f.peerCreates, 1);
  // The member transport never forwards a request without its CSRF header.
  assert.equal((await f.carrier.handle(f.request('/lan/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))).status, 403);
  assert.equal(f.dispatches.length, 2);
});

test('first-visit bootstrap claims the member directory before the native factory and retains its revocation handle', { timeout: 5000 }, async t => {
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  t.after(() => ownership.close());
  const agents = new Map(); let disposed = 0, resolveCreated, rejectCreated;
  const created = new Promise((resolve, reject) => { resolveCreated = resolve; rejectCreated = reject; });
  const registry = { list: () => [...agents.values()], get: id => agents.get(id), async create(options) {
    const agent = { id: 'ses_first_visit', session: { header: { cwd: options.meta.cwd } }, cancel() {}, async whenIdle() {} };
    agents.set(agent.id, agent);
    return { agent, async dispose() { disposed++; agents.delete(agent.id); } };
  }, async resume(options) { return this.create(options); } };
  const sessions = nativeMemberSessions({ ctx: { agents: registry }, ownership });
  t.after(() => sessions.close());
  const f = await fixture(t, { ownership, respond: async request => {
    try {
      const body = await request.json(), cwd = body.payload.args.request.cwd;
      assert.equal(ownership.bindingForCwd(cwd)?.userId, USER.id, 'recognition precedes Agent creation');
      await registry.create({ meta: { cwd } }); resolveCreated();
      return new Response(JSON.stringify({ result: { ok: true, value: { sessionId: 'ses_first_visit' } } }));
    } catch (error) { rejectCreated(error); throw error; }
  } });
  await f.login(); assert.equal((await f.carrier.handle(f.request('/lan/'))).status, 200);
  await created; for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(sessions.state.projects[0].userId, USER.id);
  assert.deepEqual(await sessions.stop('ses_first_visit'), { stopped: true });
  assert.equal(disposed, 1); assert.equal(registry.get('ses_first_visit'), undefined);
});

test('member session create is pinned into the member home and refused outside it', async t => {
  const store = ownershipStore(), ownership = await new MemberOwnership({ store }).start();
  const f = await fixture(t, { ownership, respond: () => new Response(JSON.stringify({ ok: true, result: { value: { sessionId: 'ses_owned' } } }), { headers: { 'content-type': 'application/json' } }) });
  await f.login();
  const create = cwd => f.carrier.handle(f.request('/lan/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('session/create', { request: { cwd } }) }));
  for (const cwd of ['/etc', '/home/other/workspace', `${MEMBER_ROOT}/../escape`, 'relative/path']) {
    const denied = await create(cwd);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'MEMBER_CWD_DENIED');
  }
  assert.equal(f.dispatches.length, 0);
  const accepted = await create(`${MEMBER_ROOT}/project-one/deeper`);
  assert.equal(accepted.status, 200);
  const forwarded = JSON.parse(f.dispatches[0].body);
  assert.equal(forwarded.payload.args.request.cwd, `${MEMBER_ROOT}/project-one`);
  assert.equal(JSON.parse(f.dispatches[0].body).payload.args.request.requestId, undefined);
  assert.equal(ownership.ownerOf('ses_owned'), USER.id);
  assert.deepEqual(ownership.cwdsOf(USER.id), [`${MEMBER_ROOT}/project-one`]);
  const missing = await f.carrier.handle(f.request('/lan/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('session/create', { request: {} }) }));
  assert.equal(missing.status, 200);
  assert.equal(JSON.parse(f.dispatches[1].body).payload.args.request.cwd, `${MEMBER_ROOT}/workspace`);
  assert.equal(f.invalidations.at(-1).userId, USER.id);
});

test('reusing an owned blank session applies the account preset default before native dispatch', async t => {
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'ses_blank', projectId: 'workspace', cwd: `${MEMBER_ROOT}/workspace` });
  const capabilities = { assertEndpoint() {}, async chooseAgentPreset(userId, requested) { assert.equal(userId, USER.id); assert.equal(requested, undefined); return 'ptc'; } };
  const f = await fixture(t, { ownership, capabilities }); await f.login();
  const response = await f.carrier.handle(f.request('/lan/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope('session/create', { request: { sessionId: 'ses_blank' } }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(f.dispatches[0].body).payload.args.request, { sessionId: 'ses_blank', cwd: `${MEMBER_ROOT}/workspace`, agentPreset: 'ptc' });
});

test('member session create fails closed when the request body cannot be pinned', async t => {
  const f = await fixture(t);
  await f.login();
  const post = body => f.carrier.handle(f.request('/lan/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body }));
  const cases = [
    'not json at all',
    JSON.stringify({ type: 'client-request', rpcId: 'rpc-9', method: 'session/create', payload: { args: {} } }),
    envelope('session/create', { cwd: '/etc' }),
  ];
  for (const body of cases) {
    const denied = await post(body);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'MEMBER_CREATE_DENIED');
  }
  // Nothing reached the stock gateway, so no owner-chosen directory was created.
  assert.equal(f.dispatches.length, 0);
});

test('policy bindings enumerate only the requesting principal’s recorded resources', async () => {
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'ses_mine_one', projectId: 'workspace', cwd: `${MEMBER_ROOT}/workspace` });
  await ownership.record({ userId: USER.id, sessionId: 'ses_mine_two', projectId: 'project-one', cwd: `${MEMBER_ROOT}/project-one` });
  await ownership.record({ userId: OTHER, sessionId: 'ses_theirs', projectId: 'workspace', cwd: `/home/${OTHER}/workspace` });
  const policy = memberAccessPolicy(ownership);
  const mine = policy.bindings({ kind: 'lan-member', userId: USER.id });
  const theirs = policy.bindings({ kind: 'lan-member', userId: OTHER });
  const ids = bindings => bindings.filter(binding => binding.resource.kind === 'session').map(binding => binding.resource.id).sort();
  assert.deepEqual(ids(mine), ['ses_mine_one', 'ses_mine_two']);
  assert.deepEqual(ids(theirs), ['ses_theirs']);
  for (const action of ['skills/list', 'job/list', 'job/follow', 'job/kill']) {
    assert.ok(mine.find(binding => binding.resource.id === 'ses_mine_one').role.actions.includes(action));
    assert.equal(mine.some(binding => binding.resource.kind === 'global' && binding.role.actions.includes(action)), false);
  }
  assert.deepEqual(mine.filter(binding => binding.resource.kind === 'global' && !binding.condition).map(binding => binding.resource), [{ kind: 'global' }]);
  const control = mine.find(binding => binding.role.name === 'member-subagent-control');
  const address = { parentSessionId: 'ses_mine_one', childSessionId: 'ses_mine_two', mode: 'continuable' };
  assert.equal(control.condition({ action: 'subagents/prompt', args: { request: address } }).kind, 'allow');
  assert.equal(control.condition({ action: 'subagents/interruptByParent', args: address }).kind, 'allow');
  for (const key of ['parentSessionId', 'childSessionId']) {
    assert.notEqual(control.condition({ action: 'subagents/prompt', args: { request: { ...address, [key]: 'ses_theirs' } } }).kind, 'allow');
  }
  assert.notEqual(control.condition({ action: 'subagents/prompt' }).kind, 'allow');
  const disabled = memberAccessPolicy(ownership, (_id, action) => !action.startsWith('subagents/')).bindings({ kind: 'lan-member', userId: USER.id });
  assert.equal(disabled.some(binding => binding.role.actions.includes('subagents/prompt')), false);
  assert.equal(JSON.stringify(mine).includes('ses_theirs'), false);
  assert.equal(JSON.stringify(theirs).includes('ses_mine'), false);
  assert.deepEqual(policy.bindings({ kind: 'owner', userId: OTHER }), []);
  assert.deepEqual(policy.bindings(undefined), []);
  assert.equal(policy.explain(), 'member-resource-not-owned');
});

test('large session catalogs evaluate each action once per check and immediately honor revocations', () => {
  let ids = Array.from({ length: 204 }, (_, i) => `ses_${i}`), unavailable = false;
  const blocked = new Set(), calls = new Map();
  const ownership = { sessionIdsOf: () => ids, ownerOf: id => ids.includes(id) ? USER.id : OTHER };
  const policy = memberAccessPolicy(ownership, (userId, action) => {
    assert.equal(userId, USER.id);
    calls.set(action, (calls.get(action) ?? 0) + 1);
    if (unavailable) throw Error('Account unavailable');
    return !blocked.has(action);
  });
  const principal = { kind: 'lan-member', userId: USER.id };
  for (const id of ids) {
    const bindings = policy.bindings(principal);
    assert.ok(bindings.some(binding => binding.resource.id === id && binding.role.actions.includes('workspaceFiles/list')));
  }
  assert.equal(calls.get('workspaceFiles/list'), ids.length);
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), ids.length * (MEMBER_GLOBAL_ACTIONS.length + MEMBER_SESSION_ACTIONS.length + 2));

  blocked.add('workspaceFiles/list');
  blocked.add('terminal/list');
  ids = ids.slice(1);
  const revoked = policy.bindings(principal);
  assert.equal(revoked.some(binding => binding.resource.id === 'ses_0'), false);
  assert.equal(revoked.some(binding => binding.role.actions.includes('workspaceFiles/list') || binding.role.actions.includes('terminal/list')), false);
  unavailable = true;
  assert.ok(policy.bindings(principal).every(binding => binding.role.actions.length === 0));
  unavailable = false;
  blocked.clear();
  assert.ok(policy.bindings(principal).some(binding => binding.role.actions.includes('workspaceFiles/list')));
});

test('without a lan-member policy the stock gateway denies every member resource', async () => {
  // Mirrors the documented stock `remoteAccess.decide` rule: owner and follow are
  // allowed, any other principal kind with no registered policy is denied, and a
  // registered policy allows only what one of its bindings names.
  function access() {
    const policies = new Map();
    return {
      registerPolicy(kind, policy) { policies.set(kind, policy); return () => policies.delete(kind); },
      decide({ principal, action, resources }) {
        if (principal?.kind === 'owner') return true;
        const policy = policies.get(principal?.kind);
        if (!policy) return false;
        return policy.bindings(principal).some(binding => (resources ?? [{ kind: 'global' }]).every(resource => resource.kind === binding.resource.kind && (binding.resource.kind !== 'session' || binding.resource.id === resource.id) && binding.role.actions.includes(action)));
      },
    };
  }
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'ses_mine', projectId: 'workspace', cwd: `${MEMBER_ROOT}/workspace` });
  const principal = { kind: 'lan-member', userId: USER.id };
  const before = access();
  assert.equal(before.decide({ principal, action: 'session/list', resources: [{ kind: 'global' }] }), false);
  assert.equal(before.decide({ principal, action: 'session/create', resources: [{ kind: 'global' }] }), false);
  const after = access();
  const remove = after.registerPolicy('lan-member', memberAccessPolicy(ownership));
  assert.equal(after.decide({ principal, action: 'session/create', resources: [{ kind: 'global' }] }), true);
  assert.equal(after.decide({ principal, action: 'session/list', resources: [{ kind: 'global' }] }), true);
  assert.equal(after.decide({ principal, action: 'session/prompt', resources: [{ kind: 'session', id: 'ses_mine' }] }), true);
  assert.equal(after.decide({ principal, action: 'session/prompt', resources: [{ kind: 'session', id: 'ses_owner' }] }), false);
  assert.equal(after.decide({ principal: { kind: 'lan-member', userId: OTHER }, action: 'session/prompt', resources: [{ kind: 'session', id: 'ses_mine' }] }), false);
  assert.equal(after.decide({ principal: { kind: 'lan-member', userId: OTHER }, action: 'session/create', resources: [{ kind: 'global' }] }), true);
  remove();
  assert.equal(after.decide({ principal, action: 'session/prompt', resources: [{ kind: 'session', id: 'ses_mine' }] }), false);
});

test('native administrator preview suppresses member workspace auto-navigation, including an already-open chooser', async t => {
  const f = await fixture(t); await f.login();
  const html = await (await f.carrier.handle(f.request('/lan/'))).text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('const autoSelect=async'));
  const timers = []; let observe, triggerClicks = 0, menuClicks = 0;
  const classes = () => { const values = new Set(); return { add: key => values.add(key), remove: key => values.delete(key), contains: key => values.has(key) }; };
  const element = (text, click) => ({ textContent: text, classList: classes(), offsetParent: {}, getAttribute: () => null, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }), dispatchEvent(event) { if (event.type === 'click') click(); } });
  const trigger = element('选择工作区', () => triggerClicks++), menu = element('我的工作区', () => menuClicks++);
  const window = { fetch: async () => {}, __DSH_LAN_ADMIN_PREVIEW__: true };
  const context = createContext({ window, Request, Headers, URL, location: { origin: ORIGIN }, queueMicrotask: callback => callback(), setTimeout: (callback, ms) => timers.push({ callback, ms }),
    PointerEvent: class { constructor(type) { this.type = type; } }, MouseEvent: class { constructor(type) { this.type = type; } },
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
    document: { readyState: 'complete', body: {}, documentElement: { classList: classes() }, getElementById: () => ({}), querySelectorAll: selector => selector === '[role=menuitem]' ? [menu] : [trigger] },
  });
  new Script(script).runInContext(context);
  assert.equal(triggerClicks, 0);
  window.__DSH_LAN_ADMIN_PREVIEW__ = false; observe(); assert.equal(triggerClicks, 1);
  window.__DSH_LAN_ADMIN_PREVIEW__ = true; timers.find(timer => timer.ms === 500).callback();
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.equal(menuClicks, 0, 'preview cannot be replaced by the member default workspace');
});

test('member index injects every module URL of the full client graph under /lan/', async t => {
  const f = await fixture(t); await f.login();
  const response = await f.carrier.handle(f.request('/lan/'));
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const entry of GRAPH.entries) assert.ok(html.includes(entry.url), `missing module ${entry.id}`);
  for (const batch of GRAPH.batches) assert.ok(html.includes(batch.url.replaceAll('&', '&amp;')), `missing batch ${batch.url}`);
  assert.equal((html.match(/globalThis\["__DSH_BOOT__"\]/g) ?? []).length, 1);
  assert.ok(html.includes('rev-1'));
  assert.equal(html.includes('owner-only'), false);
  assert.equal(html.includes('__DSH_OWNER_QUEUE__'), false);
  assert.equal(html.includes('.owner-style{}'), true);
  assert.ok(html.includes('"owner":false'));
  assert.equal(html.includes('"owner":true'), false);
  assert.ok(html.endsWith('<!--owner-taps-->'));
  // Every graph row is absolute under /lan/, and the ready marker is last.
  const rows = memberBootRows(GRAPH);
  assert.equal(rows.at(-1).kind, 'global');
  assert.equal(rows.at(-1).name, MEMBER_BOOT_GLOBAL);
  for (const row of rows) {
    if (row.kind === 'script-src' || row.kind === 'script-preload') assert.ok(row.src.includes('client.js') && !row.src.startsWith('/'), row.src);
  }
  assert.ok(html.includes('<base href="/lan/">'));
  assert.ok(html.includes('<link crossorigin="use-credentials" rel="manifest"'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.at(-1).includes('__DSH_BOOT_READY__') || html.includes(MEMBER_READY_MARKUP));
  assert.equal(html.includes(TOKEN), false);
});

test('member boot retains scoped Cordis while desktop applications stay administrative', () => {
  const ownerIds = ['@deepseek-ai/dsh-client-ui-open-in-app', '@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-client-ui-cordis'];
  const ownerEntries = ownerIds.map(id => ({ id, url: `plugins/??${id}/client.js&rev=1`, rev: '1' }));
  const graph = {
    ...GRAPH,
    entries: [...GRAPH.entries, ...ownerEntries],
    batches: [
      GRAPH.batches[0],
      { ...GRAPH.batches[1], entries: [...GRAPH.batches[1].entries, ownerIds[0]] },
      { phase: 'application', url: 'plugins/??host-only/client.js&rev=1', rev: '1', entries: ownerIds.slice(1) },
    ],
  };
  const before = structuredClone(graph);
  const member = memberClientGraph(graph);
  assert.deepEqual(member.entries.map(x => x.id), [...GRAPH.entries.map(x => x.id), ...ownerIds.slice(1)]);
  assert.equal(member.entries.some(x => x.id === ownerIds[0]), false);
  assert.equal(memberClientGraph(graph, true), graph, 'administrator retains native desktop client');
  assert.deepEqual(graph, before);
  assert.deepEqual(memberBootRows(member).at(-1).value, member);
});

test('teardown disposes peers, upgrade route, prefix route and the member mux', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-teardown-'));
  await writeFile(join(root, 'index.html'), '<html><head></head><body></body></html>');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registrations = [], peers = [];
  const core = { async execute() { return { token: TOKEN, csrf: CSRF, user: { ...USER } }; } };
  const auth = new MemberSessions({ core, origin: ORIGIN, ownerOrigin: OWNER });
  const ctx = {
    webServer: {
      getOrigin: () => OWNER,
      collectIndexInjections: () => [],
      applyIndexTaps: html => html,
      register(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
      registerUpgrade(route) { registrations.push(route); return () => registrations.splice(registrations.indexOf(route), 1); },
    },
    connection: {
      createSharedFetchHandler() { return { requestBodyMode: () => 'buffered', async fetch() { return new Response('ok'); } }; },
      createPeer({ principal, interactions }) { const control = new AbortController(); const peer = { principal, interactions, signal: control.signal, async dispose() { control.abort(); } }; peers.push(peer); return peer; },
    },
    remoteAccess: { invalidate() {}, snapshotFor: () => ({ owner: false, grants: [] }) },
    clientModules: { graph: () => GRAPH, async fetchBundle() { return new Response('bundle'); } },
    typertGateway: { wireStream: { open() {}, failure: () => ({}) } },
  };
  let opened = 0, closed = 0;
  const dispose = await mountMemberCarrier(ctx, { auth, frontendDist: root, memberOrigin: ORIGIN }, { mux: { handleUpgrade() { opened++; }, async close() { closed++; } } });
  const prefix = registrations.find(route => route.kind === 'prefix');
  assert.equal(prefix.path, '/lan');
  assert.deepEqual(registrations.filter(route => !route.kind).map(route => route.path), ['/lan/api/remote.mux']);
  const loginRes = recorder();
  await prefix.handler(fakeRequest('/lan/auth', { method: 'POST', headers: { host: 'localhost:59844', origin: ORIGIN, 'content-type': 'application/json' }, body: Buffer.from('{"action":"login","username":"member","password":"pw"}') }), loginRes);
  assert.equal(loginRes.status, 200);
  assert.equal(opened, 0);
  await dispose();
  await dispose();
  assert.equal(closed, 1);
  assert.equal(registrations.length, 0);
  assert.ok(peers.every(peer => peer.signal.aborted));
  const after = recorder();
  await prefix.handler(fakeRequest('/lan/', { method: 'GET', headers: { host: 'localhost:59844', origin: ORIGIN } }), after);
  assert.equal(after.status, 503);
  await auth.close();
});

test('tool grants inherit host schemas and custom grants never name an unknown tool', () => {
  // `run_code` is guarded but never named to `tools.restrict()`, which refuses it.
  assert.deepEqual(memberToolAllow([{ name: 'todo_write' }, { name: 'ask_user_question' }, { name: 'schedule_create' }, { name: 'run_code' }, { name: 'bash' }, { name: 'subagent' }]), ['todo_write', 'ask_user_question', 'schedule_create', 'bash', 'subagent']);
  assert.deepEqual(memberToolAllow([{ name: 'todo_write' }]), ['todo_write']);
  assert.deepEqual(memberToolAllow([{ name: 'terminal' }]), ['terminal']);
  assert.deepEqual(memberToolAllow(undefined), []);
  assert.deepEqual(memberToolAllow([{ name: 'job_stop' }, { name: 'new_plugin_tool' }]), ['job_stop', 'new_plugin_tool']);
  assert.deepEqual(memberToolAllow([{ name: 'read' }, { name: 'write' }, { name: 'new_plugin_tool' }], ['read', 'missing']), ['read']);
});

test('member tools retain account grants and do not escalate the selected native policy', () => {
  const allowed = new Set(['bash', 'write', 'todo_write']);
  assert.equal(memberToolDenial({ name: 'bash', arguments: { command: 'ls' } }, { allowed, mode: 'workspace-write' }), undefined);
  assert.equal(memberToolDenial({ name: 'todo_write', arguments: {} }, { allowed, mode: undefined }), undefined);
  assert.match(memberToolDenial({ name: 'subagent', arguments: {} }, { allowed, mode: 'workspace-write' }), /cannot execute/);
  assert.equal(memberToolDenial({ name: 'bash', arguments: { command: 'ls' } }, { allowed, mode: 'danger-full-access' }), undefined);
  assert.match(memberToolDenial({ name: 'write', arguments: {} }, { allowed, mode: undefined }), /sandbox/);
  assert.match(memberToolDenial({ name: 'bash', arguments: { command: 'ls', sandbox_permissions: 'danger-full-access' } }, { allowed, mode: 'workspace-write' }), /cannot leave/);
});

test('member file tool paths resolve inside the real session directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'session'), outside = join(root, 'other');
  await mkdir(cwd); await mkdir(outside); await writeFile(join(outside, 'secret'), 'x');
  const { symlink, realpath } = await import('node:fs/promises');
  await symlink(outside, join(cwd, 'link'));
  const deny = (name, args) => memberPathDenial({ name, arguments: args }, cwd, { realpath });
  assert.equal(await deny('write', { file_path: 'notes/new.txt', content: 'x' }), undefined);
  assert.equal(await deny('read', { file_path: join(cwd, 'missing.txt') }), undefined);
  assert.equal(await deny('glob', { pattern: '**/*.txt' }), undefined);
  assert.match(await deny('read', { file_path: join(outside, 'secret') }), /limited/);
  assert.match(await deny('read', { file_path: '../other/secret' }), /limited/);
  assert.match(await deny('read', { file_path: 'link/secret' }), /limited/);
  assert.match(await deny('glob', { pattern: `${outside}/*` }), /limited/);
  assert.match(await deny('grep', { pattern: 'x', path: '/etc' }), /limited/);
  assert.match(await deny('working_directory', { cd: outside }), /limited/);
  assert.match(await deny('working_directory', { cd: 'link' }), /limited/);
  assert.equal(await deny('working_directory', { cd: '.' }), undefined);
  assert.equal(await deny('bash', { command: 'cat /etc/hostname' }), undefined);
});

test('member Host-authority reads stay inside the member: file paths and scheduled tasks', async t => {
  const store = ownershipStore({ sessions: { ses_mine: { userId: USER.id, projectId: 'workspace', cwd: `${MEMBER_ROOT}/workspace`, at: 1 } }, projects: {} });
  const ownership = await new MemberOwnership({ store }).start();
  const catalog = [{ id: 't1', sessionId: 'ses_mine' }, { id: 't2', sessionId: 'ses_owner' }];
  const f = await fixture(t, { ownership, respond: request => new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value: new URL(request.url).pathname === '/api/schedule/catalog' ? catalog : {} } }), { headers: { 'content-type': 'application/json' } }) });
  await f.login();
  const post = (endpoint, args) => f.carrier.handle(f.request(`/lan/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lan-csrf': CSRF }, body: envelope(endpoint, args) }));
  const file = path => f.carrier.handle(f.request(`/lan/api/file?path=${encodeURIComponent(path)}`));
  for (const path of ['C:/Users/x/.dsh/attachments/../../.ssh/id_rsa', `${MEMBER_ROOT}/../${OTHER}/secret`, '/etc/passwd']) {
    const denied = await file(path);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'MEMBER_FILE_DENIED');
  }
  assert.equal(f.dispatches.length, 0);
  for (const endpoint of ['schedule/update', 'schedule/delete', 'schedule/list', 'schedule/history']) {
    const denied = await post(endpoint, { request: { id: 't2', sessionId: 'ses_owner', prompt: 'x' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'MEMBER_SCHEDULE_DENIED');
  }
  assert.equal(f.dispatches.length, 0);
  assert.equal((await post('schedule/list', { request: { sessionId: 'ses_mine' } })).status, 200);
  const listed = await (await post('schedule/catalog', {})).json();
  assert.deepEqual(listed.result.value.map(item => item.id), ['t1']);
  const redirect = await post('llm/discoverModels', { settingsNs: 'llm-pi-ai', request: { provider: 'host', baseURL: 'https://attacker.example' } });
  assert.equal(redirect.status, 403);
});

test('native ZIP export authorizes the root and every requested descendant before forwarding', async t => {
  const ownership = await new MemberOwnership({ store: ownershipStore() }).start();
  await ownership.record({ userId: USER.id, sessionId: 'mine', projectId: 'workspace', cwd: MEMBER_ROOT + '/workspace' });
  await ownership.record({ userId: USER.id, sessionId: 'child', projectId: 'workspace', cwd: MEMBER_ROOT + '/workspace' });
  let descendants = [{ id: 'child' }];
  const f = await fixture(t, { ownership, subagents: { async listDescendants() { return descendants; } } }); await f.login();
  const get = query => f.carrier.handle(f.request('/lan/api/session.export?' + query));
  assert.equal((await get('sessionId=foreign')).status, 403);
  assert.equal(f.dispatches.length, 0);
  assert.equal((await get('sessionId=mine')).status, 200);
  assert.equal(f.dispatches.at(-1).peer.principal.kind, 'owner');
  assert.equal((await get('sessionId=mine&includeDescendants=true')).status, 200);
  descendants = [{ id: 'foreign' }];
  const before = f.dispatches.length;
  assert.equal((await get('sessionId=mine&includeDescendants=true')).status, 403);
  assert.equal(f.dispatches.length, before);
});

test('native uploads durably grant only their member access to the exact Host attachment path', async t => {
  const hash = 'e'.repeat(64), file = { attachmentId: 'sha256:' + hash, name: 'hello.txt' };
  const hostPath = `/host/.dsh/attachments/v1/files/ee/${hash}/hello.txt`;
  const attachments = { fileHostPath: () => hostPath };
  const access = await new MemberAttachmentAccess(ownershipStore(null)).start();
  const ownership = await new MemberOwnership({ store: ownershipStore({ sessions: { mine: { userId: USER.id, projectId: 'workspace', cwd: MEMBER_ROOT + '/workspace', at: 1 } }, projects: {} }) }).start();
  const f = await fixture(t, { ownership, attachmentAccess: access, attachments, respond: request => new URL(request.url).pathname === '/api/session/uploadFileBinary'
    ? new Response(JSON.stringify({ value: { kind: 'file', file } }), { headers: { 'content-type': 'application/json' } })
    : new Response('file bytes') });
  await f.login();
  const get = path => f.carrier.handle(f.request('/lan/api/file?path=' + encodeURIComponent(path)));
  assert.equal((await get(hostPath)).status, 403);
  const upload = await f.carrier.handle(f.request('/lan/api/session/uploadFileBinary?sessionId=mine', { method: 'POST', headers: { 'x-lan-csrf': CSRF, 'content-type': 'application/octet-stream' }, body: 'hello' }));
  assert.equal(upload.status, 200);
  assert.equal(await (await get(hostPath)).text(), 'file bytes');
  assert.equal(access.allows(OTHER, hostPath, attachments.fileHostPath), false);
  assert.equal((await get('/tmp/.dsh/attachments/not-uploaded.txt')).status, 403);
});

test('member model settings keep every credential-routing field as the Host has it', () => {
  const current = { providers: { host: { baseURL: 'https://api.example', apiKeyEnv: 'HOST_KEY', headers: { a: 'b' }, models: [{ id: 'm1' }] } } };
  const update = patch => memberSettingsChangeAllowed({ endpoint: 'settings/update', args: { ns: 'llm-pi-ai', patch }, current });
  const mutate = ops => memberSettingsChangeAllowed({ endpoint: 'settings/mutate', args: { ns: 'llm-pi-ai', ops }, current });
  assert.equal(update({ providers: { host: { baseURL: 'https://api.example', apiKeyEnv: 'HOST_KEY', models: [{ id: 'm1' }, { id: 'm2' }] } } }), true);
  assert.equal(update({ providers: { host: { baseURL: 'https://attacker.example' } } }), false);
  assert.equal(update({ providers: { mine: { baseURL: 'https://attacker.example', apiKeyEnv: 'HOST_KEY' } } }), false);
  assert.equal(update({ providers: { host: { headers: { a: 'c' } } } }), false);
  assert.equal(mutate([{ op: 'set', path: ['providers', 'host', 'models'], value: [{ id: 'm3' }] }]), true);
  assert.equal(mutate([{ op: 'set', path: ['providers', 'host', 'baseURL'], value: 'https://attacker.example' }]), false);
  assert.equal(mutate([{ op: 'set', path: ['providers', 'evil'], value: { apiKeyEnv: 'HOST_KEY' } }]), false);
  assert.equal(mutate([{ op: 'delete', path: ['providers', 'host', 'apiKeyEnv'] }]), false);
  assert.equal(mutate('not ops'), false);
  assert.equal(memberSettingsChangeAllowed({ endpoint: 'settings/replace', args: { ns: 'llm-pi-ai', section: {} }, current }), false);
});

function fakeRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [body];
  const req = {
    url, method, headers, rawHeaders: Object.entries(headers).flat(),
    once() { return req; }, off() { return req; },
    [Symbol.asyncIterator]() { let index = 0; return { async next() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }; } }; },
  };
  return req;
}

function recorder() {
  const chunks = [];
  return {
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(bytes) { chunks.push(Buffer.from(bytes)); return true; },
    end() { this.ended = true; },
    destroy() {},
    once() { return this; },
    off() { return this; },
    get text() { return Buffer.concat(chunks).toString(); },
  };
}
