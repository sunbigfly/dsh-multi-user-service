import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config, createHostIntegration, createStatusTool, inject } from '../index.js';
import { DomainStore, DOMAIN_SPEC, SESSION_DOMAIN_SPEC } from '../domain-store.js';
import { Branding } from '../carrier/branding.mjs';
import { MemoryStore } from '../core/store.js';

function fixture({ failOpen = false } = {}) {
  let saved;
  let closed = false;
  let route;
  let tool;
  let cleanup;
  const events = [];
  const table = {
    get(key) { assert.equal(key, 'snapshot'); return saved; },
    async put(key, value) { assert.equal(key, 'snapshot'); saved = value; },
  };
  let savedSessions;
  const domain = { table(name) { assert.equal(name, 'state'); return table; }, async close() { closed = true; events.push('domain-close'); } };
  const sessionDomain = { table(name) { assert.equal(name, 'state'); return { get() { return savedSessions; }, async put(key, value) { assert.equal(key, 'snapshot'); savedSessions = value; } }; }, async close() { events.push('session-domain-close'); } };
  const ctx = {
    pluginManager: { async listBundles() { return []; } },
    storageDomain: { async open(spec) { assert.ok([DOMAIN_SPEC, SESSION_DOMAIN_SPEC].includes(spec)); if (failOpen) throw new Error('storage unavailable'); return spec === DOMAIN_SPEC ? domain : sessionDomain; } },
    connection: { fetch: { register(value) { route = value; events.push('route-register'); return async () => { events.push('route-dispose'); }; } } },
    webServer: { getOrigin: () => 'http://127.0.0.1:59844' },
    llm: { listProviders: () => [{ id: 'configured-provider', name: 'Configured' }], async listModels() { return [{ provider: 'configured-provider', id: 'configured-model', name: 'Configured model' }]; }, async resolveModelInfo() { return { provider: 'configured-provider', id: 'configured-model', name: 'Configured model' }; } },
    tools: { register(value) { tool = value; events.push('tool-register'); return () => events.push('tool-dispose'); } },
    effect(fn) { cleanup = fn(); },
    logger: { warn() {} },
  };
  return { ctx, domain, events, table, get route() { return route; }, get tool() { return tool; }, get cleanup() { return cleanup; }, get saved() { return saved; }, get closed() { return closed; } };
}

test('public Host Config accepts an omitted entry and remains projectable by the installed Loader', () => {
  assert.equal(Config['~standard'].vendor, 'schemastery');
  assert.deepEqual(Config(), { memberAliases: [] });
  assert.deepEqual(Config({ memberOrigin: 'http://localhost:59844' }), { memberOrigin: 'http://localhost:59844', memberAliases: [] });
  assert.deepEqual(Config({ memberAliases: ['http://dsh.local:59844'] }).memberAliases, ['http://dsh.local:59844']);
  assert.throws(() => Config({ projectRoot: 42 }));
});

test('DomainStore clones records and waits for durable put', async () => {
  const f = fixture(); const store = new DomainStore(f.domain);
  assert.equal(await store.load(), null);
  const state = { version: 1, values: ['a'] };
  await store.save(state); state.values.push('mutation');
  assert.deepEqual(await store.load(), { version: 1, values: ['a'] });
  const copy = await store.load(); copy.values.push('again');
  assert.deepEqual(await store.load(), { version: 1, values: ['a'] });
  await assert.rejects(store.save({ bad: undefined }));
});

