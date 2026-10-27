import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Administration, renameNativeSession } from '../carrier/administration.mjs';
import { LanService, MemoryStore } from '../core/service.js';
import { readArchivedSessions, setMemberSessionArchived } from '../carrier/workspaces.mjs';
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-administration-'));
  const core = new LanService({ store: new MemoryStore() }); await core.start();
  await core.setModelCatalog([]);
  const password = 'synthetic-admin-content-password';
  const signed = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true });
  const admin = { token: signed.token, csrf: signed.csrf };
  const alice = (await core.execute({ action: 'admin.createUser', username: 'alice', displayName: 'Alice', password }, admin)).user;
  const bob = (await core.execute({ action: 'admin.createUser', username: 'bob', displayName: 'Bob', password }, admin)).user;
  const member = await core.execute({ action: 'login', username: 'alice', password });
  const homes = new Map(); for (const user of [signed.user, alice, bob]) { const path = join(root, user.id); await mkdir(path); homes.set(user.id, path); }
  await mkdir(join(homes.get(alice.id), 'workspace', 'a'), { recursive: true });
  await mkdir(join(homes.get(bob.id), 'workspace', 'b'), { recursive: true });
  const entries = new Map([[alice.id, [{ sessionId: 'session-a', cwd: join(homes.get(alice.id), 'workspace', 'a') }]], [bob.id, [{ sessionId: 'session-b', cwd: join(homes.get(bob.id), 'workspace', 'b') }]]]);
  const rows = [{ sessionId: 'session-a', updatedAt: 5, running: true, projections: { values: { title: 'Alice private conversation' } } }, { sessionId: 'session-b', updatedAt: 4, running: false, projections: { values: { title: 'Bob private conversation' } } }, { sessionId: 'host-secret', updatedAt: 6 }];
  const calls = [], published = [];
  const sessions = {
    async list() { calls.push('list'); return { items: structuredClone(rows) }; },
    async inspect(id) { calls.push(['inspect', id]); return { events: Array.from({ length: 90 }, (_, seq) => ({ seq, time: seq, type: seq % 2 ? 'assistant/message' : 'user/message', data: seq % 2 ? { message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant ' + seq }] } } : { role: 'user', content: [{ type: 'text', text: 'User ' + seq }] } })) }; },
    async rename({ sessionId, title }) { calls.push(['rename', sessionId, title]); rows.find(row => row.sessionId === sessionId).projections.values.title = title; return { title }; },
    cancel({ sessionId }) { calls.push(['cancel', sessionId]); return { accepted: true }; },
  };
  const service = new Administration({ core, sessions, ownership: { entriesOf: id => entries.get(id) ?? [] }, homes: { own: async id => ({ status: 'ready', path: homes.get(id) }) }, archiveChanged: (...args) => published.push(args) });
  t.after(async () => { await service.close(); await core.close(); await rm(root, { recursive: true, force: true }); });
  const call = (operation, fields = {}, caller = admin) => service.execute({ action: 'admin.content', operation, userId: alice.id, ...fields }, { token: caller.token, csrf: caller.csrf });
  return { core, service, admin, member, alice, bob, homes, rows, entries, calls, published, call, password };
}

test('administrators retain access to an archived then deleted account conversations and files', async t => {
  const f = await fixture(t), path = join(f.homes.get(f.alice.id), 'retained.txt');
  await writeFile(path, 'retained account file');
  await f.core.execute({ action: 'admin.archiveUser', userId: f.alice.id, expectedRevision: 0 }, f.admin);
  await f.core.execute({ action: 'admin.deleteUser', userId: f.alice.id, expectedRevision: 1, confirmUsername: 'alice' }, f.admin);
  assert.equal((await f.call('sessions.list', { content: 'all' })).items[0].sessionId, 'session-a');
  assert.equal((await f.call('files.read', { path: 'retained.txt' })).text, 'retained account file');
  assert.equal(await readFile(path, 'utf8'), 'retained account file');
  await assert.rejects(f.call('files.list', {}, f.member), { code: 'UNAUTHENTICATED' });
});

test('members manage their own sessions and files without administrator or cross-account access', async t => {
  const f = await fixture(t), caller = { token: f.member.token, csrf: f.member.csrf };
  const own = (operation, fields = {}) => f.service.execute({ action: 'member.content', operation, ...fields }, caller);
  assert.deepEqual((await own('sessions.list')).items.map(row => row.sessionId), ['session-a']);
  await own('session.rename', { sessionId: 'session-a', title: 'My renamed conversation' });
  assert.equal((await own('sessions.list')).items[0].title, 'My renamed conversation');
  await own('session.cancel', { sessionId: 'session-a' });
  await own('files.mkdir', { path: 'my-folder' });
  const uploaded = await own('upload.begin', { path: 'my-folder/hello.txt', size: 5 });
  await own('upload.chunk', { uploadId: uploaded.uploadId, offset: 0, data: Buffer.from('hello').toString('base64') });
  await own('upload.finish', { uploadId: uploaded.uploadId });
  assert.equal((await own('files.read', { path: 'my-folder/hello.txt' })).text, 'hello');
  const item = (await own('files.list', { path: '', emptyFolders: 'all' })).items.find(row => row.name === 'my-folder');
  await own('files.rename', { path: item.path, to: 'renamed-folder', revision: item.revision });
  const renamed = (await own('files.list', { path: '' })).items.find(row => row.name === 'renamed-folder');
  const deleted = await own('files.delete', { path: renamed.path, revision: renamed.revision, confirm: true });
  await own('trash.restore', { recycleId: deleted.recycleId });
  assert.equal((await own('files.read', { path: 'renamed-folder/hello.txt' })).text, 'hello');
  await assert.rejects(own('files.list', { userId: f.bob.id }), { code: 'FORBIDDEN' });
  await assert.rejects(own('sessions.list', { userId: f.bob.id }), { code: 'FORBIDDEN' });
  await assert.rejects(own('session.read', { sessionId: 'session-b' }), { code: 'NOT_FOUND' });
  await assert.rejects(own('files.read', { path: '../' + f.bob.id + '/private.txt' }));
  await assert.rejects(f.call('sessions.list', {}, f.member), { code: 'FORBIDDEN' });
  assert.equal((await own('session.preview', { sessionId: 'session-a' })).self, true);
});

test('administrator preview file resolution uses the selected account home and keeps member writes confined', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), other = f.homes.get(f.bob.id);
  const path = join(home, 'workspace/a/preview.md'); await writeFile(path, 'administrator preview');
  const resolved = await f.call('files.resolve', { sessionId: 'administrator-reader-container', path });
  assert.equal(resolved.user.id, f.alice.id);
  assert.equal(resolved.item.path, 'workspace/a/preview.md');
  await f.call('files.rename', { path: resolved.item.path, revision: resolved.item.revision, to: 'workspace/a/renamed-preview.md' });
  assert.equal(await readFile(join(home, 'workspace/a/renamed-preview.md'), 'utf8'), 'administrator preview');
  await assert.rejects(f.call('files.resolve', { sessionId: 'administrator-reader-container', path: join(other, 'workspace/b/private.txt') }), { code: 'ADMIN_FILE_DENIED' });
  await assert.rejects(f.call('files.resolve', { sessionId: 'administrator-reader-container', path }, f.member), { code: 'FORBIDDEN' });
});

test('sidebar file resolution binds absolute paths to the authenticated native session before file commands', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), other = f.homes.get(f.bob.id);
  const own = (operation, fields = {}, caller = f.member) => f.service.execute({ action: 'member.content', operation, ...fields }, { token: caller.token, csrf: caller.csrf });
  const path = join(home, 'workspace/a/中文.md'); await writeFile(path, 'original');
  const resolved = await own('files.resolve', { sessionId: 'session-a', path });
  assert.equal(resolved.user.id, f.alice.id);
  assert.equal(resolved.item.path, 'workspace/a/中文.md');
  assert.equal(resolved.item.kind, 'file');
  await own('files.rename', { path: resolved.item.path, revision: resolved.item.revision, to: 'workspace/a/renamed.md' });
  assert.equal(await readFile(join(home, 'workspace/a/renamed.md'), 'utf8'), 'original');
  await assert.rejects(own('files.resolve', { sessionId: 'session-b', path: join(other, 'workspace/b/private.txt') }), { code: 'NOT_FOUND' });
  await assert.rejects(own('files.resolve', { sessionId: 'session-a', path: join(other, 'workspace/b/private.txt') }), { code: 'ADMIN_FILE_DENIED' });
  await assert.rejects(own('files.resolve', { sessionId: 'session-a', path: home + '/workspace/a/../../outside.md' }), { code: 'INVALID_INPUT' });
  await symlink(other, join(home, 'workspace/a/link'));
  await assert.rejects(own('files.resolve', { sessionId: 'session-a', path: join(home, 'workspace/a/link') }), { code: 'ADMIN_FILE_DENIED' });
  await assert.rejects(own('files.resolve', { sessionId: 'session-a', path: join(home, 'workspace/a/renamed.md') }, { token: f.member.token }), { code: 'CSRF_INVALID' });
  await f.core.execute({ action: 'preferences.update', access: { files: false }, expectedRevision: 0 }, { token: f.member.token, csrf: f.member.csrf });
  await assert.rejects(own('files.resolve', { sessionId: 'session-a', path }), { code: 'MEMBER_CAPABILITY_DENIED' });
});

test('member file management follows current grants and own preferences on every call', async t => {
  const f = await fixture(t), caller = { token: f.member.token, csrf: f.member.csrf };
  const own = (operation, fields = {}) => f.service.execute({ action: 'member.content', operation, ...fields }, caller);
  const upload = await own('upload.begin', { path: 'interrupted.txt', size: 1 });
  await f.core.execute({ action: 'preferences.update', access: { files: false }, expectedRevision: 0 }, caller);
  await assert.rejects(own('files.list'), { code: 'MEMBER_CAPABILITY_DENIED' });
  await assert.rejects(own('upload.chunk', { uploadId: upload.uploadId, offset: 0, data: 'YQ==' }), { code: 'MEMBER_CAPABILITY_DENIED' });
  assert.equal((await own('sessions.list')).total, 1);
  await f.core.execute({ action: 'preferences.update', access: { files: true }, expectedRevision: 1 }, caller);
  await own('upload.abort', { uploadId: upload.uploadId });
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.alice.id, access: { files: false } }, { token: f.admin.token, csrf: f.admin.csrf });
  await assert.rejects(own('files.list'), { code: 'MEMBER_CAPABILITY_DENIED' });
});

