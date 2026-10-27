import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdministratorPreviews, PREVIEW_ACTIONS, previewHistory, installPreviewHistory, installPreviewFileScopes } from '../carrier/admin-previews.mjs';
import { memberAccessPolicy } from '../carrier/access.mjs';
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';

test('native directory listings and watches resolve only this login leased preview root without changing session metadata', () => {
  const calls = [], principal = { kind: 'lan-member', sessionId: 'login', userId: 'admin' };
  const files = { ctx: { invocation: { peer: { principal } } }, list(scope, path) { calls.push({ scope, path }); return 'native-list'; }, changes(scope, path) { calls.push({ scope, path }); return 'native-watch'; } };
  const original = { list: files.list, changes: files.changes }, realScope = Object.freeze({ sessionId: 'admin-session', workspaceRoot: '/admin/empty' });
  let active = true;
  const dispose = installPreviewFileScopes({ get: () => files }, { fileRoot: (peer, session) => active && peer === principal && session === realScope.sessionId ? '/member' : undefined });
  assert.equal(files.list(realScope, '/member/reports'), 'native-list'); assert.equal(calls.at(-1).scope.workspaceRoot, '/member');
  assert.equal(files.changes(realScope, '/member/reports'), 'native-watch'); assert.equal(calls.at(-1).scope.workspaceRoot, '/member');
  files.list(realScope, '/member-other/private'); assert.equal(calls.at(-1).scope, realScope);
  files.list(realScope, '/admin/empty'); assert.equal(calls.at(-1).scope, realScope);
  files.ctx.invocation = undefined; files.list(realScope, '/member/reports'); assert.equal(calls.at(-1).scope, realScope);
  files.ctx.invocation = { peer: { principal } }; active = false; files.list(realScope, '/member/reports'); assert.equal(calls.at(-1).scope, realScope);
  assert.equal(realScope.workspaceRoot, '/admin/empty'); dispose(); assert.equal(files.list, original.list); assert.equal(files.changes, original.changes);
});

test('personal file previews remain own-account, read-only and revocable without administrator authority', async () => {
  let files = true;
  const cap = {}, core = {
    restoreLogin: async () => ({ user: { id: 'alice', role: 'member' }, expiresAt: Date.now() + 60000 }),
    memberAccess(id, authority) { assert.equal(id, 'alice'); assert.equal(authority, cap); return { files }; },
    memberIsAdministrator: () => false,
  };
  const ownership = { entriesOf: id => id === 'alice' ? [{ sessionId: 'alice-session' }] : [], ownerOf: id => id === 'alice-session' ? 'alice' : 'bob' };
  const previews = new AdministratorPreviews({ core, hostCapability: cap, ownership, sessions: { list: async () => ({ items: [{ sessionId: 'bob-session' }, { sessionId: 'alice-session' }] }) } });
  const caller = { token: 'alice-login', audience: 'member' }, user = { id: 'alice', displayName: 'Alice' };
  const value = await previews.open({ user, root: '/home/alice', path: 'notes.md', self: true }, caller, [user]);
  const principal = { kind: 'lan-member', userId: 'alice', sessionId: createHash('sha256').update(caller.token).digest('hex') };
  assert.equal(value.self, true); assert.equal(value.sessionId, 'alice-session');
  assert.equal(previews.bindings(principal).length, 1); assert.equal(previews.fileRoot(principal, 'alice-session'), '/home/alice');
  assert.equal(previews.bindings(principal)[0].role.actions.includes('session/prompt'), false);
  await assert.rejects(previews.open({ user: { id: 'bob' }, root: '/home/bob', self: true }, caller, [user]), { code: 'FORBIDDEN' });
  await assert.rejects(previews.open({ user, root: '/home/alice', sessionId: 'bob-session', self: true }, caller, [user]), { code: 'FORBIDDEN' });
  files = false; assert.equal(previews.bindings(principal).length, 0); assert.equal(previews.fileRoot(principal, 'alice-session'), undefined);
  assert.deepEqual(previews.release(value.previewId, caller), { closed: true }); previews.close();
});

