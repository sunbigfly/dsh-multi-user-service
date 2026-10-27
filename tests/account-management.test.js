import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, MemoryStore } from '../core/service.js';

const password = 'synthetic account management password';
const context = session => ({ token: session.token, csrf: session.csrf });
async function fixture(t, options = {}) {
  const store = new MemoryStore(), core = new LanService({ store, ...options });
  await core.start(); t.after(() => core.close());
  const admin = await core.execute({ action: 'bootstrap', username: 'owner', displayName: 'Owner', password }, { ownerBootstrap: true });
  const member = (await core.execute({ action: 'admin.createUser', username: 'member', displayName: 'Member', password }, context(admin))).user;
  return { core, store, admin, member, request: (action, fields = {}, auth = admin) => core.execute({ action, ...fields }, context(auth)) };
}

test('bulk permission updates preserve identities, preferences and untouched grants in one revision-checked save', async t => {
  const f = await fixture(t), second = (await f.request('admin.createUser', { username: 'second', displayName: 'Second', password, access: { terminal: false, tools: ['read'] } })).user;
  await f.request('admin.updateUser', { userId: second.id, expectedRevision: 0, disabled: true });
  const before = await f.store.load(), targets = before.users.filter(user => [f.member.id, second.id].includes(user.id)).map(user => ({ userId: user.id, expectedRevision: user.revision ?? 0 }));
  const result = await f.request('admin.batchUpdateAccess', { targets, modelAccess: 'custom', routeIds: [], defaultRouteId: null, access: { files: false } });
  assert.deepEqual(result, { updatedUserIds: targets.map(row => row.userId), count: 2 });
  const after = await f.store.load();
  for (const target of targets) {
    const old = before.users.find(row => row.id === target.userId), saved = after.users.find(row => row.id === target.userId);
    assert.deepEqual(saved, { ...old, modelAccess: 'custom', routeIds: [], defaultRouteId: null, access: { ...old.access, files: false }, revision: target.expectedRevision + 1 });
  }
  const unchanged = await f.store.load();
  await assert.rejects(f.request('admin.batchUpdateAccess', { targets: [{ ...targets[0], expectedRevision: 1 }, targets[1]], access: { terminal: false } }), { code: 'ACCOUNT_CONFLICT' });
  assert.deepEqual(await f.store.load(), unchanged, 'one stale account must prevent every write');
  const fresh = targets.map(target => ({ ...target, expectedRevision: target.expectedRevision + 1 }));
  const save = f.store.save.bind(f.store); f.store.save = async () => { throw Error('Synthetic disk failure'); };
  await assert.rejects(f.request('admin.batchUpdateAccess', { targets: fresh, access: { terminal: false } }), { code: 'STORAGE_FAILURE' });
  f.store.save = save;
  assert.deepEqual(await f.store.load(), unchanged);
  assert.equal((await f.request('admin.getUser', { userId: f.member.id })).user.access.terminal, true);
});

test('bulk permissions reject invalid, archived and unauthorized targets without partial writes', async t => {
  const f = await fixture(t), target = { userId: f.member.id, expectedRevision: 0 }, fields = { targets: [target], access: { terminal: false } };
  const member = await f.request('login', { username: 'member', password });
  await assert.rejects(f.request('admin.batchUpdateAccess', fields, member), { code: 'FORBIDDEN' });
  await assert.rejects(f.core.execute({ action: 'admin.batchUpdateAccess', ...fields }, { token: f.admin.token }), { code: 'CSRF_INVALID' });
  for (const invalid of [{ targets: [] }, { targets: Array(101).fill(target) }, { targets: [target, target] }, { targets: [target, { userId: `usr_${'f'.repeat(32)}`, expectedRevision: 0 }] }, { disabled: true }, { access: { unexpected: true } }, { routeIds: [`rte_${'f'.repeat(32)}`] }]) {
    const before = await f.store.load();
    await assert.rejects(f.request('admin.batchUpdateAccess', { ...fields, ...invalid }));
    assert.deepEqual(await f.store.load(), before);
  }
  await f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 0 });
  await assert.rejects(f.request('admin.batchUpdateAccess', { ...fields, targets: [{ ...target, expectedRevision: 1 }] }), { code: 'ACCOUNT_ARCHIVED' });
});