test('empty native conversations are hidden before counting and paging, including renamed empty conversations', async t => {
  const f = await fixture(t);
  f.rows.push({ sessionId: 'empty-renamed', updatedAt: 99, blank: true, running: false, projections: { values: { title: 'Real looking title' } } });
  f.entries.get(f.alice.id).push({ sessionId: 'empty-renamed', cwd: f.homes.get(f.alice.id) });
  f.rows[0].blank = false; f.rows[0].projections.values.title = '20261024-182805';
  const page = await f.call('sessions.list', { userId: undefined, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items[0].sessionId, 'session-a');
  assert.equal((await f.call('sessions.list', { content: 'all' })).total, 2);
  assert.deepEqual((await f.call('sessions.list', { content: 'empty' })).items.map(row => row.sessionId), ['empty-renamed']);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'inspect'), false, 'listing does not load conversation bodies');
});

test('session search, status, archive, date range and ordering combine before pagination', async t => {
  const f = await fixture(t);
  const all = { userId: undefined };
  assert.equal((await f.call('sessions.list', { ...all, search: 'PRIVATE alice' })).total, 1);
  assert.equal((await f.call('sessions.list', { ...all, search: 'alice', searchScope: 'id' })).total, 0);
  assert.equal((await f.call('sessions.list', { ...all, search: 'session-b', searchScope: 'id' })).items[0].userId, f.bob.id);
  assert.equal((await f.call('sessions.list', { ...all, search: 'bob', searchScope: 'member', status: 'idle' })).total, 1);
  assert.equal((await f.call('sessions.list', { ...all, status: 'running', updatedFrom: 5, updatedBefore: 6 })).total, 1);
  assert.equal((await f.call('sessions.list', { ...all, updatedBefore: 5 })).items[0].sessionId, 'session-b');
  assert.equal((await f.call('sessions.list', { ...all, sort: 'updated-asc', limit: 1 })).items[0].sessionId, 'session-b');
  await f.call('session.archive', { sessionId: 'session-a' });
  assert.equal((await f.call('sessions.list', { ...all, archive: 'archived' })).items[0].sessionId, 'session-a');
  assert.equal((await f.call('sessions.list', { ...all, archive: 'all' })).total, 2);
  for (const fields of [{ content: 'bogus' }, { status: 'deleted' }, { archive: true }, { searchScope: 'body' }, { sort: 'unknown' }, { updatedFrom: '5' }, { updatedFrom: 10, updatedBefore: 5 }]) await assert.rejects(f.call('sessions.list', fields), { code: 'INVALID_INPUT' });
});