test('a small snapshot can finish beside a slow catalog, whose final login check rejects logout', async t => {
  const f = fixture();
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const catalogStarted = new Promise(resolve => { started = resolve; });
  await createHostIntegration(f.ctx, { mountMembers: async () => ({
    projects: { capabilities: () => ({}) }, async close() {},
    async homeSnapshot(snapshot, { section }, revalidate) {
      if (section === 'catalog') { started(); await held; }
      return revalidate();
    },
  }) });
  t.after(() => { release(); return f.cleanup(); });
  const post = (action, fields = {}, headers = {}) => f.route.fetch(new Request('http://dsh.internal/api/lan-workspace', {
    method: 'POST', headers: { origin: f.ctx.webServer.getOrigin(), 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...fields }),
  }));
  const response = await post('bootstrap', { username: 'section-admin', displayName: 'Fixture', password: 'synthetic-section-password' }, { 'x-lan-owner-setup': 'confirm' });
  const cookie = response.headers.get('set-cookie').split(';')[0], login = (await response.json()).result;
  const slow = post('snapshot', { section: 'catalog' }, { cookie });
  await catalogStarted;
  assert.equal((await post('snapshot', { section: 'base' }, { cookie })).status, 200);
  assert.equal((await post('logout', {}, { cookie, 'x-lan-csrf': login.csrf })).status, 200);
  release(); assert.equal((await slow).status, 401);
});

test('slow model discovery cannot hold account, session or file reads, while model grants still join it', async t => {
  const f = fixture(); let changed, release, started;
  const held = new Promise(resolve => { release = resolve; }), discoveryStarted = new Promise(resolve => { started = resolve; });
  f.ctx.on = (name, listener) => { assert.equal(name, 'llm/adapters-updated'); changed = listener; return () => {}; };
  await createHostIntegration(f.ctx, { mountMembers: async (_ctx, { core }) => ({ projects: { capabilities: () => ({}) }, async close() {},
    administerContent: (_args, caller) => core.runAdministratorOperation(caller, () => ({ items: [], total: 0 })),
  }) });
  t.after(() => { release(); return f.cleanup(); });
  const post = (action, fields = {}, headers = {}) => f.route.fetch(new Request('http://dsh.internal/api/lan-workspace', {
    method: 'POST', headers: { origin: f.ctx.webServer.getOrigin(), 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...fields }),
  }));
  const response = await post('bootstrap', { username: 'slow-model-admin', displayName: 'Fixture', password: 'synthetic-metadata-password' }, { 'x-lan-owner-setup': 'confirm' });
  const cookie = response.headers.get('set-cookie').split(';')[0], login = (await response.json()).result, headers = { cookie, 'x-lan-csrf': login.csrf };
  const listModels = f.ctx.llm.listModels;
  f.ctx.llm.listModels = async (...args) => { started(); await held; return listModels(...args); };
  changed(); await discoveryStarted;
  let timer;
  try {
    await Promise.race([(async () => {
      for (const args of [{ action: 'snapshot', section: 'base' }, { action: 'admin.content', operation: 'sessions.list' }, { action: 'admin.content', operation: 'files.list' }]) {
        const { action, ...fields } = args; assert.equal((await post(action, fields, headers)).status, 200);
      }
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('unrelated model discovery blocked reads')), 500); })]);
  } finally { clearTimeout(timer); }
  let settled = false;
  const grant = post('admin.createInvite', { displayName: 'Synthetic invitation' }, headers).then(value => { settled = true; return value; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(settled, false, 'model grant operations must still wait for current metadata');
  release(); assert.equal((await grant).status, 200);
});

test('Host plugin registers only its owner fetch route and a status-only tool, and disposes both', async () => {
  const f = fixture();
  await createHostIntegration(f.ctx, { mountMembers: async () => ({ memberOrigin: 'http://localhost:59844', projects: { capabilities: () => ({ sharedAccess: true, terminal: false }) }, close: async () => f.events.push('member-close') }) });
  assert.deepEqual(inject, ['connection', 'webServer', 'storageDomain', 'tools', 'lanToolOrigins', 'llm', 'agents', 'remoteAccess', 'clientModules', 'typertGateway', 'sessionPersistence', 'sessions', 'skills', 'agentPresets', 'configEditor', 'workingDirectory', 'pluginManager']);
  assert.equal(f.route.path, '/api/lan-workspace');
  assert.equal(f.route.requestBody, 'streaming');
  assert.deepEqual(f.route.methods, ['POST']);
  assert.equal(f.tool.name, 'lan_workspace_status');
  const result = await f.tool.execute({});
  assert.equal(result.initialized, false);
  assert.equal(result.capabilities.sharedAccess, true);
  assert.equal(result.memberUrl, 'http://localhost:59844/lan/');
  assert.equal(result.capabilities.terminal, false);
  assert.equal(result.configuredModelVariants, 1);
  await assert.rejects(f.tool.execute({ action: 'bootstrap' }));
  await f.cleanup();
  assert.ok(f.events.indexOf('route-dispose') < f.events.indexOf('domain-close'));
  assert.ok(f.events.indexOf('tool-dispose') < f.events.indexOf('domain-close'));
  assert.ok(f.events.indexOf('member-close') < f.events.indexOf('session-domain-close'));
  assert.equal(f.closed, true);
  await assert.rejects(f.tool.execute({}));
});