test('all matching accounts can be selected beyond pagination and saved with a bounded login-bound snapshot', async t => {
  const f = await fixture(t), seed = await f.store.load(), template = seed.users.find(user => user.id === f.member.id);
  for (let i = 0; i < 180; i++) seed.users.push({ ...structuredClone(template), id: `usr_${(i + 1000).toString(16).padStart(32, '0')}`, username: `batch-${i}`, displayName: `Batch ${i}`, disabled: i % 3 === 0, revision: 0 });
  const store = new MemoryStore(seed); let now = 1000;
  const core = new LanService({ store, now: () => now }); await core.start(); t.after(() => core.close());
  const first = await core.execute({ action: 'login', username: 'owner', password }), second = await core.execute({ action: 'login', username: 'owner', password });
  const call = (action, fields = {}, session = first) => core.execute({ action, ...fields }, context(session));
  const selected = await call('admin.prepareBatchAccess', { query: 'batch-', status: 'enabled', capture: false });
  assert.equal(selected.count, 120); assert.equal(selected.userIds.length, 120); assert.equal(selected.items.length, 50); assert.equal(selected.selectionId, undefined);
  const ticket = await call('admin.prepareBatchAccess', { userIds: selected.userIds });
  assert.equal(ticket.count, 120);
  assert.ok(JSON.stringify({ action: 'admin.batchUpdateAccess', selectionId: ticket.selectionId, access: { files: false } }).length < 200);
  await assert.rejects(call('admin.batchUpdateAccess', { selectionId: ticket.selectionId, access: { files: false } }, second), { code: 'FORBIDDEN' });
  await call('admin.updateUser', { userId: selected.userIds[0], expectedRevision: 0, access: { terminal: false } });
  const before = await store.load();
  await assert.rejects(call('admin.batchUpdateAccess', { selectionId: ticket.selectionId, access: { files: false } }), { code: 'ACCOUNT_CONFLICT' });
  assert.deepEqual(await store.load(), before);
  const fresh = await call('admin.prepareBatchAccess', { userIds: selected.userIds });
  assert.equal((await call('admin.batchUpdateAccess', { selectionId: fresh.selectionId, access: { files: false } })).count, 120);
  const ids = new Set(selected.userIds), after = await store.load();
  for (const user of after.users) assert.equal(user.access?.files === false, ids.has(user.id));
  await assert.rejects(call('admin.batchUpdateAccess', { selectionId: fresh.selectionId, access: { files: true } }), { code: 'BATCH_SELECTION_EXPIRED' });
  const expiring = await call('admin.prepareBatchAccess', { userIds: selected.userIds }); now += 15 * 60 * 1000 + 1;
  await assert.rejects(call('admin.batchUpdateAccess', { selectionId: expiring.selectionId, access: { files: true } }), { code: 'BATCH_SELECTION_EXPIRED' });
  await assert.rejects(core.execute({ action: 'admin.prepareBatchAccess', query: '' }, { token: first.token }), { code: 'CSRF_INVALID' });
  const member = await call('login', { username: 'member', password });
  await assert.rejects(call('admin.prepareBatchAccess', { query: '' }, member), { code: 'FORBIDDEN' });
});