test('file and folder search, types, extensions, dates and natural order apply to the whole current directory', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id);
  await mkdir(join(home, 'project-2')); await mkdir(join(home, 'project-10'));
  await writeFile(join(home, 'project-2', 'nested-hidden.md'), 'private nested content');
  await writeFile(join(home, 'report2.MD'), 'a'); await writeFile(join(home, 'report10.md'), 'larger'); await writeFile(join(home, 'budget.csv'), 'b');
  await utimes(join(home, 'report2.MD'), new Date(2000), new Date(2000));
  await utimes(join(home, 'report10.md'), new Date(3000), new Date(3000));
  const folders = await f.call('files.list', { kind: 'directory', search: 'PROJECT', emptyFolders: 'all', limit: 1, offset: 1 });
  assert.equal(folders.total, 2); assert.equal(folders.items[0].name, 'project-10');
  const files = await f.call('files.list', { extensions: '.md', search: 'report', limit: 1, offset: 1 });
  assert.equal(files.total, 2); assert.equal(files.items[0].name, 'report10.md');
  assert.equal((await f.call('files.list', { extensions: 'md,csv', updatedFrom: 2000, updatedBefore: 3000 })).items[0].name, 'report2.MD');
  assert.equal((await f.call('files.list', { kind: 'file', search: 'report', sort: 'size-desc' })).items[0].name, 'report10.md');
  assert.equal((await f.call('files.list', { search: 'nested-hidden' })).total, 0, 'search stays within the chosen directory');
  for (const fields of [{ kind: 'device' }, { extensions: '../secret' }, { kind: 'directory', extensions: 'md' }, { sort: 'bogus' }, { updatedFrom: 4, updatedBefore: 2 }]) await assert.rejects(f.call('files.list', fields), { code: 'INVALID_INPUT' });
});