test('owner facade publishes branding and delegates administrator appearance and content operations', async () => {
  const f = fixture(); let branding; const contentCalls = [];
  await createHostIntegration(f.ctx, { mountMembers: async (_ctx, { core }) => {
    branding = await new Branding({ store: new MemoryStore(), core }).start();
    return { memberOrigin: 'http://localhost:59844', projects: { capabilities: () => ({}) }, brandingSnapshot: () => branding.snapshot(), updateBranding: (request, caller) => branding.update(request, caller),
      administerContent: (request, caller) => core.runAdministratorOperation(caller, () => { contentCalls.push(request.operation); return { items: [], total: 0 }; }), close: async () => {} };
  } });
  try {
    const call = async (fields, headers = {}) => {
      const response = await f.route.fetch(new Request('http://dsh.internal/api/lan-workspace', { method: 'POST', headers: { origin: 'http://127.0.0.1:59844', 'content-type': 'application/json', ...headers }, body: JSON.stringify(fields) }));
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const login = await call({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password: 'synthetic-owner-branding-password' }, { 'x-lan-owner-setup': 'confirm' });
    assert.equal(login.status, 200);
    const auth = { cookie: login.cookie, 'x-lan-csrf': login.body.result.csrf };
    const saved = await call({ action: 'admin.updateBranding', logo: null, slogan: 'Shared home', showPreviewBadge: false, expectedRevision: 0 }, auth);
    assert.equal(saved.status, 200); assert.equal(saved.body.result.branding.slogan, 'Shared home');
    const status = await call({ action: 'status' }); assert.equal(status.body.result.branding.slogan, 'Shared home'); assert.equal(status.body.result.branding.showPreviewBadge, false);
    const denied = await call({ action: 'admin.updateBranding', logo: null, slogan: null, expectedRevision: 1 }, { cookie: login.cookie });
    assert.equal(denied.status, 403); assert.equal(branding.snapshot().slogan, 'Shared home');
    const content = await call({ action: 'admin.content', operation: 'sessions.list' }, auth);
    assert.equal(content.status, 200); assert.deepEqual(contentCalls, ['sessions.list']);
    const contentDenied = await call({ action: 'admin.content', operation: 'files.list' }, { cookie: login.cookie });
    assert.equal(contentDenied.status, 403); assert.deepEqual(contentCalls, ['sessions.list']);
  } finally { await f.cleanup(); }
});

test('Host storage activation failure registers no route or tool', async () => {
  const f = fixture({ failOpen: true });
  await assert.rejects(apply(f.ctx), /storage unavailable/);
  assert.equal(f.route, undefined); assert.equal(f.tool, undefined);
});

test('status tool omits branding assets and never forwards account mutation arguments', async () => {
  const calls = [];
  const tool = createStatusTool({ execute: async (...args) => { calls.push(args); return { isolatedExecution: false, branding: { logo: 'synthetic image bytes', slogan: 'Public brand' } }; } });
  for (const args of [null, [], { username: 'admin' }, { action: 'login' }]) await assert.rejects(tool.execute(args));
  assert.equal(calls.length, 0);
  assert.deepEqual(await tool.execute({}), { isolatedExecution: false });
  assert.deepEqual(calls, [[{ action: 'status' }, {}]]);
});