test('invitation lifecycle is visible without exposing tokens and reissue invalidates the old link', async t => {
  const f = await fixture(t), first = await f.request('admin.createInvite', { displayName: 'Invited' });
  let list = await f.request('admin.listInvites');
  assert.equal(list.items[0].status, 'pending'); assert.equal(list.items[0].revision, 0);
  assert.equal(JSON.stringify(list).includes(first.inviteToken), false); assert.equal(JSON.stringify(list).includes('tokenHash'), false);
  await f.request('admin.revokeInvite', { inviteId: first.id, expectedRevision: 0 });
  const redeem = (token, username) => f.request('redeem', { inviteToken: token, username, displayName: username, password });
  await assert.rejects(redeem(first.inviteToken, 'old-link'), { code: 'INVITE_INVALID' });
  await assert.rejects(f.request('admin.reissueInvite', { inviteId: first.id, expectedRevision: 0 }), { code: 'INVITE_CONFLICT' });
  const next = await f.request('admin.reissueInvite', { inviteId: first.id, expectedRevision: 1 });
  assert.notEqual(next.id, first.id); assert.notEqual(next.inviteToken, first.inviteToken);
  const attempts = await Promise.allSettled(['accepted-a', 'accepted-b'].map(name => redeem(next.inviteToken, name)));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  list = await f.request('admin.listInvites');
  assert.deepEqual(list.items.map(row => row.status), ['used', 'revoked']);
  assert.equal(list.items[0].usedBy, attempts.find(row => row.status === 'fulfilled').value.user.id);
  const member = await f.request('login', { username: 'member', password });
  await assert.rejects(f.request('admin.listInvites', {}, member), { code: 'FORBIDDEN' });
  await assert.rejects(f.core.execute({ action: 'admin.reissueInvite', inviteId: first.id, expectedRevision: 2 }, { token: f.admin.token }), { code: 'CSRF_INVALID' });
});

test('expired and legacy invitations remain visible and failed reissue preserves the old token', async t => {
  const clock = { value: 1000 }, f = await fixture(t, { now: () => clock.value });
  const invite = await f.request('admin.createInvite');
  clock.value = invite.expiresAt;
  // Admin sign-in expired too; renew before testing an invitation mutation.
  f.admin = await f.core.execute({ action: 'login', username: 'owner', password });
  assert.equal((await f.core.execute({ action: 'admin.listInvites' }, context(f.admin))).items[0].status, 'expired');
  const next = await f.core.execute({ action: 'admin.reissueInvite', inviteId: invite.id, expectedRevision: 0 }, context(f.admin));
  const save = f.store.save.bind(f.store); f.store.save = async () => { throw Error('Synthetic failure'); };
  await assert.rejects(f.core.execute({ action: 'admin.reissueInvite', inviteId: next.id, expectedRevision: 0 }, context(f.admin)), { code: 'STORAGE_FAILURE' }); f.store.save = save;
  assert.equal((await f.core.execute({ action: 'redeem', inviteToken: next.inviteToken, username: 'still-valid', displayName: 'Valid', password })).user.username, 'still-valid');
  const stored = await f.store.load(); for (const row of stored.invites) delete row.revision;
  await f.store.save(stored);
  const restored = new LanService({ store: f.store, now: () => clock.value }); await restored.start(); t.after(() => restored.close());
  const auth = await restored.execute({ action: 'login', username: 'owner', password });
  const list = await restored.execute({ action: 'admin.listInvites' }, context(auth));
  assert.deepEqual(list.items.map(row => row.status), ['used', 'revoked']); assert.ok(list.items.every(row => row.revision === 0));
});

test('self password change verifies the old password and revokes every old login', async t => {
  const f = await fixture(t), member = await f.request('login', { username: 'member', password });
  const second = await f.request('login', { username: 'member', password });
  const newPassword = 'replacement synthetic password';
  await assert.rejects(f.request('password.change', { currentPassword: 'incorrect', password: newPassword }, member), { code: 'CURRENT_PASSWORD_INVALID', status: 403 });
  assert.equal((await f.request('me', {}, member)).user.id, f.member.id);
  await assert.rejects(f.core.execute({ action: 'password.change', currentPassword: password, password: newPassword }, { token: member.token }), { code: 'CSRF_INVALID' });
  await assert.rejects(f.request('password.change', { currentPassword: password, password: newPassword, userId: f.admin.user.id }, member), { code: 'INVALID_INPUT' });
  await assert.rejects(f.request('password.change', { currentPassword: password, password }, member), { code: 'PASSWORD_UNCHANGED' });
  const changed = await f.request('password.change', { currentPassword: password, password: newPassword }, member);
  assert.equal(changed.signedOut, true);
  for (const login of [member, second]) await assert.rejects(f.request('me', {}, login), { code: 'UNAUTHENTICATED' });
  await assert.rejects(f.request('login', { username: 'member', password }), { code: 'INVALID_CREDENTIALS' });
  assert.equal((await f.request('login', { username: 'member', password: newPassword })).user.id, f.member.id);
  assert.equal((await f.request('me')).user.id, f.admin.user.id);
});