test('empty-folder filters count all entries, preserve files and links when hiding, and run before paging', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id);
  await mkdir(join(home, 'empty-2')); await mkdir(join(home, 'empty-10'));
  await mkdir(join(home, 'hidden')); await writeFile(join(home, 'hidden', '.keep'), '');
  await mkdir(join(home, 'nested', 'empty-child'), { recursive: true });
  await writeFile(join(home, 'document.txt'), '');
  await symlink(join(home, 'empty-2'), join(home, 'empty-link'));
  const before = (await readdir(home)).sort();
  const defaults = await f.call('files.list'); assert.equal(defaults.total, 5);
  assert.ok(defaults.items.every(item => !['empty-2', 'empty-10'].includes(item.name)));
  const all = await f.call('files.list', { emptyFolders: 'all' }); assert.equal(all.total, 7);
  const only = await f.call('files.list', { emptyFolders: 'only', limit: 1, offset: 1 });
  assert.equal(only.total, 2); assert.equal(only.items[0].name, 'empty-10');
  const hidden = await f.call('files.list', { emptyFolders: 'exclude' });
  assert.equal(hidden.total, 5);
  assert.deepEqual(new Set(hidden.items.map(item => item.name)), new Set(['workspace', 'hidden', 'nested', 'document.txt', 'empty-link']));
  const folders = await f.call('files.list', { kind: 'directory', emptyFolders: 'exclude', search: 'hidden' });
  assert.equal(folders.total, 1); assert.equal(folders.items[0].name, 'hidden');
  const files = await f.call('files.list', { kind: 'file', emptyFolders: 'exclude' });
  assert.equal(files.items[0].name, 'document.txt');
  assert.deepEqual((await readdir(home)).sort(), before, 'filtering does not modify or delete directories');
  await assert.rejects(f.call('files.list', { emptyFolders: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('files.list', { kind: 'file', emptyFolders: 'only' }), { code: 'INVALID_INPUT' });
});

