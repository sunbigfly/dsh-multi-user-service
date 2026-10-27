import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LanService, LanError, MemoryStore } from '../core/service.js';

const PASSWORD = 'correct horse battery staple';
const replacement = 'replacement password 12345';
const context = (session) => ({ token: session.token, csrf: session.csrf });
const request = (service, action, fields = {}, session) => action === 'admin.updateUser' ? updateAccount(service, { action, ...fields }, session ? context(session) : {}) : service.execute({ action, ...fields }, session ? context(session) : {});
const rejected = (promise, code, status) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof LanError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});
const bootstrapFields = { username: 'Owner', displayName: 'Owner', password: PASSWORD };

test('changing service accounts changes authority; names and client role fields never confer administrator access', async t => {
  const { service, admin, createMember } = await setup(t);
  const member = await createMember('different-account', 'Administrator');
  assert.equal(member.session.user.role, 'member');
  await rejected(request(service, 'admin.listUsers', {}, member.session), 'FORBIDDEN', 403);
  await rejected(request(service, 'login', { username: 'different-account', password: PASSWORD, role: 'admin' }), 'INVALID_INPUT');
  await request(service, 'logout', {}, admin);
  await rejected(request(service, 'admin.listUsers', {}, admin), 'UNAUTHENTICATED', 401);
  const fresh = await request(service, 'login', { username: 'different-account', password: PASSWORD });
  assert.equal(fresh.user.id, member.user.id); assert.equal(fresh.user.role, 'member');
  await rejected(request(service, 'admin.listUsers', {}, fresh), 'FORBIDDEN', 403);
});

async function setup(t, { store = new MemoryStore(), runtime = null, clock = { value: 1000 } } = {}) {
  const service = new LanService({ store, runtime, now: () => clock.value });
  await service.start();
  t.after(() => service.close());
  await service.setProviderKeys(['existing-provider']);
  const admin = await service.execute({ action: 'bootstrap', ...bootstrapFields }, { ownerBootstrap: true });
  const { route } = await request(service, 'admin.upsertRoute', {
    label: 'Shared model', provider: 'existing-provider', model: 'internal-model', enabled: true, default: true,
  }, admin);
  await request(service, 'admin.updateUser', { userId: admin.user.id, routeIds: [route.id], defaultRouteId: route.id }, admin);
  const createMember = async (username, displayName = username) => {
    const { user } = await request(service, 'admin.createUser', {
      username, displayName, password: PASSWORD, routeIds: [route.id], defaultRouteId: route.id,
    }, admin);
    const session = await request(service, 'login', { username, password: PASSWORD });
    return { user, session };
  };
  return { service, admin, route, store, runtime, clock, createMember };
}

test('MemoryStore clones on construction, load, and save', async () => {
  const state = { items: [] };
  const store = new MemoryStore(state);
  state.items.push('foreign');
  assert.deepEqual(await store.load(), { items: [] });
  const value = await store.load(); value.items.push('changed');
  assert.deepEqual(await store.load(), { items: [] });
  await store.save(value); value.items.push('later');
  assert.deepEqual(await store.load(), { items: ['changed'] });
});

test('snapshot sections retain current authentication and member visibility, and reject unknown sections', async t => {
  const { service, admin, createMember } = await setup(t);
  const { session } = await createMember('snapshot-member');
  for (const section of ['base', 'catalog', 'usage', 'full']) {
    const value = await request(service, 'snapshot', { section }, session);
    assert.equal(value.user.id, session.user.id);
    assert.equal(value.admin, undefined);
  }
  await rejected(request(service, 'snapshot', { section: 'private-host-state' }, admin), 'INVALID_INPUT');
  await request(service, 'logout', {}, session);
  await rejected(request(service, 'snapshot', { section: 'base' }, session), 'UNAUTHENTICATED', 401);
});