test('password attempts are throttled and failed storage never publishes new credentials', async t => {
  const f = await fixture(t), member = await f.request('login', { username: 'member', password });
  for (let i = 0; i < 10; i++) await assert.rejects(f.request('password.change', { currentPassword: 'incorrect', password: 'replacement synthetic password' }, member), { code: 'CURRENT_PASSWORD_INVALID' });
  await assert.rejects(f.request('password.change', { currentPassword: password, password: 'replacement synthetic password' }, member), { code: 'AUTH_RATE_LIMIT', status: 429 });
  const save = f.store.save.bind(f.store); f.store.save = async () => { throw Error('Synthetic failure'); };
  await assert.rejects(f.request('password.change', { currentPassword: password, password: 'replacement synthetic password' }), { code: 'STORAGE_FAILURE' });
  f.store.save = save;
  await assert.rejects(f.request('me'), { code: 'UNAUTHENTICATED' });
  assert.equal((await f.request('login', { username: 'owner', password })).user.id, f.admin.user.id);
  await assert.rejects(f.request('login', { username: 'owner', password: 'replacement synthetic password' }), { code: 'INVALID_CREDENTIALS' });
});

test('stale admin draft cannot reenable an account or restore revoked permissions', async t => {
  const f = await fixture(t), old = structuredClone(f.member);
  const changed = await f.request('admin.updateUser', { userId: old.id, expectedRevision: old.revision, disabled: true, access: { terminal: false } });
  assert.equal(changed.user.revision, 1);
  await assert.rejects(f.request('admin.updateUser', { userId: old.id, expectedRevision: old.revision, disabled: false, access: { ...old.access, files: false } }), { code: 'ACCOUNT_CONFLICT', status: 409 });
  const current = (await f.request('snapshot')).admin.users.find(user => user.id === old.id);
  assert.equal(current.disabled, true); assert.equal(current.access.terminal, false); assert.equal(current.access.files, true);
  await assert.rejects(f.request('admin.updateUser', { userId: old.id, disabled: false }), { code: 'INVALID_INPUT' });
});

test('display-name edits preserve identity and administrator handover revokes previous role sessions', async t => {
  const f = await fixture(t), oldMemberLogin = await f.request('login', { username: 'member', password });
  await assert.rejects(f.request('admin.updateUser', { userId: f.admin.user.id, expectedRevision: 0, role: 'member' }), { code: 'LAST_ADMIN' });
  const updated = await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 0, displayName: 'New name', role: 'admin' });
  assert.equal(updated.user.id, f.member.id); assert.equal(updated.user.username, 'member'); assert.equal(updated.user.displayName, 'New name'); assert.equal(updated.roleChanged, true);
  await assert.rejects(f.request('me', {}, oldMemberLogin), { code: 'UNAUTHENTICATED' });
  const successor = await f.request('login', { username: 'member', password });
  assert.equal(successor.user.role, 'admin');
  await f.request('admin.updateUser', { userId: f.admin.user.id, expectedRevision: 0, role: 'member' }, successor);
  await assert.rejects(f.request('me'), { code: 'UNAUTHENTICATED' });
  const former = await f.request('login', { username: 'owner', password });
  await assert.rejects(f.request('admin.listInvites', {}, former), { code: 'FORBIDDEN' });
  await assert.rejects(f.request('admin.updateUser', { userId: successor.user.id, expectedRevision: 1, disabled: true }, successor), { code: 'LAST_ADMIN' });
  assert.equal((await f.request('me', {}, successor)).user.role, 'admin');
});