test('content administration requires current admin login and CSRF before any native or file access', async t => {
  const f = await fixture(t);
  for (const op of ['sessions.list', 'session.read', 'files.list', 'files.delete', 'upload.begin']) {
    await assert.rejects(f.call(op, {}, f.member), { code: 'FORBIDDEN' });
    await assert.rejects(f.call(op, {}, { token: f.admin.token }), { code: 'CSRF_INVALID' });
  }
  assert.deepEqual(f.calls, []);
  await f.core.execute({ action: 'logout' }, f.admin);
  await assert.rejects(f.call('files.list'), { code: 'UNAUTHENTICATED' });
});

test('recycled files survive service recreation and restore exact bytes without exposing the bin as files', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), bytes = Buffer.from([0, 2, 19, 255, 8]);
  await writeFile(join(home, 'recovery.bin'), bytes);
  const item = (await f.call('files.list')).items.find(row => row.name === 'recovery.bin');
  const deleted = await f.call('files.delete', { path: item.path, revision: item.revision, confirm: true });
  assert.equal(deleted.recoverable, true);
  await assert.rejects(readFile(join(home, 'recovery.bin')), { code: 'ENOENT' });
  assert.equal((await f.call('files.list')).items.some(row => row.name === '.lan-recycle'), false);
  const resumed = new Administration({ ...f.service }); t.after(() => resumed.close());
  const call = (operation, fields = {}) => resumed.execute({ action: 'admin.content', operation, userId: f.alice.id, ...fields }, { token: f.admin.token, csrf: f.admin.csrf });
  const bin = await call('trash.list'); assert.equal(bin.total, 1); assert.equal(bin.items[0].path, 'recovery.bin');
  await call('trash.restore', { recycleId: deleted.recycleId });
  assert.deepEqual(await readFile(join(home, 'recovery.bin')), bytes);
  assert.equal((await call('trash.list')).total, 0);
});

test('recovery refuses collisions, cross-account ids, path traversal and symlink parents while retaining originals', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), other = f.homes.get(f.bob.id);
  await mkdir(join(home, 'folder')); await writeFile(join(home, 'folder/value.txt'), 'old value');
  const item = (await f.call('files.list', { path: 'folder' })).items[0];
  const deleted = await f.call('files.delete', { path: item.path, revision: item.revision, confirm: true });
  await writeFile(join(home, 'folder/value.txt'), 'new value');
  await assert.rejects(f.call('trash.restore', { recycleId: deleted.recycleId }), { code: 'ADMIN_FILE_EXISTS' });
  assert.equal(await readFile(join(home, 'folder/value.txt'), 'utf8'), 'new value');
  await assert.rejects(f.call('trash.restore', { recycleId: deleted.recycleId, to: '../escape.txt' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('trash.restore', { userId: f.bob.id, recycleId: deleted.recycleId }), { code: 'NOT_FOUND' });
  await assert.rejects(f.call('trash.restore', { recycleId: deleted.recycleId }, f.member), { code: 'FORBIDDEN' });
  await rm(join(home, 'folder'), { recursive: true }); await symlink(other, join(home, 'folder'));
  await assert.rejects(f.call('trash.restore', { recycleId: deleted.recycleId }), { code: 'ADMIN_FILE_DENIED' });
  assert.equal((await f.call('trash.list')).total, 1);
  await assert.rejects(readFile(join(other, 'value.txt')), { code: 'ENOENT' });
});