test('bootstrap requires owner context once; status reveals no user data', async (t) => {
  const store = new MemoryStore();
  const service = new LanService({ store });
  await service.start(); t.after(() => service.close());
  assert.deepEqual(Object.keys(await request(service, 'status')).sort(), ['capabilities', 'initialized']);
  await rejected(request(service, 'bootstrap', bootstrapFields), 'OWNER_REQUIRED', 403);
  await rejected(request(service, 'bootstrap', { ...bootstrapFields, ownerBootstrap: true }), 'INVALID_INPUT');
  const admin = await service.execute({ action: 'bootstrap', ...bootstrapFields }, { ownerBootstrap: true });
  assert.equal(admin.user.role, 'admin'); assert.equal(admin.user.username, 'owner');
  assert.match(admin.token, /^[A-Za-z0-9_-]{43}$/); assert.match(admin.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(admin.token, admin.csrf);
  await rejected(service.execute({ action: 'bootstrap', ...bootstrapFields }, { ownerBootstrap: true }), 'ALREADY_INITIALIZED', 409);
  const persisted = JSON.stringify(await store.load());
  for (const sensitive of [admin.token, admin.csrf, PASSWORD, 'sessions', 'password":"']) assert.ok(!persisted.includes(sensitive));
  const user = (await store.load()).users[0];
  assert.match(user.passwordHash, /^[0-9a-f]{128}$/); assert.match(user.passwordSalt, /^[0-9a-f]{32}$/);
  assert.ok(!('passwordHash' in admin.user));
  const status = await request(service, 'status');
  assert.equal(status.initialized, true); assert.equal(status.capabilities.mode, 'local-pilot');
  assert.equal(status.capabilities.isolatedExecution, false); assert.equal(status.capabilities.terminal, false);
  assert.equal(status.capabilities.sharedAccess, false); assert.equal(status.capabilities.modelInvocation, false);
  assert.ok(!JSON.stringify(status).includes(admin.user.username));
});

test('strict fields, CSRF, token authentication, username uniqueness and role protection', async (t) => {
  const { service, admin, route, createMember } = await setup(t);
  const { user, session } = await createMember('member');
  await rejected(request(service, 'snapshot'), 'UNAUTHENTICATED', 401);
  await rejected(service.execute({ action: 'logout' }, { token: session.token }), 'CSRF_INVALID', 403);
  await rejected(service.execute({ action: 'logout' }, { ...context(session), csrf: admin.csrf }), 'CSRF_INVALID', 403);
  await rejected(request(service, 'admin.createInvite', { routeIds: [] }, session), 'FORBIDDEN', 403);
  await rejected(request(service, 'admin.updateUser', { userId: user.id, role: 'owner' }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.createUser', { username: 'other', displayName: 'Other', password: PASSWORD, routeIds: [], role: 'admin' }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.createUser', { username: 'MEMBER', displayName: 'Duplicate', password: PASSWORD, routeIds: [] }, admin), 'USERNAME_TAKEN', 409);
  await rejected(request(service, 'admin.updateUser', { userId: admin.user.id, disabled: true }, admin), 'LAST_ADMIN', 409);
  await rejected(request(service, 'admin.updateUser', { userId: user.id, routeIds: 'bad-list' }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.updateUser', { userId: user.id, routeIds: [route.id, route.id] }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'projects.create', { cwd: 'C:/host', routeId: route.id }, session), 'INVALID_INPUT');
  await rejected(request(service, 'login', { username: 'member', password: 'wrong' }), 'INVALID_CREDENTIALS', 401);
  await rejected(request(service, 'login', { username: 'missing', password: 'wrong' }), 'INVALID_CREDENTIALS', 401);
  const me = await request(service, 'me', {}, session);
  assert.equal(me.user.id, user.id); assert.equal(me.user.role, 'member');
  assert.deepEqual(await request(service, 'logout', {}, session), { ok: true });
  await rejected(request(service, 'me', {}, session), 'UNAUTHENTICATED', 401);
});

test('session expiry and restart require fresh sign in; persisted credentials remain usable', async (t) => {
  const clock = { value: 1000 };
  const { service, store, admin } = await setup(t, { clock });
  clock.value += 12 * 60 * 60 * 1000;
  await rejected(request(service, 'me', {}, admin), 'UNAUTHENTICATED', 401);
  const fresh = await request(service, 'login', { username: 'owner', password: PASSWORD });
  const restarted = new LanService({ store, now: () => clock.value });
  await restarted.start(); t.after(() => restarted.close());
  await rejected(request(restarted, 'me', {}, fresh), 'UNAUTHENTICATED', 401);
  assert.equal((await request(restarted, 'login', { username: 'owner', password: PASSWORD })).user.id, admin.user.id);
});

test('invites persist only hash, are single-use under concurrent redemption, cannot grant admin, and expire', async (t) => {
  const { service, admin, route, store, clock } = await setup(t);
  const invitation = await request(service, 'admin.createInvite', { routeIds: [route.id], defaultRouteId: route.id, displayName: 'Suggested' }, admin);
  const stored = await store.load();
  assert.equal(stored.invites[0].tokenHash, createHash('sha256').update(invitation.inviteToken).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(invitation.inviteToken));
  const attempts = await Promise.allSettled(['alice', 'bob'].map((username) => request(service, 'redeem', {
    inviteToken: invitation.inviteToken, username, password: PASSWORD, displayName: username,
  })));
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((entry) => entry.status === 'fulfilled').value.user.role, 'member');
  assert.equal(attempts.find((entry) => entry.status === 'rejected').reason.code, 'INVITE_INVALID');
  assert.equal((await store.load()).invites[0].usedBy, attempts.find(entry => entry.status === 'fulfilled').value.user.id);
  const next = await request(service, 'admin.createInvite', { routeIds: [] }, admin);
  clock.value = next.expiresAt;
  await rejected(request(service, 'redeem', { inviteToken: next.inviteToken, username: 'expired', password: PASSWORD, displayName: 'Expired' }), 'INVITE_INVALID');
});

test('disable and reset revoke every session after durable save', async (t) => {
  const { service, admin, createMember } = await setup(t);
  const { user, session } = await createMember('member');
  const second = await request(service, 'login', { username: 'member', password: PASSWORD });
  await request(service, 'admin.resetPassword', { userId: user.id, password: replacement }, admin);
  await rejected(request(service, 'me', {}, session), 'UNAUTHENTICATED', 401);
  await rejected(request(service, 'me', {}, second), 'UNAUTHENTICATED', 401);
  await rejected(request(service, 'login', { username: 'member', password: PASSWORD }), 'INVALID_CREDENTIALS', 401);
  const current = await request(service, 'login', { username: 'member', password: replacement });
  await request(service, 'admin.updateUser', { userId: user.id, disabled: true }, admin);
  await rejected(request(service, 'me', {}, current), 'UNAUTHENTICATED', 401);
  await rejected(request(service, 'login', { username: 'member', password: replacement }), 'INVALID_CREDENTIALS', 401);
  await request(service, 'admin.updateUser', { userId: user.id, disabled: false }, admin);
  await rejected(request(service, 'me', {}, current), 'UNAUTHENTICATED', 401);
  assert.equal((await request(service, 'login', { username: 'member', password: replacement })).user.disabled, false);
});

test('route allowlists, immutable reservations and ownership are enforced before fail-closed execution', async (t) => {
  const runtime = { reviewed: true, openProject() { assert.fail('must not execute'); }, openTerminal() { assert.fail('must not execute'); } };
  const { service, admin, route, createMember, clock } = await setup(t, { runtime });
  const alice = await createMember('alice', 'Alice');
  const bob = await createMember('bob', 'Bob');
  const { project } = await request(service, 'projects.create', { title: 'Private Alice title' }, alice.session);
  assert.equal(project.state, 'reserved'); assert.equal(project.rootSessionId, null);
  assert.equal(project.relativePath, `${alice.user.id}/${project.id}`);
  await rejected(request(service, 'projects.open', { projectId: project.id }, alice.session), 'ISOLATION_UNAVAILABLE', 503);
  await rejected(request(service, 'terminal.open', { projectId: project.id }, alice.session), 'ISOLATION_UNAVAILABLE', 503);
  await rejected(request(service, 'projects.open', { projectId: project.id }, bob.session), 'PROJECT_NOT_FOUND', 404);
  await rejected(request(service, 'projects.rename', { projectId: project.id, title: 'Stolen' }, admin), 'PROJECT_NOT_FOUND', 404);
  await rejected(request(service, 'projects.activity', { projectId: project.id, event: 'heartbeat' }, alice.session), 'INVALID_INPUT');
  await rejected(request(service, 'projects.activity', { projectId: project.id, event: 'user-input', timestamp: 99999 }, alice.session), 'INVALID_INPUT');
  clock.value += 50;
  const active = await request(service, 'projects.activity', { projectId: project.id, event: 'user-input' }, alice.session);
  assert.equal(active.project.lastActivityAt, clock.value);
  await request(service, 'admin.updateUser', { userId: alice.user.id, routeIds: [] }, admin);
  await rejected(request(service, 'projects.open', { projectId: project.id }, alice.session), 'ROUTE_UNAVAILABLE', 403);
  await rejected(request(service, 'terminal.open', { projectId: project.id }, alice.session), 'ROUTE_UNAVAILABLE', 403);
  const renamed = await request(service, 'projects.rename', { projectId: project.id, title: 'Metadata still editable' }, alice.session);
  assert.equal(renamed.project.id, project.id); assert.equal(renamed.project.relativePath, project.relativePath);
  await request(service, 'admin.updateUser', { userId: alice.user.id, routeIds: [route.id] }, admin);
  await service.setProviderKeys([]);
  await rejected(request(service, 'projects.open', { projectId: project.id }, alice.session), 'ROUTE_UNAVAILABLE', 403);
  const bobSnapshot = await request(service, 'snapshot', {}, bob.session);
  assert.equal(bobSnapshot.projects.length, 0);
  assert.ok(!JSON.stringify(bobSnapshot).includes('Private Alice title'));
  assert.deepEqual(Object.keys(bobSnapshot.routes[0]).sort(), ['default', 'enabled', 'id', 'label']);
  assert.ok(!('admin' in bobSnapshot));
});

test('provider registry is authoritative and shared environment accepts controlled metadata only', async (t) => {
  const { service, admin } = await setup(t);
  await rejected(request(service, 'admin.upsertRoute', { label: 'Bad', provider: 'missing', model: 'model', enabled: true }, admin), 'PROVIDER_UNAVAILABLE', 409);
  await rejected(request(service, 'admin.upsertRoute', { label: 'Bad', provider: 'https://host', model: 'model', enabled: true }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.upsertRoute', { label: 'Bad', provider: 'existing-provider', model: 'model', enabled: true, apiKey: 'SECRET' }, admin), 'INVALID_INPUT');
  const first = await request(service, 'admin.publishEnvironment', {
    skills: ['skill-id'], mcp: [{ id: 'approved-mcp', label: 'Approved metadata' }], agents: [],
  }, admin);
  assert.equal(first.environment.version, 1);
  assert.deepEqual(first.environment.skills, [{ id: 'skill-id', label: 'skill-id' }]);
  await rejected(request(service, 'admin.publishEnvironment', { skills: [], mcp: [{ id: 'evil', label: 'Evil', command: 'host command' }], agents: [] }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.publishEnvironment', { skills: ['a', 'a'], mcp: [], agents: [] }, admin), 'INVALID_INPUT');
  await rejected(request(service, 'admin.publishEnvironment', { skills: ['../escape'], mcp: [], agents: [] }, admin), 'INVALID_INPUT');
  const second = await request(service, 'admin.publishEnvironment', { skills: [], mcp: [], agents: ['approved-agent'] }, admin);
  assert.equal(second.environment.version, 2);
  const snapshot = await request(service, 'snapshot', {}, admin);
  assert.deepEqual(snapshot.admin.availableProviderKeys, ['existing-provider']);
  assert.ok(snapshot.admin.routes[0].provider); assert.ok(!JSON.stringify(snapshot.admin.users).includes('passwordHash'));
});

test('usage is trusted internal-only, privacy-preserving and unknown independently of zero', async (t) => {
  const runtime = {};
  const { service, createMember } = await setup(t, { runtime });
  const alice = await createMember('alice', 'Alice public');
  const bob = await createMember('bob', 'Bob public');
  const { project } = await request(service, 'projects.create', { title: 'Top secret project' }, alice.session);
  const before = await request(service, 'snapshot', {}, bob.session);
  const row = before.usage.users.find((entry) => entry.displayName === 'Alice public');
  assert.equal(row.totalTokens, null); assert.equal(row.calls, null);
  await rejected(request(service, 'recordUsage', { projectId: project.id, totalTokens: 999 }, alice.session), 'INVALID_INPUT');
  await rejected(request(service, 'usage.record', {}, alice.session), 'UNKNOWN_ACTION', 404);
  await rejected(service.recordUsage({ projectId: project.id, inputTokens: 1, outputTokens: 2, totalTokens: 3 }), 'UNTRUSTED_RUNTIME', 403);
  await rejected(service.recordUsage({ projectId: project.id, inputTokens: 1, outputTokens: 2, totalTokens: 2 }, runtime), 'INVALID_INPUT');
  await rejected(service.recordUsage({ projectId: project.id, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }, runtime), 'INVALID_INPUT');
  await service.recordUsage({ projectId: project.id, inputTokens: 10, outputTokens: 20, totalTokens: 30 }, runtime);
  let board = (await request(service, 'snapshot', {}, bob.session)).usage;
  let aliceRow = board.users.find((entry) => entry.displayName === 'Alice public');
  assert.equal(aliceRow.calls, 1); assert.equal(aliceRow.totalTokens, 30); assert.equal(aliceRow.unknownCalls, 0);
  await service.recordUsage({ projectId: project.id }, runtime);
  board = (await request(service, 'snapshot', {}, bob.session)).usage;
  aliceRow = board.users.find((entry) => entry.displayName === 'Alice public');
  assert.equal(aliceRow.calls, 2); assert.equal(aliceRow.totalTokens, 30); assert.equal(aliceRow.unknownCalls, 1); assert.equal(aliceRow.incomplete, true);
  assert.equal(aliceRow.knownCalls, 1); assert.equal(aliceRow.knownTokens.totalTokens, 30);
  const serialized = JSON.stringify(board);
  for (const privateValue of [project.id, project.relativePath, project.title, alice.user.id, 'internal-model', 'existing-provider', 'routeIds']) {
    assert.ok(!serialized.includes(privateValue));
  }
});

class SwitchStore extends MemoryStore {
  fail = false;
  gate = null;
  onSave = null;
  async save(state) {
    this.onSave?.();
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('private storage details');
    return super.save(state);
  }
}

test('durable account failure does not publish or change credentials; precommitted revocation remains fail-closed', async (t) => {
  const store = new SwitchStore();
  const { service, admin, createMember } = await setup(t, { store });
  const { user, session } = await createMember('member');
  const invitation = await request(service, 'admin.createInvite', { routeIds: [] }, admin);
  const before = await store.load();
  store.fail = true;
  await rejected(request(service, 'admin.updateUser', { userId: user.id, disabled: true }, admin), 'STORAGE_FAILURE', 503);
  await rejected(request(service, 'admin.resetPassword', { userId: user.id, password: replacement }, admin), 'STORAGE_FAILURE', 503);
  await rejected(request(service, 'redeem', { inviteToken: invitation.inviteToken, username: 'newbie', displayName: 'New', password: PASSWORD }), 'STORAGE_FAILURE', 503);
  // Independent session storage must revoke before the account mutation. A
  // failed account commit may conservatively sign out, never resurrect tokens.
  await rejected(request(service, 'me', {}, session), 'UNAUTHENTICATED', 401);
  assert.deepEqual(await store.load(), before);
  assert.equal((await request(service, 'login', { username: 'member', password: PASSWORD })).user.id, user.id);
  store.fail = false;
  assert.equal((await request(service, 'redeem', { inviteToken: invitation.inviteToken, username: 'newbie', displayName: 'New', password: PASSWORD })).user.role, 'member');
});

test('reads and competing writes wait until durable save publishes, without lost updates', async (t) => {
  const store = new SwitchStore();
  const { service, admin } = await setup(t, { store });
  let release;
  let saved;
  const started = new Promise((resolve) => { saved = resolve; });
  store.gate = new Promise((resolve) => { release = resolve; });
  store.onSave = saved;
  const first = request(service, 'admin.publishEnvironment', { skills: ['first'], mcp: [], agents: [] }, admin);
  await started;
  let readSettled = false;
  const read = request(service, 'snapshot', {}, admin).then((value) => { readSettled = true; return value; });
  const second = request(service, 'admin.publishEnvironment', { skills: ['second'], mcp: [], agents: [] }, admin);
  await Promise.resolve();
  assert.equal(readSettled, false);
  release(); store.gate = null; store.onSave = null;
  assert.equal((await first).environment.version, 1);
  assert.equal((await read).admin.environment.skills[0].id, 'first');
  assert.equal((await second).environment.version, 2);
  assert.equal((await store.load()).environment.skills[0].id, 'second');
});

test('bootstrap save failure never initializes memory or emits a session', async (t) => {
  const store = new SwitchStore(); store.fail = true;
  const service = new LanService({ store }); await service.start(); t.after(() => service.close());
  await rejected(service.execute({ action: 'bootstrap', ...bootstrapFields }, { ownerBootstrap: true }), 'STORAGE_FAILURE', 503);
  assert.equal((await request(service, 'status')).initialized, false);
  assert.equal(await store.load(), null);
  store.fail = false;
  assert.equal((await service.execute({ action: 'bootstrap', ...bootstrapFields }, { ownerBootstrap: true })).user.role, 'admin');
});

test('start rejects foreign, unknown-version and corrupt persisted documents without overwriting', async (t) => {
  const { store } = await setup(t);
  const valid = await store.load();
  const cases = [undefined, {}, { ...valid, version: 2 }, { ...valid, token: 'secret' }];
  const noAdmin = structuredClone(valid); noAdmin.users[0].disabled = true; cases.push(noAdmin);
  const unsafePath = structuredClone(valid);
  unsafePath.projects.push({ id: `prj_${'a'.repeat(32)}`, ownerId: valid.users[0].id, title: 'Invalid',
    relativePath: '../host', rootSessionId: null, state: 'reserved', routeId: valid.routes[0].id,
    createdAt: 0, updatedAt: 0, lastActivityAt: 0 }); cases.push(unsafePath);
  const credential = structuredClone(valid); credential.users[0].passwordHash = 'bad'; cases.push(credential);
  const unknownReference = structuredClone(valid); unknownReference.users[0].routeIds.push(`rte_${'f'.repeat(32)}`); cases.push(unknownReference);
  const corruptUsage = structuredClone(valid); corruptUsage.usage.push({ userId: valid.users[0].id, calls: 1, unknownCalls: 2, inputTokens: 0, outputTokens: 0, totalTokens: 0 }); cases.push(corruptUsage);
  for (const data of cases) {
    let saves = 0;
    const service = new LanService({ store: { async load() { return data; }, async save() { saves += 1; } } });
    await rejected(service.start(), 'STORAGE_INVALID', 503);
    await rejected(request(service, 'status'), 'SERVICE_UNAVAILABLE', 503);
    assert.equal(saves, 0); await service.close();
  }
});

test('returned snapshots do not alias in-memory policy; close revokes access', async (t) => {
  const { service, admin, route } = await setup(t);
  const snapshot = await request(service, 'snapshot', {}, admin);
  snapshot.admin.users[0].disabled = true;
  snapshot.admin.routes[0].label = 'Tampered';
  snapshot.user.routeIds.length = 0;
  const next = await request(service, 'snapshot', {}, admin);
  assert.equal(next.user.disabled, false); assert.equal(next.admin.routes[0].label, route.label);
  await service.close();
  await rejected(request(service, 'status'), 'SERVICE_UNAVAILABLE', 503);
});