test('native preview grants are explicit, read-only, login-bound and revoked with administrator status', async () => {
  let enabled = true, invalidations = 0;
  const capability = {};
  const core = {
    restoreLogin: async token => ({ user: { id: token === 'admin-token' ? 'admin' : 'member', role: token === 'admin-token' ? 'admin' : 'member' }, expiresAt: Date.now() + 60000 }),
    memberIsAdministrator(id, cap) { assert.equal(cap, capability); return enabled && id === 'admin'; },
  };
  const user = { id: 'alice', displayName: 'Alice' }, caller = { token: 'admin-token', audience: 'member' };
  const ownership = { entriesOf: id => id === 'alice' ? [{ sessionId: 'alice-session' }] : [], sessionIdsOf: () => [] };
  const previews = new AdministratorPreviews({ core, ownership, hostCapability: capability, sessions: { list: async () => ({ items: [{ sessionId: 'host-private' }, { sessionId: 'alice-session' }] }) }, invalidate: () => invalidations++ });
  const principal = { kind: 'lan-member', userId: 'admin', sessionId: createHash('sha256').update(caller.token).digest('hex') };
  const policy = memberAccessPolicy(ownership, () => true, value => previews.bindings(value));
  assert.equal(previews.bindings(principal).length, 0);
  const value = await previews.open({ user, root: '/home/alice', path: 'image 1.png' }, caller, [user]);
  assert.equal(value.sessionId, 'alice-session'); assert.match(value.fileAddress, /image%201\.png$/);
  assert.deepEqual(previews.bindings(principal)[0].role.actions, PREVIEW_ACTIONS);
  assert.equal(policy.bindings(principal).find(row => row.resource.id === 'alice-session').role.actions.includes('session/prompt'), false);
  for (const action of ['session/rename', 'session/cancel', 'session/fork', 'terminal/create']) assert.equal(PREVIEW_ACTIONS.includes(action), false);
  assert.equal(previews.bindings({ ...principal, sessionId: 'another-login' }).length, 0);
  assert.equal(previews.bindings({ ...principal, userId: 'member' }).length, 0);
  assert.equal(previews.fileRoot(principal, 'alice-session'), '/home/alice');
  assert.equal(previews.fileRoot(principal, 'host-private'), undefined);
  assert.throws(() => previews.release(value.previewId, { token: 'another-login' }), { code: 'FORBIDDEN' });
  enabled = false; assert.equal(previews.bindings(principal).length, 0); assert.equal(previews.fileRoot(principal, 'alice-session'), undefined);
  enabled = true; previews.release(value.previewId, caller); assert.equal(previews.bindings(principal).length, 0);
  await assert.rejects(previews.open({ user, root: '/home/alice', sessionId: 'alice-session' }, { token: 'member-token' }), { code: 'FORBIDDEN' });
  assert.ok(invalidations >= 2); previews.close();
});