test('directory recovery preserves nested content and links; permanent removal needs explicit consent', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id);
  await mkdir(join(home, 'folder/sub'), { recursive: true }); await writeFile(join(home, 'folder/sub/keep.txt'), 'synthetic');
  await symlink('sub/keep.txt', join(home, 'folder/link'));
  const item = (await f.call('files.list')).items.find(row => row.name === 'folder');
  const first = await f.call('files.delete', { path: item.path, revision: item.revision, confirm: true });
  await f.call('trash.restore', { recycleId: first.recycleId });
  assert.equal(await readFile(join(home, 'folder/link'), 'utf8'), 'synthetic');
  const next = (await f.call('files.list')).items.find(row => row.name === 'folder');
  const second = await f.call('files.delete', { path: next.path, revision: next.revision, confirm: true });
  await assert.rejects(f.call('trash.purge', { recycleId: second.recycleId }), { code: 'ADMIN_DELETE_CONFIRMATION' });
  await f.call('trash.purge', { recycleId: second.recycleId, confirm: true });
  assert.equal((await f.call('trash.list')).total, 0);
});

test('recycle persistence failures leave the original file at its original path', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id);
  await writeFile(join(home, 'stay.txt'), 'preserved');
  const item = (await f.call('files.list')).items.find(row => row.name === 'stay.txt');
  f.service.recycleStore.save = async () => { throw new Error('synthetic storage failure'); };
  await assert.rejects(f.call('files.delete', { path: item.path, revision: item.revision, confirm: true }));
  assert.equal(await readFile(join(home, 'stay.txt'), 'utf8'), 'preserved');
});

test('admin lists every managed account including disabled users, pages history, renames, stops and archives native sessions', async t => {
  const f = await fixture(t);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.bob.id, disabled: true }, f.admin);
  const all = await f.call('sessions.list', { userId: undefined, limit: 1 });
  assert.equal(all.total, 2); assert.equal(all.items[0].userId, f.alice.id);
  const bob = await f.call('sessions.list', { userId: f.bob.id }); assert.equal(bob.items[0].sessionId, 'session-b');
  const history = await f.call('session.read', { userId: f.bob.id, sessionId: 'session-b' });
  assert.equal(history.messages.length, 40); assert.equal(history.messages[0].seq, 50); assert.equal(history.hasMore, true);
  const older = await f.call('session.read', { userId: f.bob.id, sessionId: 'session-b', beforeSeq: history.beforeSeq }); assert.equal(older.messages.at(-1).seq, 49);
  await assert.rejects(f.call('session.read', { sessionId: 'session-b' }), { code: 'NOT_FOUND' });
  await f.call('session.rename', { sessionId: 'session-a', title: 'Managed title' });
  assert.equal((await f.call('sessions.list')).items[0].title, 'Managed title');
  await f.call('session.cancel', { sessionId: 'session-a' }); assert.ok(f.calls.some(row => row[0] === 'cancel'));
  await Promise.all([f.call('session.archive', { sessionId: 'session-a' }), setMemberSessionArchived({ home: f.homes.get(f.alice.id), sessionId: 'another-session', archived: true })]);
  assert.deepEqual(new Set(await readArchivedSessions({ home: f.homes.get(f.alice.id) })), new Set(['session-a', 'another-session']));
  assert.equal((await f.call('sessions.list')).total, 0);
  assert.equal((await f.call('sessions.list', { includeArchived: true })).items[0].archived, true);
  assert.equal(f.published[0][0], f.alice.id);
  await f.call('session.restore', { sessionId: 'session-a' }); assert.equal((await f.call('sessions.list')).total, 1);
});