test('simultaneous self-demotions leave one enabled administrator', async t => {
  const f = await fixture(t);
  const promoted = await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 0, role: 'admin' });
  const successor = await f.request('login', { username: 'member', password });
  const result = await Promise.allSettled([[f.admin, 0], [successor, promoted.user.revision]].map(([session, revision]) => f.request('admin.updateUser', { userId: session.user.id, expectedRevision: revision, role: 'member' }, session)));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1); assert.equal(result.find(row => row.status === 'rejected').reason.code, 'LAST_ADMIN');
  assert.equal((await f.store.load()).users.filter(row => row.role === 'admin' && !row.disabled).length, 1);
});

test('administrator recovery requires trusted owner context and cannot promote a member', async t => {
  const f = await fixture(t), recover = { action: 'owner.recoverAdministrator', username: 'owner', password: 'recovered administrator password' };
  await assert.rejects(f.core.execute(recover), { code: 'OWNER_REQUIRED' });
  await assert.rejects(f.core.execute(recover, { ...context(f.admin), ownerBootstrap: true, audience: 'member' }), { code: 'OWNER_REQUIRED' });
  await assert.rejects(f.core.execute({ ...recover, username: 'member' }, { ownerBootstrap: true }), { code: 'USER_NOT_FOUND' });
  const result = await f.core.execute(recover, { ownerBootstrap: true }); assert.equal(result.userId, f.admin.user.id); assert.equal(result.ok, true);
  await assert.rejects(f.request('me'), { code: 'UNAUTHENTICATED' });
  await assert.rejects(f.request('login', { username: 'owner', password }), { code: 'INVALID_CREDENTIALS' });
  const renewed = await f.request('login', { username: 'owner', password: recover.password }); assert.equal(renewed.user.role, 'admin'); assert.equal(renewed.user.revision, 1);
  assert.equal((await f.request('login', { username: 'member', password })).user.id, f.member.id);
});

test('administrator detail separates grants, personal choices and effective access without leaking credentials', async t => {
  const f = await fixture(t), member = await f.request('login', { username: 'member', password });
  await f.request('preferences.update', { expectedRevision: 0, access: { terminal: false, skills: ['allowed'] } }, member);
  await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 0, access: { files: false, skills: ['allowed', 'extra'] } });
  const view = await f.request('admin.getUser', { userId: f.member.id });
  assert.equal(view.preferences.granted.terminal, true); assert.equal(view.preferences.selection.terminal, false); assert.equal(view.preferences.effective.terminal, false);
  assert.equal(view.preferences.granted.files, false); assert.equal(view.preferences.selection.files, true); assert.equal(view.preferences.effective.files, false);
  assert.deepEqual(view.preferences.effective.skills, ['allowed']);
  assert.doesNotMatch(JSON.stringify(view), /password|token|csrf/i);
  await assert.rejects(f.request('admin.getUser', { userId: f.admin.user.id }, member), { code: 'FORBIDDEN' });
  await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 1, disabled: true });
  const disabled = await f.request('admin.getUser', { userId: f.member.id });
  assert.ok(Object.values(disabled.preferences.effective).every(value => value === false || Array.isArray(value) && !value.length));
});

