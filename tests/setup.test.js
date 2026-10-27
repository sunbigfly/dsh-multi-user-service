import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, MemoryStore } from '../core/service.js';
import { ServerSetup } from '../carrier/setup.mjs';
import { MemberSessions } from '../carrier/auth.mjs';
import { mkdtemp, mkdir, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const password = 'synthetic initial setup password';
async function fixture(t, { legacy = false, recommendedRoot = null } = {}) {
  const coreStore = new MemoryStore(), core = new LanService({ store: coreStore });
  await core.start(); t.after(() => core.close());
  const setupStore = new MemoryStore(), origin = 'http://192.168.1.20:18620', ownerOrigin = 'http://127.0.0.1:18620';
  const homes = { root: '/srv/member-data', revision: 0, async policy() { return { root: this.root, revision: this.revision }; }, async synchronize() {}, async update({ root, expectedRevision }) { assert.equal(expectedRevision, this.revision); this.root = root; this.revision++; } };
  const initialize = () => core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Administrator', password }, { ownerBootstrap: true });
  let admin = legacy ? await initialize() : null;
  let auth;
  const options = { store: setupStore, core, homes, origin, ownerOrigin, recommendedRoot, now: () => 1000, modelVariants: () => 3,
    validateDirectories: async (rows, root) => { if (rows.some(row => row.path.startsWith(root))) throw Object.assign(Error('Private directory'), { code: 'SHARED_DIRECTORY_DENIED' }); },
    onConfigured: value => auth.addAliases([value]) };
  const setup = await new ServerSetup(options).start(await coreStore.load());
  auth = new MemberSessions({ core, origin, ownerOrigin, authorizeUser: user => setup.authorizeUser(user) }); t.after(() => auth.close());
  admin ??= await initialize();
  const caller = { token: admin.token, csrf: admin.csrf };
  await core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password }, caller);
  const complete = extra => setup.complete({ action: 'admin.completeSetup', expectedRevision: 0, root: homes.root, homeRevision: homes.revision, sharedDirectories: [{ path: '/srv/team-shared', mode: 'read-only' }], memberHost: 'team-server.local', ...extra }, caller);
  return { setup, setupStore, core, coreStore, homes, auth, options, caller, complete };
}

test('new installations remain closed to members until setup is durably complete, including after restart', async t => {
  const f = await fixture(t);
  assert.equal(f.setup.snapshot().required, true);
  assert.equal(f.setup.snapshot().port, 18620);
  await assert.rejects(f.auth.login('login', { username: 'member', password }), { code: 'SETUP_REQUIRED' });
  assert.equal(f.auth.sessions.size, 0);
  const restarted = await new ServerSetup(f.options).start(await f.coreStore.load());
  assert.equal(restarted.snapshot().required, true, 'creating an administrator must not bypass pending setup on restart');
  const result = await f.complete();
  assert.equal(result.required, false); assert.equal(result.revision, 1);
  assert.equal(result.memberOrigin, 'http://team-server.local:18620');
  assert.deepEqual(result.sharedDirectories, [{ path: '/srv/team-shared', mode: 'read-only' }]);
  f.auth.trust(new Headers({ host: 'team-server.local:18620', origin: 'http://team-server.local:18620' }), { mutation: true });
  assert.throws(() => f.auth.trust(new Headers({ host: 'team-server.local:18620', origin: 'http://attacker.local:18620' }), { mutation: true }), { code: 'ORIGIN_DENIED' });
  assert.equal((await f.auth.login('login', { username: 'member', password })).user.username, 'member');
  const resumed = await new ServerSetup(f.options).start(await f.coreStore.load());
  assert.equal(resumed.snapshot().required, false);
  assert.equal(resumed.snapshot().memberOrigin, result.memberOrigin);
  const request = f.setup.defaults({ action: 'admin.createUser', access: { files: false } });
  assert.deepEqual(request.access, { files: false, sharedDirectories: result.sharedDirectories });
  assert.deepEqual(f.setup.defaults({ action: 'admin.createInvite', access: { sharedDirectories: [] } }).access, { sharedDirectories: [] });
});

test('setup requires administrator CSRF, current revisions and valid directories and hostname; failed saves stay closed', async t => {
  const f = await fixture(t), before = await f.setupStore.load();
  for (const fields of [{ expectedRevision: 1 }, { homeRevision: 1 }, { memberHost: 'localhost' }, { memberHost: '127.0.0.1' }, { memberHost: 'team.local:19000' }, { memberHost: 'https://team.local' }, { root: '/' }, { sharedDirectories: [{ path: '/srv/member-data/private', mode: 'read-only' }] }]) {
    await assert.rejects(f.complete(fields));
    assert.deepEqual(await f.setupStore.load(), before);
  }
  const payload = { action: 'admin.completeSetup', expectedRevision: 0, root: f.homes.root, homeRevision: 0, sharedDirectories: [], memberHost: 'team.local' };
  await assert.rejects(f.setup.complete(payload, { token: f.caller.token }), { code: 'CSRF_INVALID' });
  const member = await f.core.execute({ action: 'login', username: 'member', password });
  await assert.rejects(f.setup.complete(payload, { token: member.token, csrf: member.csrf }), { code: 'FORBIDDEN' });
  const save = f.setupStore.save.bind(f.setupStore); f.setupStore.save = async () => { throw Error('Synthetic storage failure'); };
  await assert.rejects(f.complete());
  assert.equal(f.setup.snapshot().required, true);
  assert.equal(f.auth.origins.has('team-server.local:18620'), false);
  f.setupStore.save = save;
  const results = await Promise.allSettled([f.complete(), f.complete()]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'SETUP_CONFLICT');
});

test('recommended shared storage is created only by explicit setup choice and never follows a link', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-setup-recommended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recommendedRoot = join(root, 'dsh-shared'), f = await fixture(t, { recommendedRoot });
  f.homes.root = join(root, 'members');
  assert.equal(f.setup.snapshot().recommendedSharedDirectory, recommendedRoot);
  await assert.rejects(f.complete({ createRecommended: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(lstat(recommendedRoot), { code: 'ENOENT' });
  await f.complete({ createRecommended: true, sharedDirectories: [{ path: recommendedRoot, mode: 'read-only' }] });
  assert.equal((await lstat(recommendedRoot)).isDirectory(), true);
  assert.equal(f.setup.snapshot().sharedDirectories[0].mode, 'read-only');
  const target = join(root, 'protected'); await mkdir(target);
  const linked = join(root, 'linked-shared'); await symlink(target, linked);
  const second = await fixture(t, { recommendedRoot: linked }); second.homes.root = join(root, 'members');
  await assert.rejects(second.complete({ createRecommended: true, sharedDirectories: [{ path: linked, mode: 'read-only' }] }), { code: 'INVALID_INPUT' });
  assert.equal(second.setup.snapshot().required, true);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test('existing installations keep member access and settings when the setup domain is introduced', async t => {
  const f = await fixture(t, { legacy: true });
  assert.equal(f.setup.snapshot().required, false);
  assert.deepEqual(f.setup.snapshot().sharedDirectories, []);
  assert.equal((await f.auth.login('login', { username: 'member', password })).user.username, 'member');
  await assert.rejects(f.complete(), { code: 'SETUP_CONFLICT' });
});