test('file previews reuse only the signed-in user native container without scanning every session', async () => {
  const core = { restoreLogin: async () => ({ user: { id: 'admin', role: 'admin' }, expiresAt: Date.now() + 60000 }), memberIsAdministrator: () => true };
  const ownership = { ownerOf: id => id === 'admin-session' ? 'admin' : id === 'host-private' ? undefined : 'alice', entriesOf: id => id === 'alice' ? [{ sessionId: 'alice-session' }] : [] };
  let scans = 0;
  const previews = new AdministratorPreviews({ core, ownership, sessions: { list: async () => { scans++; return { items: [{ sessionId: 'alice-session' }] }; } } });
  const caller = { token: 'admin-login' }, user = { id: 'alice', displayName: 'Alice' };
  const value = await previews.open({ user, root: '/home/alice', path: 'notes.md', contextSessionId: 'admin-session' }, caller, [user]);
  assert.equal(scans, 0); assert.equal(value.sessionId, 'admin-session'); assert.match(value.fileAddress, /session\/admin-session\//);
  assert.equal(value.fileDirectory, '/home/alice');
  const nested = await previews.open({ user, root: '/home/alice', path: 'workspace/report/总结.md', contextSessionId: 'admin-session' }, caller, [user]);
  assert.equal(nested.fileDirectory, '/home/alice/workspace/report');
  const principal = { kind: 'lan-member', userId: 'admin', sessionId: createHash('sha256').update(caller.token).digest('hex') };
  assert.equal(previews.fileRoot(principal, 'admin-session'), '/home/alice');
  previews.release(value.previewId, caller);
  for (const contextSessionId of ['foreign-session', 'host-private']) {
    const fallback = await previews.open({ user, root: '/home/alice', path: 'notes.md', contextSessionId }, caller, [user]);
    assert.equal(fallback.sessionId, 'alice-session'); assert.equal(previews.fileRoot(principal, contextSessionId), undefined); previews.release(fallback.previewId, caller);
  }
  assert.equal(scans, 2, 'foreign or unmanaged hints use the original managed lookup rather than granting the hinted Session');
  await assert.rejects(previews.open({ user, root: '/home/alice', sessionId: 'admin-session', contextSessionId: 'admin-session' }, caller, [user]), { code: 'FORBIDDEN' });
  assert.equal(previews.fileRoot(principal, 'admin-session'), undefined); previews.close();
});

test('read-only history closes the native iterator before Agent promotion, forwards new durable events and releases listeners', async () => {
  let eventListener, disposed = 0, promoted = false, active = true;
  const ctx = { on(_event, listener) { eventListener = listener; return () => { disposed++; }; } };
  const previews = { listeners: new Set(), active: () => active };
  async function* follow() { try { yield { type: 'snapshot', cursor: 2, records: ['native-record'] }; promoted = true; } finally {} }
  const signal = new AbortController().signal;
  const iterator = previewHistory({ ctx, follow, receiver: {}, request: { address: { kind: 'session', sessionId: 's' } }, signal, previews });
  assert.deepEqual((await iterator.next()).value.records, ['native-record']); assert.equal(promoted, false);
  eventListener({ id: 'other' }, { seq: 3 }); eventListener({ id: 's' }, { seq: 2 }); eventListener({ id: 's' }, { seq: 3, type: 'assistant/message' });
  assert.equal((await iterator.next()).value.event.seq, 3);
  const pending = iterator.next(); active = false; for (const listener of previews.listeners) listener();
  assert.equal((await pending).done, true); assert.equal(disposed, 1); assert.equal(previews.listeners.size, 0);
});

test('installed native cold follow renders its real snapshot without creating an Agent or promoting the Session', { skip: !process.env.DSH_LAN_CONTRACT_MODULES, timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-preview-'));
  const f = await publicMemberAccessFixture({ modules: process.env.DSH_LAN_CONTRACT_MODULES, directory });
  let restore;
  t.after(async () => { restore?.(); await f.close(); await rm(directory, { recursive: true, force: true }); });
  let session;
  const fiber = f.host.plugin(ctx => { session = ctx.get('sessions').create('native-preview-cold', { meta: { cwd: directory } }); }); await fiber.await();
  const writer = await f.host.get('sessionPersistence').create(session.header); await writer.append(session.snapshotEvents()); await writer.flush(); await writer.close(); await fiber.dispose();
  const previews = { active: id => id === session.id, listeners: new Set() };
  restore = installPreviewHistory(f.host, previews);
  const abort = new AbortController();
  const iterator = f.host.get('sessionController').follow({ address: { kind: 'session', sessionId: session.id }, assistantStream: true }, abort.signal)[Symbol.asyncIterator]();
  const first = await iterator.next(); assert.equal(first.value.type, 'snapshot'); assert.equal(first.value.header.id, session.id);
  assert.equal(f.host.get('agents').get(session.id), undefined); assert.equal(f.host.get('sessions').get(session.id), undefined);
  abort.abort(); await iterator.return(); assert.equal(previews.listeners.size, 0);
  const source = await f.stream('owner', 'session/follow', { request: { address: { kind: 'session', sessionId: session.id }, assistantStream: true } });
  const wire = source[Symbol.asyncIterator]();
  assert.equal((await wire.next()).value.type, 'snapshot');
  await wire.return();
  assert.equal(f.host.get('agents').get(session.id), undefined);
  assert.equal(f.host.get('sessions').get(session.id), undefined);
  assert.equal(previews.listeners.size, 0);
});