test('member search and paging are served by the backend and snapshots contain only the first page', async t => {
  const f = await fixture(t), stored = await f.store.load(), template = stored.users.find(row => row.id === f.member.id);
  for (let i = 0; i < 80; i++) stored.users.push({ ...structuredClone(template), id: 'usr_' + (i + 1).toString(16).padStart(32, '0'), username: `user-${String(i).padStart(3, '0')}`, displayName: `Team ${i}`, disabled: i % 2 === 0 });
  await f.store.save(stored);
  const core = new LanService({ store: f.store }); await core.start(); t.after(() => core.close());
  const admin = await core.execute({ action: 'login', username: 'owner', password });
  const list = fields => core.execute({ action: 'admin.listUsers', ...fields }, context(admin));
  const snapshot = await core.execute({ action: 'snapshot', section: 'base' }, context(admin));
  assert.equal(snapshot.admin.users.length, 10); assert.equal(snapshot.admin.userPage.total, 82); assert.equal(snapshot.admin.userPage.pages, 9);
  const second = await list({ page: 1, pageSize: 20 });
  assert.equal(second.items.length, 20); assert.equal(second.total, 82); assert.equal(second.page, 1);
  assert.equal(second.items[0].username, 'user-018');
  const found = await list({ query: 'USER-007' }); assert.equal(found.total, 1); assert.equal(found.items[0].username, 'user-007');
  const disabled = await list({ status: 'disabled', pageSize: 50 }); assert.equal(disabled.total, 40); assert.ok(disabled.items.every(row => row.disabled));
  const empty = await list({ query: 'no-such-user', page: 999 }); assert.deepEqual(empty.items, []); assert.equal(empty.page, 0); assert.equal(empty.pages, 1);
  const end = await list({ page: 999 }); assert.equal(end.page, 8); assert.equal(end.items.length, 2);
  const summary = await list({ query: 'user-079', summary: true }); assert.deepEqual(Object.keys(summary.items[0]).sort(), ['archivedAt', 'deletedAt', 'disabled', 'displayName', 'id', 'role', 'username']);
  assert.doesNotMatch(JSON.stringify(second), /passwordHash|passwordSalt|csrf|tokenHash/);
  for (const fields of [{ page: -1 }, { pageSize: 10000 }, { query: ' too much whitespace ' }, { status: 'unknown' }, { summary: 'yes' }]) await assert.rejects(list(fields), { code: 'INVALID_INPUT' });
  const member = await core.execute({ action: 'login', username: 'member', password });
  await assert.rejects(core.execute({ action: 'admin.listUsers', summary: true }, context(member)), { code: 'FORBIDDEN' });
});

test('usage pages search account names and status without exposing private account fields', async t => {
  const f = await fixture(t), stored = await f.store.load(), template = stored.users.find(row => row.id === f.member.id);
  for (let i = 0; i < 21; i++) stored.users.push({ ...structuredClone(template), id: 'usr_' + (i + 1).toString(16).padStart(32, '0'), username: `usage-${i}`, displayName: `Team ${i}`, disabled: i % 2 === 0 });
  await f.store.save(stored);
  const core = new LanService({ store: f.store }); await core.start(); t.after(() => core.close());
  const member = await core.execute({ action: 'login', username: 'member', password });
  const list = fields => core.execute({ action: 'usage.list', ...fields }, { token: member.token });
  const first = await list({}); assert.equal(first.users.length, 10); assert.equal(first.total, 23); assert.equal(first.pages, 3);
  const second = await list({ page: 1 }); assert.equal(second.users[0].displayName, 'Team 8'); assert.equal(second.users.length, 10);
  const found = await list({ query: 'USAGE-20', status: 'disabled' }); assert.equal(found.total, 1); assert.equal(found.users[0].displayName, 'Team 20'); assert.equal(found.users[0].totalTokens, null);
  const enabled = await list({ status: 'enabled', pageSize: 20 }); assert.equal(enabled.total, 12);
  const last = await list({ page: 999 }); assert.equal(last.page, 2); assert.equal(last.users.length, 3);
  const empty = await list({ query: 'missing', page: 999 }); assert.equal(empty.page, 0); assert.equal(empty.pages, 1); assert.deepEqual(empty.users, []);
  for (const fields of [{ page: -1 }, { pageSize: 1000 }, { status: 'invalid' }, { summary: true }]) await assert.rejects(list(fields), { code: 'INVALID_INPUT' });
  await assert.rejects(core.execute({ action: 'usage.list' }), { code: 'UNAUTHENTICATED' });
  assert.doesNotMatch(JSON.stringify(second), /password|routeIds|directories|csrf|userId|username|tokenHash/);
  const snapshot = await core.execute({ action: 'snapshot', section: 'usage' }, context(member));
  assert.equal(snapshot.usage.users.length, 10); assert.equal(snapshot.usage.total, 23);
});

