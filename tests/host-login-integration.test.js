import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostIntegration } from '../index.js';
import { DOMAIN_SPEC, SESSION_DOMAIN_SPEC } from '../domain-store.js';
import { HomeDirectories, createHomeDirectoryController, publicHome } from '../runtime/home-directories.mjs';
import { createIsolationCheck } from '../runtime/isolation-check.mjs';

// Entirely synthetic Host storage. No production account, browser password or
// owner principal is read or created by this integration regression.
test('Host wires separate durable hash sessions and model directory across plugin restart without auto-grants', async t => {
  const documents = new Map(), origin = 'http://127.0.0.1:59072';
  let route, cleanup;
  const ctx = {
    pluginManager: { async listBundles() { return [{ name: 'fixture-addon', version: '1.0.0', enabled: true, installed: true, optional: false, availability: 'profile', description: 'Synthetic unsupported addon' }]; } },
    storageDomain: { async open(spec) {
      assert.ok([DOMAIN_SPEC, SESSION_DOMAIN_SPEC].includes(spec));
      return { table: () => ({ get: () => structuredClone(documents.get(spec.name)), async put(key, value) { assert.equal(key, 'snapshot'); documents.set(spec.name, structuredClone(value)); } }), async close() {} };
    } },
    llm: { listProviders: () => [{ id: 'test', name: 'Test provider' }], listModels: async () => [{ provider: 'test', id: 'think', name: 'Think' }], resolveModelInfo: async () => ({ provider: 'test', id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }) },
    connection: { fetch: { register(value) { route = value; return () => {}; } } },
    skills: { async snapshot() { return { complete: true, skills: [{ name: 'fixture-skill', description: 'Synthetic shared skill', invocation: { modelInvocable: true, userInvocable: true } }] }; }, async get(name) { return { name, content: 'Synthetic skill instructions.' }; } },
    webServer: { getOrigin: () => origin }, tools: { register: () => () => {} }, effect(fn) { cleanup = fn(); }, logger: { warn() {} },
  };
  const mountMembers = async (_ctx, { core, coreStore }) => {
    const runtime = { ready: false, async start() { this.ready = true; this.capabilities = { ready: true, backend: 'dsh-native', checks: ['native-sandbox'] }; return this.capabilities; } };
    const isolation = createIsolationCheck({ core, runtime });
    const projects = { state: { projects: [] }, capabilities: () => ({ isolatedExecution: runtime.ready }), async stop() { return { stopped: true }; } };
    const homes = await new HomeDirectories({ defaultRoot: '/private/fixture', store: { async load() { return structuredClone(documents.get('homes') ?? null); }, async save(value) { documents.set('homes', structuredClone(value)); } }, runtime: {
      async directoryInfo({ root }) { return { root }; }, async ensureHome({ root, userId }) { return { root, userId, relativePath: userId }; },
    } }).start(await coreStore.load());
    return { memberOrigin: 'http://localhost:59072', projects, checkIsolation: isolation.check, updateHomeDirectory: createHomeDirectoryController({ core, homes }),
      async homeSnapshot(snapshot) { await homes.synchronize(await coreStore.load()); return { ...snapshot, home: publicHome(await homes.own(snapshot.user.id)), ...(snapshot.admin ? { admin: { ...snapshot.admin, homeDirectory: await homes.policy() } } : {}) }; },
      async accountChanged() { await homes.synchronize(await coreStore.load()); }, async close() {} };
  };
  const post = (action, args = {}, headers = {}) => route.fetch(new Request('http://dsh.internal/api/lan-workspace', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...args }) }));
  await createHostIntegration(ctx, { mountMembers }); t.after(() => cleanup());
  const bootstrap = await post('bootstrap', { username: 'fixture-admin', displayName: 'Fixture', password: 'synthetic-password-never-production', remember: true }, { 'x-lan-owner-setup': 'confirm' });
  assert.equal(bootstrap.status, 200); const login = (await bootstrap.json()).result;
  assert.equal(login.cookieSession, true); assert.equal(Object.hasOwn(login, 'token'), false);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const durable = JSON.stringify(documents.get(SESSION_DOMAIN_SPEC.name));
  assert.equal(durable.includes(cookie.split('=')[1]), false); assert.equal(durable.includes(login.csrf), false);
  assert.equal(documents.get(DOMAIN_SPEC.name).users.length, 1);
  await cleanup(); await createHostIntegration(ctx, { mountMembers });
  const restored = await post('auth.restore', {}, { cookie }); assert.equal(restored.status, 200);
  assert.equal((await restored.json()).result.user.id, login.user.id);
  const response = await post('snapshot', {}, { cookie }); assert.equal(response.status, 200);
  const snapshot = (await response.json()).result;
  assert.equal(snapshot.admin.modelCatalog.length, 2); assert.deepEqual(snapshot.user.routeIds, []);
  assert.equal(snapshot.home.status, 'ready'); assert.equal(snapshot.home.automatic, true); assert.equal(snapshot.admin.homeDirectory.revision, 0);
  assert.equal((await post('admin.checkIsolation', {}, { cookie })).status, 403);
  assert.equal((await (await post('status')).json()).result.capabilities.isolatedExecution, false);
  const checked = await post('admin.checkIsolation', {}, { cookie, 'x-lan-csrf': login.csrf }); assert.equal(checked.status, 200); assert.equal((await checked.json()).result.status, 'ready');
  assert.equal((await (await post('status')).json()).result.capabilities.isolatedExecution, true);
  assert.equal((await post('admin.updateHomeDirectory', { root: '/private/new', expectedRevision: 0 }, { cookie })).status, 403);
  const savedHome = await post('admin.updateHomeDirectory', { root: '/private/new', expectedRevision: 0 }, { cookie, 'x-lan-csrf': login.csrf });
  assert.equal(savedHome.status, 200); assert.equal((await savedHome.json()).result.revision, 1);
  assert.equal((await post('admin.updateHomeDirectory', { root: '/private/other', expectedRevision: 0 }, { cookie, 'x-lan-csrf': login.csrf })).status, 409);
  const afterHome = (await (await post('snapshot', {}, { cookie })).json()).result;
  assert.deepEqual(afterHome.home, { status: 'ready', automatic: true, path: '~' });
  assert.equal(documents.get('homes').homes[0].root, '/private/fixture', 'root edit must preserve the private broker binding');
  assert.deepEqual(afterHome.user.routeIds, [], 'root configuration is independent from model grants');
  await cleanup(); await createHostIntegration(ctx, { mountMembers });
  const restartedSnapshot = (await (await post('snapshot', {}, { cookie })).json()).result;
  assert.equal(restartedSnapshot.admin.homeDirectory.root, '/private/new'); assert.equal(restartedSnapshot.home.path, '~');
  assert.equal(documents.get('homes').homes[0].root, '/private/fixture');
  const createdMember = await post('admin.createUser', { username: 'fixture-member', displayName: 'Member', password: 'synthetic-member-password', routeIds: [] }, { cookie, 'x-lan-csrf': login.csrf });
  assert.equal(createdMember.status, 200);
  const memberLogin = await post('login', { username: 'fixture-member', password: 'synthetic-member-password' }); assert.equal(memberLogin.status, 200);
  const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];
  const memberSnapshot = (await (await post('snapshot', {}, { cookie: memberCookie })).json()).result;
  assert.equal(memberSnapshot.admin, undefined);
  const memberLoginValue = (await (await post('auth.restore', {}, { cookie: memberCookie })).json()).result;
  assert.equal((await post('admin.updateUser', { userId: login.user.id, disabled: true }, { cookie: memberCookie, 'x-lan-csrf': memberLoginValue.csrf })).status, 403);
  assert.deepEqual(memberSnapshot.home, { status: 'ready', automatic: true, path: '~' });
  assert.doesNotMatch(JSON.stringify(memberSnapshot), /\/private\/|defaultRoot|configuredRoot|relativePath/);
  const changed = await post('password.change', { currentPassword: 'synthetic-member-password', password: 'replacement-member-password' }, { cookie: memberCookie, 'x-lan-csrf': memberLoginValue.csrf });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).result.signedOut, true);
  assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await post('auth.restore', {}, { cookie: memberCookie })).status, 401);
  assert.equal((await post('login', { username: 'fixture-member', password: 'synthetic-member-password' })).status, 401);
  assert.equal((await post('login', { username: 'fixture-member', password: 'replacement-member-password' })).status, 200);
  assert.equal((await post('auth.restore', {}, { cookie })).status, 200, 'another account keeps its login');
  const loggedOut = await post('logout', {}, { cookie, 'x-lan-csrf': login.csrf }); assert.equal(loggedOut.status, 200);
  await cleanup(); await createHostIntegration(ctx, { mountMembers });
  assert.equal((await post('auth.restore', {}, { cookie })).status, 401);
  const recovered = await post('owner.recoverAdministrator', { username: 'fixture-admin', password: 'recovered-native-owner-password' }, { 'x-lan-owner-setup': 'confirm' });
  assert.equal(recovered.status, 200);
  assert.equal((await post('login', { username: 'fixture-admin', password: 'synthetic-password-never-production' })).status, 401);
  const recoveredLogin = await post('login', { username: 'fixture-admin', password: 'recovered-native-owner-password' }); assert.equal(recoveredLogin.status, 200);
  assert.equal((await recoveredLogin.json()).result.user.id, login.user.id);
  assert.equal(documents.get(DOMAIN_SPEC.name).users.length, 2, 'recovery does not replace accounts or member data');
});
