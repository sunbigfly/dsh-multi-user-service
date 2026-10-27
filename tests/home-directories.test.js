import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeDirectories, homeRoot, createHomeDirectoryController, publicHome } from '../runtime/home-directories.mjs';
import { LanService, MemoryStore } from '../core/service.js';

test('Windows server path validation accepts canonical drive paths and keeps directory boundaries', async () => {
  const { execFile } = await import('node:child_process');
  const code = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { homeRoot } = await import(${JSON.stringify(new URL('../runtime/home-directories.mjs', import.meta.url).href)});
    const { sharedDirectories } = await import(${JSON.stringify(new URL('../core/validation.js', import.meta.url).href)});
    const { insideRange } = await import(${JSON.stringify(new URL('../carrier/file-ranges.mjs', import.meta.url).href)});
    const assert = (await import('node:assert/strict')).default;
    assert.equal(homeRoot('C:/Team/Homes'), 'C:/Team/Homes');
    assert.throws(() => homeRoot('C:/'));
    assert.throws(() => homeRoot('C:/Team/../Windows'));
    assert.equal(sharedDirectories([{path:'D:/Team/Data',mode:'read-only'}])[0].path, 'D:/Team/Data');
    assert.equal(insideRange('D:/Team/Data', 'd:/team/data/report.txt'), true);
    assert.equal(insideRange('D:/Team/Data', 'D:/Team/Database/report.txt'), false);
    console.log('OK');
  `;
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(stdout.trim(), 'OK');
});

const id = (prefix, n) => `${prefix}_${String(n).padStart(32, '0')}`;
const a = id('usr', 1), b = id('usr', 2), c = id('usr', 3), p = id('prj', 1);
const coreState = (users = [a, b], projects = []) => ({ users: users.map(id => ({ id, routeIds: [] })), projects });
function fixture({ stored = null, defaultRoot = null, state = coreState() } = {}) {
  let data = structuredClone(stored), failure = false, unavailable = false, workerDefault = '/private/default';
  const events = [];
  const store = { async load() { return structuredClone(data); }, async save(value) { events.push('save'); if (failure) throw new Error('write failed'); data = structuredClone(value); } };
  const runtime = {
    ready: false,
    async directoryInfo({ root }) { if (unavailable) throw new Error('broker unavailable'); return { root: root ?? workerDefault }; },
    async ensureHome(value) { events.push({ ...value }); if (unavailable) throw new Error('broker unavailable'); return { ...value, relativePath: value.userId }; },
  };
  const homes = new HomeDirectories({ store, runtime, defaultRoot });
  return { homes, store, runtime, state, events, data: () => structuredClone(data), fail: value => { failure = value; }, unavailable: value => { unavailable = value; }, default: value => { workerDefault = value; } };
}

test('public home responses allow only allocation status and the virtual alias, never host paths or IDs', async () => {
  const f = fixture({ defaultRoot: '/home/synthetic-host-admin/private-homes' }); await f.homes.start(f.state);
  const own = await f.homes.own(a), before = structuredClone(own);
  const response = publicHome({ ...own, defaultRoot: '/private/startup', extra: { internal: '/secret' } });
  assert.deepEqual(response, { status: 'ready', automatic: true, path: '~' });
  assert.deepEqual(own, before, 'public projection cannot mutate the broker binding');
  assert.doesNotMatch(JSON.stringify(response), /synthetic-host-admin|private-homes|\/home|\/private|usr_|root|relativePath|userId|extra/);
  f.unavailable(true); assert.deepEqual(publicHome(await f.homes.own(a)), { status: 'unavailable', automatic: true, path: '~' });
  assert.deepEqual(publicHome({ status: 'pending', path: null }), { status: 'pending', automatic: true, path: null });
  assert.deepEqual(publicHome({ status: '/private/invalid', path: '' }), { status: 'unavailable', automatic: true, path: null });
  assert.deepEqual(publicHome(null), { status: 'unavailable', automatic: true, path: null });
});

test('canonical Linux home roots reject drive, traversal, alternate spelling and controls', () => {
  for (const root of ['', '/', 'relative', 'C:\\homes', '/a/../b', '/a//b', '/a/', '//host/share', '/a\\b', '/tmp\nfoo', ' /private', '/usr', '/etc/private', '/home', '/tmp', '/mnt/c', '/media/disk']) assert.throws(() => homeRoot(root), { code: 'INVALID_HOME_ROOT' });
  assert.equal(homeRoot('/private/成员 homes'), '/private/成员 homes');
});

test('all users receive immutable ID based logical homes before any model or execution authorization', async () => {
  const f = fixture(); await f.homes.start(f.state);
  assert.deepEqual(f.data().homes, [{ userId: a, root: null }, { userId: b, root: null }]);
  assert.equal(f.runtime.ready, false); assert.deepEqual(f.events, ['save']);
  const own = await f.homes.own(a);
  assert.deepEqual(own, { userId: a, relativePath: a, root: '/private/default', path: `/private/default/${a}`, status: 'ready', automatic: true });
  assert.deepEqual(f.events.slice(0, 2), ['save', 'save'], 'default root must be durable before mkdir');
  assert.equal(f.runtime.ready, false, 'home creation cannot claim isolation readiness');
  assert.equal(f.data().homes.find(row => row.userId === b).root, '/private/default');
});

test('root cutover preserves existing users and projects; new users get the administrator root', async () => {
  const state = coreState([a, b], [{ id: p, ownerId: a }]), f = fixture({ state }); await f.homes.start(state);
  const result = await f.homes.update({ root: '/private/new-root', expectedRevision: 0 });
  assert.equal(result.revision, 1); assert.equal(result.root, '/private/new-root'); assert.equal(result.existingHomesPreserved, true);
  await f.homes.synchronize(coreState([a, b, c], [{ id: p, ownerId: a }]));
  assert.equal((await f.homes.own(a)).root, '/private/default'); assert.equal((await f.homes.own(c)).root, '/private/new-root');
  assert.equal(await f.homes.projectRoot({ userId: a, projectId: p }), '/private/default');
  await assert.rejects(f.homes.projectRoot({ userId: b, projectId: p }), { code: 'PROJECT_NOT_FOUND' });
  assert.equal(f.events.filter(row => typeof row === 'object').length, 2, 'root edits never mkdir or move old projects');
});

test('first upgrade pins the original worker default before adopting existing projects or fails without publishing', async () => {
  const state = coreState([a], [{ id: p, ownerId: a }]), f = fixture({ state });
  await f.homes.start(state);
  assert.equal(f.data().defaultRoot, '/private/default'); assert.equal(f.data().projects[0].root, '/private/default');
  f.default('/changed-worker'); assert.equal(await f.homes.projectRoot({ userId: a, projectId: p }), '/private/default');
  const failed = fixture({ state }); failed.unavailable(true);
  await assert.rejects(failed.homes.start(state), { code: 'HOME_LEGACY_ROOT_UNCONFIRMED' });
  assert.equal(failed.data(), null, 'failed migration cannot silently adopt an unknown location');
  const legacy = fixture({ state, stored: { version: 1, revision: 0, root: null, defaultRoot: null, homes: [{ userId: a, root: null }], projects: [{ userId: a, projectId: p, root: null }] } });
  await legacy.homes.start(state); assert.equal(legacy.data().projects[0].root, '/private/default');
});

test('administrator cannot nest new users inside another home/project or select overlapping root trees', async () => {
  const state = coreState([a], [{ id: p, ownerId: a }]), f = fixture({ state, defaultRoot: '/private/original' }); await f.homes.start(state);
  for (const root of [`/private/original/${a}/${p}/new-homes`, `/private/original/${a}`, `/elsewhere/${p}/new-homes`]) await assert.rejects(f.homes.update({ root, expectedRevision: 0 }), { code: 'INVALID_HOME_ROOT' });
  for (const root of ['/private/original/nested', '/private']) await assert.rejects(f.homes.update({ root, expectedRevision: 0 }), { code: 'HOME_ROOT_OVERLAP' });
  assert.equal((await f.homes.policy()).revision, 0);
  await f.homes.update({ root: '/private/separate', expectedRevision: 0 });
  assert.equal((await f.homes.policy()).root, '/private/separate');
  const gap = fixture({ defaultRoot: '/private/base' }); await gap.homes.start(gap.state);
  await gap.homes.update({ root: '/private/base-logs', expectedRevision: 0 });
  await assert.rejects(gap.homes.update({ root: '/private/base/v2', expectedRevision: 1 }), { code: 'HOME_ROOT_OVERLAP' });
  assert.equal((await gap.homes.update({ root: '/private/base2', expectedRevision: 1 })).root, '/private/base2');
});

test('default is pinned across worker HOME or startup config changes and plugin restart', async () => {
  const f = fixture(); await f.homes.start(f.state); await f.homes.own(a);
  const restarted = fixture({ stored: f.data(), defaultRoot: '/different-config' }); restarted.default('/different-worker-home');
  await restarted.homes.start(f.state);
  assert.equal((await restarted.homes.own(a)).root, '/private/default');
  assert.equal((await restarted.homes.policy()).defaultRoot, '/private/default');
});

test('CAS conflicts, extra path fields, failed durability and missing state never reset or publish defaults', async () => {
  const f = fixture({ defaultRoot: '/private/original' }); await f.homes.start(f.state);
  await assert.rejects(f.homes.update({ root: '/new', expectedRevision: 2 }), { code: 'HOME_DIRECTORY_CONFLICT' });
  await assert.rejects(f.homes.update({ root: '/new', expectedRevision: 0, userId: b }), { code: 'INVALID_INPUT' });
  f.fail(true); await assert.rejects(f.homes.update({ root: '/new', expectedRevision: 0 }), { code: 'HOME_STORAGE_FAILURE' });
  assert.equal((await f.homes.policy()).root, '/private/original'); assert.equal((await f.homes.policy()).revision, 0);
  f.fail(false); await f.store.save(null); await assert.rejects(f.homes.policy(), { code: 'HOME_STATE_MISSING' });
});

test('broker outage preserves allocation and exposes unavailable rather than claiming execution or a fallback', async () => {
  const f = fixture({ defaultRoot: '/private/base' }); await f.homes.start(f.state); f.unavailable(true);
  assert.equal((await f.homes.own(a)).status, 'unavailable');
  await assert.rejects(f.homes.update({ root: '/new', expectedRevision: 0 }));
  assert.equal(f.data().root, null); assert.equal(f.events.filter(row => typeof row === 'object').length, 0);
  f.unavailable(false); assert.equal((await f.homes.own(a)).status, 'ready');
});

test('failed default durability does not create a user directory', async () => {
  const f = fixture(); await f.homes.start(f.state); f.fail(true);
  const own = await f.homes.own(a); assert.equal(own.status, 'unavailable'); assert.equal(own.path, null);
  assert.equal(f.events.filter(row => typeof row === 'object').length, 0);
});

test('new projects use saved user homes and cannot choose absolute directory names', async () => {
  const f = fixture({ defaultRoot: '/private/original' }); await f.homes.start(f.state);
  await f.homes.update({ root: '/private/new', expectedRevision: 0 });
  const root = await f.homes.projectRoot({ userId: a, projectId: p }); assert.equal(root, '/private/original');
  await assert.rejects(f.homes.projectRoot({ userId: c, projectId: p }), { code: 'HOME_NOT_ALLOCATED' });
  await assert.rejects(f.homes.projectRoot({ userId: a, projectId: '/tmp/foreign' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.data().projects, [{ userId: a, projectId: p, root: '/private/original' }]);
});

test('administrator root validation returns explicit safe errors on both HTTP carriers', async () => {
  const f = fixture({ defaultRoot: '/private/original' }); await f.homes.start(f.state);
  f.runtime.directoryInfo = async () => { throw Object.assign(new Error('private host data must not leak'), { code: 'UNSAFE_PROJECT_ROOT' }); };
  await assert.rejects(f.homes.update({ root: '/private/unsafe', expectedRevision: 0 }), error => error.name === 'LanError' && error.code === 'INVALID_HOME_ROOT' && error.status === 400 && !error.message.includes('private host data'));
});

test('directory administration requires authenticated admin and CSRF under the core account queue', async t => {
  const store = new MemoryStore(), core = new LanService({ store }); await core.start(); t.after(() => core.close());
  const login = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password: 'synthetic-password-only' }, { ownerBootstrap: true });
  const caller = { token: login.token, csrf: login.csrf };
  await core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password: 'synthetic-password-only', routeIds: [] }, caller);
  const member = await core.execute({ action: 'login', username: 'member', password: 'synthetic-password-only' });
  const f = fixture({ state: await store.load(), defaultRoot: '/private/base' }); await f.homes.start(f.state);
  const update = createHomeDirectoryController({ core, homes: f.homes }), request = { action: 'admin.updateHomeDirectory', root: '/private/new', expectedRevision: 0 };
  await assert.rejects(update(request, { token: login.token }), { code: 'CSRF_INVALID' });
  await assert.rejects(update(request, { token: member.token, csrf: member.csrf }), { code: 'FORBIDDEN' });
  await assert.rejects(update({ ...request, userId: login.user.id }, caller), { code: 'INVALID_INPUT' });
  let enter, release;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const originalSave = f.store.save.bind(f.store);
  f.store.save = async value => { if (value.root === '/private/new') { enter(); await gate; } return originalSave(value); };
  const mutation = update(request, caller); await entered;
  const created = core.execute({ action: 'admin.createUser', username: 'after-cutover', displayName: 'After', password: 'synthetic-password-only', routeIds: [] }, caller);
  release(); assert.equal((await mutation).revision, 1); const after = await created;
  await f.homes.synchronize(await store.load());
  assert.equal((await f.homes.own(after.user.id)).root, '/private/new');
  assert.equal((await f.homes.own(login.user.id)).root, '/private/base');
  assert.deepEqual((await core.execute({ action: 'snapshot' }, caller)).user.routeIds, [], 'choosing storage must not grant a model');
});
