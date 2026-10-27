import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, MemoryStore } from '../core/service.js';

const password = 'personal-preferences-test-password';
async function fixture(t) {
  const store = new MemoryStore(), cap = {}, core = new LanService({ store, hostCapability: cap }); await core.start();
  const admin = await core.execute({ action: 'bootstrap', username: 'owner', displayName: 'Owner', password }, { ownerBootstrap: true });
  const caller = session => ({ token: session.token, csrf: session.csrf });
  const users = {}, sessions = {};
  for (const username of ['alice', 'bob']) {
    users[username] = (await core.execute({ action: 'admin.createUser', username, displayName: username, password }, caller(admin))).user;
    sessions[username] = await core.execute({ action: 'login', username, password });
  }
  t.after(() => core.close());
  return { store, core, cap, admin, users, sessions, caller,
    snapshot: name => core.execute({ action: 'snapshot' }, caller(sessions[name])),
    save: (name, access, expectedRevision = 0) => core.execute({ action: 'preferences.update', access, expectedRevision }, caller(sessions[name])),
    grant: (name, access) => updateAccount(core, { action: 'admin.updateUser', userId: users[name].id, access }, caller(admin)) };
}

test('personal capabilities persist, affect only the caller and survive a storage reload', async t => {
  const f = await fixture(t);
  const initial = await f.snapshot('alice');
  assert.equal(initial.preferences.revision, 0); assert.equal(initial.preferences.effective.files, true);
  await f.save('alice', { terminal: false, skills: ['skill-a'], mcpServers: [], agentPresets: ['standard'], plugins: [] });
  const after = await f.snapshot('alice'), bob = await f.snapshot('bob');
  assert.equal(after.preferences.revision, 1); assert.equal(after.preferences.effective.terminal, false);
  assert.deepEqual(after.preferences.effective.skills, ['skill-a']); assert.deepEqual(after.preferences.effective.mcpServers, []);
  assert.deepEqual(f.core.memberAccess(f.users.alice.id, f.cap), after.preferences.effective);
  assert.equal(bob.preferences.revision, 0); assert.equal(bob.preferences.effective.terminal, true); assert.equal(bob.preferences.effective.plugins, null);
  const restored = new LanService({ store: f.store, hostCapability: {} }); await restored.start(); t.after(() => restored.close());
  const login = await restored.execute({ action: 'login', username: 'alice', password });
  assert.deepEqual((await restored.execute({ action: 'snapshot' }, f.caller(login))).preferences.selection, after.preferences.selection);
  assert.equal(Object.hasOwn((await f.core.execute({ action: 'snapshot' }, f.caller(f.admin))).admin.users[1], 'preferences'), false, 'personal choices are not another member’s account metadata');
});

test('personal selections cannot expand administrator grants, directory access or another account', async t => {
  const f = await fixture(t);
  await f.grant('alice', { terminal: false, skills: ['allowed'], mcpServers: [], plugins: ['plugin-a'] });
  await f.save('alice', { terminal: true, skills: ['allowed'], plugins: null });
  let own = await f.snapshot('alice');
  assert.equal(own.preferences.effective.terminal, false);
  assert.deepEqual(own.preferences.effective.plugins, ['plugin-a']); assert.deepEqual(own.preferences.effective.mcpServers, []);
  await assert.rejects(f.save('alice', { skills: ['forbidden'] }, 1), { code: 'FORBIDDEN' });
  await assert.rejects(f.save('alice', { sharedDirectories: [{ path: '/private', mode: 'read-write' }] }, 1), { code: 'INVALID_INPUT' });
  await assert.rejects(f.core.execute({ action: 'preferences.update', access: {}, expectedRevision: 1, userId: f.users.bob.id }, f.caller(f.sessions.alice)), { code: 'INVALID_INPUT' });
  await f.grant('alice', { skills: [] }); own = await f.snapshot('alice');
  assert.deepEqual(own.preferences.selection.skills, []); assert.deepEqual(own.preferences.effective.skills, []);
  assert.equal((await f.snapshot('bob')).preferences.effective.skills, null);
});

test('personal saves require CSRF, reject stale revisions, and do not publish failed writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.core.execute({ action: 'preferences.update', access: { files: false }, expectedRevision: 0 }, { token: f.sessions.alice.token }), { code: 'CSRF_INVALID' });
  await f.save('alice', { files: false });
  await assert.rejects(f.save('alice', { files: true }), { code: 'PREFERENCES_CONFLICT' });
  const save = f.store.save; f.store.save = async () => { throw Error('Synthetic storage failure'); };
  await assert.rejects(f.save('alice', { files: true }, 1), { code: 'STORAGE_FAILURE' }); f.store.save = save;
  assert.equal((await f.snapshot('alice')).preferences.effective.files, false);
  assert.equal((await f.snapshot('alice')).preferences.revision, 1);
});