test('only one concurrent update of the same account revision commits', async t => {
  const f = await fixture(t);
  const result = await Promise.allSettled([true, false].map(files => f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 0, access: { files } })));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.find(row => row.status === 'rejected').reason.code, 'ACCOUNT_CONFLICT');
});

test('account archive revokes login, protects administrators and restores the previous status and policy', async t => {
  const f = await fixture(t), login = await f.request('login', { username: 'member', password });
  await f.request('preferences.update', { expectedRevision: 0, access: { files: false } }, login);
  const before = await f.request('admin.getUser', { userId: f.member.id });
  await assert.rejects(f.core.execute({ action: 'admin.archiveUser', userId: f.member.id, expectedRevision: 0 }, { token: f.admin.token }), { code: 'CSRF_INVALID' });
  await assert.rejects(f.request('admin.archiveUser', { userId: f.admin.user.id, expectedRevision: 0 }), { code: 'LAST_ADMIN' });
  await assert.rejects(f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 0 }, login), { code: 'FORBIDDEN' });
  const archived = await f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 0 });
  assert.equal(archived.user.disabled, true); assert.equal(archived.user.revision, 1); assert.equal(typeof archived.user.archivedAt, 'number');
  assert.equal((await f.request('admin.listUsers')).total, 1); assert.equal((await f.request('admin.listUsers', { status: 'archived' })).items[0].id, f.member.id);
  await assert.rejects(f.request('me', {}, login), { code: 'UNAUTHENTICATED' });
  await assert.rejects(f.request('login', { username: 'member', password }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 0, disabled: false }), { code: 'ACCOUNT_CONFLICT' });
  await assert.rejects(f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 1, disabled: false }), { code: 'ACCOUNT_ARCHIVED' });
  const restored = await f.request('admin.restoreUser', { userId: f.member.id, expectedRevision: 1 });
  assert.equal(restored.user.archivedAt, null); assert.equal(restored.user.disabled, false); assert.equal(restored.user.revision, 2);
  const after = await f.request('admin.getUser', { userId: f.member.id });
  for (const key of ['routeIds', 'defaultRouteId', 'access']) assert.deepEqual(after.user[key], before.user[key]);
  assert.deepEqual(after.preferences, before.preferences);
  await assert.rejects(f.request('me', {}, login), { code: 'UNAUTHENTICATED' });
  assert.equal((await f.request('login', { username: 'member', password })).user.id, f.member.id);
  await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 2, disabled: true });
  await f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 3 });
  assert.equal((await f.request('admin.restoreUser', { userId: f.member.id, expectedRevision: 4 })).user.disabled, true);
  await f.request('admin.updateUser', { userId: f.member.id, expectedRevision: 5, role: 'admin', disabled: false });
  await assert.rejects(f.request('admin.archiveUser', { userId: f.admin.user.id, expectedRevision: 0 }), { code: 'SELF_ACCOUNT' });
});