test('member file management confines paths, does not follow links and protects native session locations', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), other = f.homes.get(f.bob.id);
  await writeFile(join(other, 'private.txt'), 'Bob data'); await symlink(other, join(home, 'escape'));
  for (const path of ['/etc/passwd', '../private', 'workspace/../x', 'a\\b', '.lan-archived.json']) await assert.rejects(f.call('files.list', { path }));
  await assert.rejects(f.call('files.read', { path: 'escape/private.txt' }), { code: 'ADMIN_FILE_DENIED' });
  await assert.rejects(f.call('upload.begin', { path: 'escape/overwrite', size: 3 }), { code: 'ADMIN_FILE_DENIED' });
  let list = await f.call('files.list');
  const workspace = list.items.find(row => row.name === 'workspace'); assert.equal(workspace.bound, true);
  await assert.rejects(f.call('files.rename', { path: workspace.path, revision: workspace.revision, to: 'moved' }), { code: 'ADMIN_DIRECTORY_BOUND' });
  await assert.rejects(f.call('files.delete', { path: workspace.path, revision: workspace.revision, confirm: true }), { code: 'ADMIN_DIRECTORY_BOUND' });
  const escape = list.items.find(row => row.name === 'escape'); await f.call('files.delete', { path: escape.path, revision: escape.revision, confirm: true });
  assert.equal(await readFile(join(other, 'private.txt'), 'utf8'), 'Bob data');
  await f.call('files.mkdir', { path: 'workspace/a/nested' });
  await writeFile(join(home, 'workspace/a/nested/file.txt'), 'nested'); await symlink(other, join(home, 'workspace/a/nested/link'));
  list = await f.call('files.list', { path: 'workspace/a' }); const folder = list.items[0];
  await assert.rejects(f.call('files.delete', { path: folder.path, revision: folder.revision }), { code: 'ADMIN_DELETE_CONFIRMATION' });
  await f.call('files.rename', { path: folder.path, revision: folder.revision, to: 'workspace/a/renamed' });
  list = await f.call('files.list', { path: 'workspace/a' });
  await f.call('files.delete', { path: list.items[0].path, revision: list.items[0].revision, confirm: true });
  assert.equal(await readFile(join(other, 'private.txt'), 'utf8'), 'Bob data');
});

test('chunk transfers preserve arbitrary bytes, require one login and never replace conflicting files', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id), bytes = Buffer.alloc(200000, 73);
  const upload = await f.call('upload.begin', { path: 'large.bin', size: bytes.length });
  const second = await f.core.execute({ action: 'login', username: 'admin', password: f.password });
  await assert.rejects(f.call('upload.chunk', { uploadId: upload.uploadId, offset: 0, data: 'YQ==' }, second), { code: 'NOT_FOUND' });
  await assert.rejects(f.call('upload.finish', { uploadId: upload.uploadId }), { code: 'ADMIN_UPLOAD_INCOMPLETE' });
  for (let offset = 0; offset < bytes.length; offset += upload.chunkBytes) await f.call('upload.chunk', { uploadId: upload.uploadId, offset, data: bytes.subarray(offset, offset + upload.chunkBytes).toString('base64') });
  await f.call('upload.finish', { uploadId: upload.uploadId }); assert.deepEqual(await readFile(join(home, 'large.bin')), bytes);
  let offset = 0, revision; const parts = [];
  do { const part = await f.call('files.download', { path: 'large.bin', offset, ...(revision ? { revision } : {}) }); revision = part.revision; offset = part.nextOffset; parts.push(Buffer.from(part.data, 'base64')); } while (offset < bytes.length);
  assert.deepEqual(Buffer.concat(parts), bytes);
  const replacing = await f.call('upload.begin', { path: 'large.bin', size: 0, revision });
  await writeFile(join(home, 'large.bin'), 'changed by the member');
  await assert.rejects(f.call('upload.finish', { uploadId: replacing.uploadId }), { code: 'ADMIN_FILE_CONFLICT' });
  assert.equal(await readFile(join(home, 'large.bin'), 'utf8'), 'changed by the member');
  await assert.rejects(f.call('files.download', { path: 'large.bin', offset: 0, revision }), { code: 'ADMIN_FILE_CONFLICT' });
  assert.equal((await readdir(home)).some(name => name.startsWith('.dsh-lan-upload-')), false);
});