test('only archived accounts can be deleted, credentials disappear and historical owners and usage remain readable', async t => {
  const runtime = {}, f = await fixture(t, { runtime });
  await f.core.setProviderKeys(['example']);
  const { route } = await f.request('admin.upsertRoute', { label: 'Example', provider: 'example', model: 'model', enabled: true });
  const invite = await f.request('admin.createInvite');
  const member = await f.request('redeem', { inviteToken: invite.inviteToken, username: 'retained-user', displayName: 'Retained history', password });
  const { project } = await f.request('projects.create', { routeId: route.id, title: 'Retained conversation' }, member);
  await f.core.recordUsage({ projectId: project.id, inputTokens: 1, outputTokens: 2, totalTokens: 3 }, runtime);
  const original = await f.store.load();
  await assert.rejects(f.request('admin.deleteUser', { userId: member.user.id, expectedRevision: 0, confirmUsername: 'retained-user' }), { code: 'ARCHIVE_REQUIRED' });
  await f.request('admin.archiveUser', { userId: member.user.id, expectedRevision: 0 });
  await assert.rejects(f.request('admin.deleteUser', { userId: member.user.id, expectedRevision: 1, confirmUsername: 'wrong' }), { code: 'DELETE_CONFIRMATION' });
  const result = await f.request('admin.deleteUser', { userId: member.user.id, expectedRevision: 1, confirmUsername: 'retained-user' });
  assert.equal(result.dataRetained, true);
  const state = await f.store.load(); assert.equal(state.users.some(row => row.id === member.user.id), false);
  assert.equal(state.retiredUsers[0].id, member.user.id); assert.doesNotMatch(JSON.stringify(state.retiredUsers), /password|access|routeIds|preferences/);
  assert.deepEqual(state.projects, original.projects); assert.deepEqual(state.usage, original.usage); assert.equal(state.invites[0].usedBy, member.user.id);
  assert.equal((await f.request('admin.listUsers', { status: 'archived' })).total, 0);
  await assert.rejects(f.request('admin.restoreUser', { userId: member.user.id, expectedRevision: 1 }), { code: 'USER_NOT_FOUND' });
  await assert.rejects(f.request('login', { username: 'retained-user', password }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(f.request('admin.listUsers', { includeHistory: true }), { code: 'INVALID_INPUT' });
  const owners = await f.request('admin.listUsers', { query: 'retained-user', summary: true, includeHistory: true });
  assert.equal(owners.items[0].id, member.user.id); assert.equal(typeof owners.items[0].deletedAt, 'number');
  const replacement = (await f.request('admin.createUser', { username: 'retained-user', displayName: 'New account', password })).user;
  assert.notEqual(replacement.id, member.user.id); assert.deepEqual((await f.request('snapshot', {}, await f.request('login', { username: 'retained-user', password }))).projects, []);
  const restored = new LanService({ store: f.store }); await restored.start(); t.after(() => restored.close());
  const admin = await restored.execute({ action: 'login', username: 'owner', password });
  const board = await restored.execute({ action: 'usage.list', query: 'retained-user' }, context(admin));
  assert.equal(board.users.find(row => row.displayName === 'Retained history').totalTokens, 3);
  assert.equal((await restored.execute({ action: 'admin.listUsers', summary: true, includeHistory: true, query: 'retained-user' }, context(admin))).total, 2);
});

test('failed account archive or deletion never publishes a partial stored state', async t => {
  const f = await fixture(t), save = f.store.save.bind(f.store);
  f.store.save = async () => { throw Error('Synthetic storage failure'); };
  await assert.rejects(f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 0 }), { code: 'STORAGE_FAILURE' });
  assert.equal((await f.request('admin.getUser', { userId: f.member.id })).user.archivedAt, null);
  f.store.save = save; await f.request('admin.archiveUser', { userId: f.member.id, expectedRevision: 0 });
  f.store.save = async () => { throw Error('Synthetic storage failure'); };
  await assert.rejects(f.request('admin.deleteUser', { userId: f.member.id, expectedRevision: 1, confirmUsername: 'member' }), { code: 'STORAGE_FAILURE' });
  assert.equal((await f.request('admin.getUser', { userId: f.member.id })).user.revision, 1);
  assert.equal((await f.store.load()).retiredUsers, undefined); f.store.save = save;
});

test('legacy accounts default to revision zero; failed saves do not advance it', async t => {
  const f = await fixture(t), stored = await f.store.load();
  for (const user of stored.users) delete user.revision;
  await f.store.save(stored);
  const restored = new LanService({ store: f.store }); await restored.start(); t.after(() => restored.close());
  const admin = await restored.execute({ action: 'login', username: 'owner', password });
  const save = f.store.save.bind(f.store); f.store.save = async () => { throw Error('Synthetic failure'); };
  const edit = { action: 'admin.updateUser', userId: f.member.id, expectedRevision: 0, access: { files: false } };
  await assert.rejects(restored.execute(edit, context(admin)), { code: 'STORAGE_FAILURE' });
  assert.equal((await restored.execute({ action: 'snapshot' }, context(admin))).admin.users.find(row => row.id === f.member.id).revision, 0);
  f.store.save = save;
  assert.equal((await restored.execute(edit, context(admin))).user.revision, 1);
});