test('text, binary and upload cleanup keep existing data and archive failures do not report success', async t => {
  const f = await fixture(t), home = f.homes.get(f.alice.id);
  await writeFile(join(home, 'text.txt'), 'hello\n'); await writeFile(join(home, 'binary.dat'), Buffer.from([0, 1, 2]));
  assert.equal((await f.call('files.read', { path: 'text.txt' })).text, 'hello\n');
  assert.equal((await f.call('files.read', { path: 'binary.dat' })).binary, true);
  const upload = await f.call('upload.begin', { path: 'unfinished', size: 12 });
  await f.call('upload.abort', { uploadId: upload.uploadId });
  await assert.rejects(readFile(join(home, 'unfinished')), { code: 'ENOENT' });
  await writeFile(join(home, '.lan-archived.json'), '{broken');
  await assert.rejects(f.call('session.archive', { sessionId: 'session-a' }));
  assert.equal(await readFile(join(home, '.lan-archived.json'), 'utf8'), '{broken');
  await f.call('upload.begin', { path: 'closed-upload', size: 100 }); await f.service.close();
  assert.equal((await readdir(home)).some(name => name.startsWith('.dsh-lan-upload-')), false);
});

test('real native metadata rename handles live and cold sessions without starting an Agent or stealing a writer', { skip: !process.env.DSH_LAN_CONTRACT_MODULES, timeout: 20000 }, async t => {
  const modules = process.env.DSH_LAN_CONTRACT_MODULES, directory = await mkdtemp(join(tmpdir(), 'dsh-admin-native-'));
  const f = await publicMemberAccessFixture({ modules, directory });
  let titleFiber, cacheFiber;
  t.after(async () => { await cacheFiber?.dispose(); await titleFiber?.dispose(); await f.close(); await rm(directory, { recursive: true, force: true }); });
  const { default: Titles, normalizeSessionTitle } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-title/lib/index.js')).href);
  titleFiber = f.host.plugin(Titles, { fallbackMaxWords: 8, fallbackMaxBytes: 120, maxTitleBytes: 240 }); await titleFiber.await();
  const { default: Cache } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-projection-cache/lib/index.js')).href);
  cacheFiber = f.host.plugin(Cache, { writeEveryEvents: 1000, writeIntervalMs: 60000 }); await cacheFiber.await();
  let session;
  const fiber = f.host.plugin(ctx => { session = ctx.get('sessions').create('admin-metadata', { meta: { cwd: directory } }); }); await fiber.await();
  const options = { ctx: f.host, normalizeTitle: normalizeSessionTitle, publish: async id => { assert.equal(id, 'admin-metadata'); } };
  await renameNativeSession(options, { sessionId: session.id, title: 'Live admin title' });
  assert.equal(session.snapshotEvents().at(-1).data.title, 'Live admin title');
  assert.equal(f.host.get('sessionProjectionCache').cachedSnapshot(session.header).values.title, 'Live admin title');
  assert.equal(f.host.get('agents').get(session.id), undefined);
  const persistence = f.host.get('sessionPersistence'), writer = await persistence.create(session.header);
  await writer.append(session.snapshotEvents()); await writer.flush(); await writer.close(); await fiber.dispose();
  await renameNativeSession(options, { sessionId: session.id, title: 'Cold admin title' });
  assert.equal(f.host.get('sessions').get(session.id), undefined);
  assert.equal(f.host.get('sessionProjectionCache').cachedSnapshot(session.header).values.title, 'Cold admin title');
  const read = await persistence.open(session.id, 'read');
  assert.equal((await read.read()).events.at(-1).data.title, 'Cold admin title'); await read.close();
  const occupied = await persistence.open(session.id, 'write');
  await assert.rejects(renameNativeSession(options, { sessionId: session.id, title: 'Must not steal writer' }), { code: 'ADMIN_SESSION_BUSY' });
  await occupied.close();
});
