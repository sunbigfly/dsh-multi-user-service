import { constants } from 'node:fs';
import { open, opendir, realpath, readdir, lstat, mkdir, rename, unlink, rmdir, link, readlink, symlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reject } from '../core/errors.js';
import * as v from '../core/validation.js';
import { readArchivedSessions, setMemberSessionArchived } from './workspaces.mjs';
import { MemoryStore } from '../core/store.js';

const CHUNK = 64 * 1024, TEXT_LIMIT = 256 * 1024;
const RECYCLE = '.lan-recycle';
const INTERNAL = new Set(['.lan-workspaces.json', '.lan-archived.json', '.lan-attachments.json', RECYCLE]);
const UPLOAD_PREFIX = '.dsh-lan-upload-';
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (handle, name = '') => `/proc/self/fd/${handle.fd}${name ? '/' + name : ''}`;
const revision = stat => createHash('sha256').update([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex');
const tokenKey = caller => createHash('sha256').update(`${caller.audience ?? 'legacy'}:${caller.token}`).digest('hex');
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function relativePath(value, root = true) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value) || (!root && value === '')) reject('INVALID_INPUT', 'Invalid relative file path.');
  if (value && value.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || part.startsWith(UPLOAD_PREFIX))) reject('INVALID_INPUT', 'Invalid relative file path.');
  if (value && INTERNAL.has(value.split('/')[0])) reject('ADMIN_FILE_PROTECTED', 'Workspace bookkeeping is managed by the server.', 403);
  return value;
}
async function directory(root, path = '') {
  if (await realpath(root) !== root) reject('ADMIN_FILE_DENIED', 'The member directory is not canonical.', 403);
  let handle = await open(root, dirFlags);
  try {
    for (const name of relativePath(path).split('/').filter(Boolean)) {
      const next = await open(at(handle, name), dirFlags); await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function parent(root, path) {
  relativePath(path, false);
  return { handle: await directory(root, posix.dirname(path) === '.' ? '' : posix.dirname(path)), name: posix.basename(path) };
}
async function regular(handle, name) {
  const file = await open(at(handle, name), fileFlags);
  try { const stat = await file.stat(); if (!stat.isFile()) reject('ADMIN_FILE_TYPE', 'This operation requires a regular file.'); return { file, stat }; }
  catch (error) { await file.close(); throw error; }
}
async function emptyDirectory(handle, name) {
  const child = await open(at(handle, name), dirFlags);
  try {
    const entries = await opendir(at(child));
    try { return await entries.read() === null; }
    finally { await entries.close(); }
  } finally { await child.close(); }
}
async function removeEntry(handle, name) {
  const stat = await lstat(at(handle, name));
  if (!stat.isDirectory()) return unlink(at(handle, name));
  const child = await open(at(handle, name), dirFlags);
  try { for (const entry of await readdir(at(child))) await removeEntry(child, entry); }
  finally { await child.close(); }
  await rmdir(at(handle, name));
}
async function recycleDirectory(root) {
  const held = await directory(root);
  try {
    try { await mkdir(at(held, RECYCLE), { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await open(at(held, RECYCLE), dirFlags);
  } finally { await held.close(); }
}
// Exclusive mkdir/link/symlink operations never replace an existing destination.
// Keep the original payload until the entire tree is copied successfully.
async function restoreEntry(source, sourceName, target, targetName) {
  const stat = await lstat(at(source, sourceName));
  if (stat.isSymbolicLink()) return symlink(await readlink(at(source, sourceName)), at(target, targetName));
  if (!stat.isDirectory()) return link(at(source, sourceName), at(target, targetName));
  await mkdir(at(target, targetName), { mode: stat.mode & 0o777 });
  const from = await open(at(source, sourceName), dirFlags);
  let to;
  try {
    to = await open(at(target, targetName), dirFlags);
    for (const name of await readdir(at(from))) await restoreEntry(from, name, to, name);
  } finally { await from.close(); await to?.close(); }
}
function messageOf(event) {
  if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return null;
  const message = event.data.message ?? event.data;
  const text = (message.content ?? []).map(block => block.type === 'text' ? block.text : block.type === 'tool-call' ? `${block.name}\n${JSON.stringify(block.arguments, null, 2)}` : block.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
  return text ? { seq: event.seq, time: event.time, role: message.role ?? (event.type === 'user/message' ? 'user' : event.type === 'tool/result' ? 'tool' : 'assistant'), text: text.slice(0, 64 * 1024), truncated: text.length > 64 * 1024 } : null;
}

/** Native title metadata does not require starting an Agent. Cold writes use
 * the public persistence lease and durable barrier, retaining single-writer
 * ownership even when another client resumes the Session concurrently. */
export async function renameNativeSession({ ctx, normalizeTitle, publish = async () => {} }, request) {
  const titles = ctx.get('sessionTitle'), persistence = ctx.get('sessionPersistence'), sessions = ctx.get('sessions');
  const cache = ctx.get('sessionProjectionCache');
  if (!titles || !persistence) reject('ADMIN_SESSION_UNAVAILABLE', 'Native session titles are unavailable.', 503);
  const live = sessions.get(request.sessionId);
  if (live) {
    const accepted = titles.rename(live, request.title);
    if (cache) await cache.write(live); else await persistence.flush();
    return { title: accepted.title, seq: accepted.seq ?? accepted.eventSeq };
  }
  const title = normalizeTitle(request.title, titles.config.maxTitleBytes);
  if (!title) reject('INVALID_INPUT', 'A nonempty session title is required.');
  let writer;
  try { writer = await persistence.open(request.sessionId, 'write'); }
  catch (error) { if (error.name === 'SessionAlreadyOwnedError') reject('ADMIN_SESSION_BUSY', 'The session is changing. Refresh and retry.', 409); throw error; }
  let seq;
  try {
    const { events } = await writer.read(); seq = events.length;
    const event = { seq, time: Date.now(), type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } };
    await writer.append([event]);
    await writer.flush();
    if (cache) {
      const prepared = sessions.prepare(request.sessionId, { meta: structuredClone(writer.header), inheritedEventCount: writer.inheritedEventCount, seed: structuredClone([...events, event]), eventState: 'detached' });
      await cache.write(prepared);
    }
  } finally { await writer.close(); }
  await publish(request.sessionId);
  return { title, seq };
}

/** Content management stays separate from Agent execution. Administrator
 * operations require the administrator role; member operations bind the caller's
 * own account. Every request rechecks login, CSRF and current file permissions. */
export class Administration {
  constructor({ core, ownership, homes, sessions, previews, recycleStore = new MemoryStore(), archiveChanged = () => {} }) {
    Object.assign(this, { core, ownership, homes, sessions, previews, recycleStore, archiveChanged });
    this.uploads = new Map(); this.closed = false;
    this.timer = setInterval(() => { for (const [id, job] of this.uploads) if (Date.now() - job.at > 10 * 60 * 1000) void this.discard(id).catch(() => {}); }, 60000); this.timer.unref?.();
  }
  async authorize(caller, request) {
    if (this.closed) reject('SERVICE_CLOSED', 'Content management is closed.', 503);
    if (request?.action === 'member.content') return this.core.runMemberOperation(caller, ({ user, access }) => {
      if (request.userId !== undefined && request.userId !== user.id) reject('FORBIDDEN', 'Members may only manage their own content.', 403);
      if (/^(?:files|upload|trash)\./.test(request.operation) && !access.files) reject('MEMBER_CAPABILITY_DENIED', 'File access is disabled for this account.', 403);
      return [user];
    });
    return this.core.runAdministratorOperation(caller, state => [...state.users, ...(state.retiredUsers ?? [])].map(({ id, username, displayName, role, disabled, archivedAt, deletedAt }) => ({ id, username, displayName, role, disabled, archivedAt, deletedAt })));
  }
  async context(users, userId) {
    v.id(userId, 'usr'); const user = users.find(row => row.id === userId);
    if (!user) reject('NOT_FOUND', 'Account not found.', 404);
    const home = await this.homes.own(userId);
    if (home.status !== 'ready' || typeof home.path !== 'string') reject('ADMIN_HOME_UNAVAILABLE', 'Member directory unavailable.', 503);
    return { user, root: home.path };
  }
  binding(userId, sessionId) {
    const entry = this.ownership.entriesOf(userId).find(row => row.sessionId === sessionId);
    if (!entry) reject('NOT_FOUND', 'Session does not belong to this account.', 404);
    return entry;
  }
  protectedDirectory(userId, root, path) {
    const absolute = posix.join(root, path);
    return this.ownership.entriesOf(userId).some(entry => entry.cwd === absolute || entry.cwd?.startsWith(absolute + '/'));
  }
  async recycleDocument() {
    const document = await this.recycleStore.load() ?? { version: 1, items: [] };
    v.object(document, ['version', 'items']);
    if (document.version !== 1) reject('ADMIN_RECYCLE_INVALID', 'Recycle records are unavailable.', 503);
    for (const item of v.list(document.items, 16384)) {
      v.object(item, ['id', 'userId', 'root', 'path', 'deletedAt']);
      if (typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id)) reject('ADMIN_RECYCLE_INVALID', 'Invalid recycle record.', 503);
      v.id(item.userId, 'usr'); relativePath(item.path, false); v.integer(item.deletedAt, 'deletion time');
      if (typeof item.root !== 'string' || !item.root.startsWith('/')) reject('ADMIN_RECYCLE_INVALID', 'Invalid recycle root.', 503);
    }
    return document;
  }
  async recycleDelete({ root, user, path, location, revision: expected }) {
    const document = await this.recycleDocument(), id = randomUUID(), bin = await recycleDirectory(root);
    let recorded = false;
    try {
      if (document.items.length >= 16384) reject('ADMIN_RECYCLE_FULL', 'Recycle records are full. Permanently remove old items first.', 409);
      document.items.push({ id, userId: user.id, root, path, deletedAt: Date.now() });
      // Durable intent precedes the atomic move. A crash cannot strand an
      // unrecorded payload; pending records without payloads are not displayed.
      await this.recycleStore.save(document);
      recorded = true;
      const current = await lstat(at(location.handle, location.name));
      if (revision(current) !== expected) reject('ADMIN_FILE_CONFLICT', 'The item changed. Refresh before recycling.', 409);
      if (await exists(at(bin, id))) reject('ADMIN_FILE_EXISTS', 'Recycle destination already exists.', 409);
      await rename(at(location.handle, location.name), at(bin, id));
      return { deleted: true, recoverable: true, recycleId: id };
    } catch (error) {
      if (recorded) await this.recycleStore.save({ version: 1, items: document.items.filter(item => item.id !== id) }).catch(() => {});
      throw error;
    } finally { await bin.close(); }
  }
  async recycleOperation(r, user, root) {
    const document = await this.recycleDocument(), bin = await recycleDirectory(root);
    try {
      if (r.operation === 'trash.list') {
        const items = [];
        for (const item of document.items.filter(row => row.userId === user.id && row.root === root)) {
          const stat = await exists(at(bin, item.id)); if (!stat) continue;
          items.push({ id: item.id, name: posix.basename(item.path), path: item.path, deletedAt: item.deletedAt, kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file', size: stat.size });
        }
        items.sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id));
        const offset = v.integer(r.offset ?? 0, 'offset'), limit = Math.min(v.integer(r.limit ?? 25, 'limit', 1), 100);
        return { items: items.slice(offset, offset + limit), total: items.length };
      }
      const item = document.items.find(row => row.id === r.recycleId && row.userId === user.id && row.root === root);
      if (!item) reject('NOT_FOUND', 'Recycled item does not belong to this account.', 404);
      if (r.operation === 'trash.restore') {
        const path = relativePath(r.to ?? item.path, false), target = await parent(root, path);
        try {
          if (await exists(at(target.handle, target.name))) reject('ADMIN_FILE_EXISTS', 'The destination already exists. No file was replaced.', 409);
          await restoreEntry(bin, item.id, target.handle, target.name);
        } finally { await target.handle.close(); }
      } else if (r.operation === 'trash.purge') {
        if (r.confirm !== true) reject('ADMIN_DELETE_CONFIRMATION', 'Confirm permanent deletion before continuing.', 409);
      } else reject('INVALID_INPUT', 'Unknown recycle operation.');
      await removeEntry(bin, item.id);
      await this.recycleStore.save({ version: 1, items: document.items.filter(row => row.id !== item.id) });
      return r.operation === 'trash.restore' ? { restored: true, path: r.to ?? item.path } : { purged: true };
    } finally { await bin.close(); }
  }
  async execute(request, caller) {
    v.object(request, ['action', 'operation', 'userId', 'sessionId', 'path', 'to', 'title', 'search', 'offset', 'limit', 'includeArchived', 'content', 'status', 'archive', 'searchScope', 'sort', 'kind', 'extensions', 'emptyFolders', 'updatedFrom', 'updatedBefore', 'beforeSeq', 'revision', 'uploadId', 'previewId', 'size', 'data', 'confirm', 'recycleId'], ['action', 'operation']);
    if (!['admin.content', 'member.content'].includes(request.action)) reject('INVALID_INPUT', 'Unknown content management action.');
    v.text(request.operation, 'operation', 64);
    const users = await this.authorize(caller, request);
    const own = request.action === 'member.content';
    const scoped = own ? { ...request, userId: users[0].id } : request;
    const guard = operation => own ? this.core.runMemberOperation(caller, ({ user, access }) => {
      if (user.id !== scoped.userId || /^(?:files|upload|trash)\./.test(scoped.operation) && !access.files) reject('FORBIDDEN', 'Content access changed.', 403);
      return operation();
    }) : this.core.runAdministratorOperation(caller, operation);
    try {
      const result = await this.perform(scoped, caller, users, guard);
      await this.authorize(caller, request);
      return result;
    } catch (error) {
      if (error.name === 'LanError') throw error;
      const codes = { ENOENT: ['NOT_FOUND', 'File or directory no longer exists.', 404], EEXIST: ['ADMIN_FILE_EXISTS', 'The destination already exists.', 409], ELOOP: ['ADMIN_FILE_DENIED', 'Symbolic links cannot be followed.', 403], ENOTDIR: ['ADMIN_FILE_DENIED', 'A path component is not a directory.', 403], EACCES: ['ADMIN_FILE_DENIED', 'File access was denied.', 403], EPERM: ['ADMIN_FILE_DENIED', 'File operation was denied.', 403] };
      const known = codes[error.code]; if (known) reject(...known);
      throw error;
    }
  }
  async perform(r, caller, users, guard) {
    if (r.operation === 'preview.close') {
      v.text(r.previewId, 'preview', 128);
      return this.previews.release(r.previewId, caller);
    }
    if (r.operation === 'sessions.list') {
      const selected = r.userId ? [await this.context(users, r.userId)].map(row => row.user) : users;
      const bindings = new Map(selected.flatMap(user => this.ownership.entriesOf(user.id).map(entry => [entry.sessionId, { ...entry, user }])));
      const archived = new Set(), roots = new Map();
      for (const user of selected) { const { root } = await this.context(users, user.id); roots.set(user.id, root); for (const id of await readArchivedSessions({ home: root })) archived.add(id); }
      const rows = await this.sessions.list({}, new AbortController().signal);
      if (r.search !== undefined) v.text(r.search, 'search', 200, 0);
      if (r.includeArchived !== undefined) v.bool(r.includeArchived, 'archived filter');
      const content = r.content ?? 'messages', status = r.status ?? 'all', archive = r.archive ?? (r.includeArchived ? 'all' : 'active'), searchScope = r.searchScope ?? 'all', sort = r.sort ?? 'updated-desc';
      for (const [value, allowed] of [[content, ['messages', 'all', 'empty']], [status, ['all', 'running', 'idle']], [archive, ['active', 'archived', 'all']], [searchScope, ['all', 'title', 'member', 'id']], [sort, ['updated-desc', 'updated-asc', 'title']]]) {
        if (!allowed.includes(value)) reject('INVALID_INPUT', 'Invalid session filter.');
      }
      if (r.updatedFrom !== undefined) v.integer(r.updatedFrom, 'updated from');
      if (r.updatedBefore !== undefined) v.integer(r.updatedBefore, 'updated before');
      if (r.updatedFrom !== undefined && r.updatedBefore !== undefined && r.updatedFrom >= r.updatedBefore) reject('INVALID_INPUT', 'The update date range is reversed.');
      const terms = (r.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = rows.items.filter(row => bindings.has(row.sessionId)).map(row => {
        const { user, cwd } = bindings.get(row.sessionId), title = row.projections?.values?.title;
        const root = roots.get(user.id), filePath = cwd === root ? '' : cwd?.startsWith(root + '/') ? cwd.slice(root.length + 1) : null;
        return { sessionId: row.sessionId, userId: user.id, displayName: user.displayName, username: user.username, title: typeof title === 'string' && title ? title : posix.basename(cwd ?? '') || row.sessionId, cwd, filePath, updatedAt: row.updatedAt, running: row.running, empty: row.blank === true, archived: archived.has(row.sessionId) };
      }).filter(row => {
        if (content === 'messages' && row.empty || content === 'empty' && !row.empty) return false;
        if (status === 'running' && !row.running || status === 'idle' && row.running) return false;
        if (archive === 'active' && row.archived || archive === 'archived' && !row.archived) return false;
        if (r.updatedFrom !== undefined && row.updatedAt < r.updatedFrom || r.updatedBefore !== undefined && row.updatedAt >= r.updatedBefore) return false;
        const text = (searchScope === 'title' ? row.title : searchScope === 'member' ? `${row.displayName} ${row.username}` : searchScope === 'id' ? row.sessionId : `${row.title} ${row.displayName} ${row.username} ${row.sessionId}`).toLowerCase();
        return terms.every(term => text.includes(term));
      }).sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) : sort === 'updated-asc' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
      const offset = r.offset ?? 0, limit = r.limit ?? 10; v.integer(offset, 'offset'); v.integer(limit, 'limit', 1, 50);
      return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
    }
    const { user, root } = await this.context(users, r.userId);
    // The native file tree supplies an absolute path. Resolve it against the
    // member's durable Session binding, or the administrator's selected account
    // home. Admin preview containers belong to the reader, not the file owner.
    // Subsequent commands retain the usual home-relative paths and revisions.
    if (r.operation === 'files.resolve') {
      v.text(r.sessionId, 'session', 128);
      const entry = r.action === 'member.content' ? this.binding(user.id, r.sessionId) : null;
      if (typeof r.path !== 'string' || !r.path.startsWith(root + '/') || entry && (typeof entry.cwd !== 'string' || entry.cwd !== root && !entry.cwd.startsWith(root + '/') || !r.path.startsWith(entry.cwd + '/'))) reject('ADMIN_FILE_DENIED', 'The file is outside this authorized workspace.', 403);
      const path = relativePath(r.path.slice(root.length + 1), false);
      const location = await parent(root, path);
      try {
        const stat = await lstat(at(location.handle, location.name));
        if (!stat.isDirectory() && !stat.isFile()) reject('ADMIN_FILE_DENIED', 'Only regular files and directories can be managed.', 403);
        return { user: { id: user.id, username: user.username, displayName: user.displayName }, item: { path, name: location.name, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, revision: revision(stat), bound: stat.isDirectory() && this.protectedDirectory(user.id, root, path) } };
      } finally { await location.handle.close(); }
    }
    if (r.operation.startsWith('session.')) {
      v.text(r.sessionId, 'session', 128); this.binding(user.id, r.sessionId);
      if (r.operation === 'session.preview') return r.action === 'member.content' ? { self: true, sessionId: r.sessionId, displayName: user.displayName } : this.previews.open({ user, root, sessionId: r.sessionId }, caller, users);
      if (r.operation === 'session.read') {
        if (r.beforeSeq !== undefined) v.integer(r.beforeSeq, 'history cursor');
        const observed = await this.sessions.inspect(r.sessionId, new AbortController().signal);
        const messages = observed.events.filter(event => r.beforeSeq === undefined || event.seq < r.beforeSeq).map(messageOf).filter(Boolean);
        return { messages: messages.slice(-40), hasMore: messages.length > 40, beforeSeq: messages.at(-40)?.seq ?? null };
      }
      return guard(async () => {
        if (r.operation === 'session.rename') { v.text(r.title, 'title', 120); return this.sessions.rename({ sessionId: r.sessionId, title: r.title }); }
        if (r.operation === 'session.cancel') return this.sessions.cancel({ sessionId: r.sessionId });
        if (r.operation === 'session.archive' || r.operation === 'session.restore') {
          const ids = await setMemberSessionArchived({ home: root, sessionId: r.sessionId, archived: r.operation === 'session.archive' });
          this.archiveChanged(user.id, ids); return { archived: r.operation === 'session.archive' };
        }
        reject('INVALID_INPUT', 'Unknown session operation.');
      });
    }
    if (r.operation.startsWith('trash.')) return guard(() => this.recycleOperation(r, user, root));
    const path = relativePath(r.path ?? '');
    if (r.operation === 'files.list') {
      const kind = r.kind ?? 'all', sort = r.sort ?? 'name-asc', emptyFolders = r.emptyFolders ?? 'exclude';
      if (!['all', 'file', 'directory', 'link'].includes(kind) || !['name-asc', 'name-desc', 'updated-desc', 'updated-asc', 'size-desc'].includes(sort)) reject('INVALID_INPUT', 'Invalid file filter.');
      if (!['all', 'exclude', 'only'].includes(emptyFolders) || emptyFolders === 'only' && !['all', 'directory'].includes(kind)) reject('INVALID_INPUT', 'Invalid empty-folder filter.');
      if (r.search !== undefined) v.text(r.search, 'search', 200, 0);
      if (r.extensions !== undefined) v.text(r.extensions, 'extensions', 100, 0);
      const extensions = (r.extensions ?? '').toLowerCase().split(',').map(value => value.trim().replace(/^\./, '')).filter(Boolean);
      if (extensions.some(value => !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(value)) || extensions.length && !['all', 'file'].includes(kind)) reject('INVALID_INPUT', 'Invalid file extension filter.');
      if (r.updatedFrom !== undefined) v.integer(r.updatedFrom, 'updated from');
      if (r.updatedBefore !== undefined) v.integer(r.updatedBefore, 'updated before');
      if (r.updatedFrom !== undefined && r.updatedBefore !== undefined && r.updatedFrom >= r.updatedBefore) reject('INVALID_INPUT', 'The update date range is reversed.');
      const terms = (r.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const handle = await directory(root, path);
      try {
        const items = [];
        for (const name of await readdir(at(handle))) {
          if (name.startsWith(UPLOAD_PREFIX) || (!path && INTERNAL.has(name))) continue;
          let stat; try { stat = await lstat(at(handle, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          items.push({ name, path: path ? `${path}/${name}` : name, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, modifiedAt: stat.mtimeMs, revision: revision(stat), bound: stat.isDirectory() && this.protectedDirectory(user.id, root, path ? `${path}/${name}` : name) });
        }
        let filtered = items.filter(item => (kind === 'all' || item.kind === kind) && terms.every(term => item.name.toLowerCase().includes(term)) && (!extensions.length || item.kind === 'file' && extensions.some(extension => item.name.toLowerCase().endsWith('.' + extension))) && (r.updatedFrom === undefined || item.modifiedAt >= r.updatedFrom) && (r.updatedBefore === undefined || item.modifiedAt < r.updatedBefore));
        if (emptyFolders !== 'all') {
          const matches = [];
          for (const item of filtered) {
            if (item.kind !== 'directory') { if (emptyFolders === 'exclude') matches.push(item); continue; }
            let empty;
            try { empty = await emptyDirectory(handle, item.name); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (emptyFolders === 'only' ? empty : !empty) matches.push(item);
          }
          filtered = matches;
        }
        filtered.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || (sort === 'name-desc' ? b.name.localeCompare(a.name, undefined, { numeric: true }) : sort === 'updated-desc' ? b.modifiedAt - a.modifiedAt : sort === 'updated-asc' ? a.modifiedAt - b.modifiedAt : sort === 'size-desc' ? b.size - a.size : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const offset = r.offset ?? 0, limit = r.limit ?? 25; v.integer(offset, 'offset'); v.integer(limit, 'limit', 1, 100);
        return { path, items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
      } finally { await handle.close(); }
    }
    if (r.operation === 'upload.chunk' || r.operation === 'upload.finish' || r.operation === 'upload.abort') {
      v.text(r.uploadId, 'upload', 100); const job = this.uploads.get(r.uploadId);
      if (!job || job.owner !== tokenKey(caller) || job.userId !== user.id) reject('NOT_FOUND', 'Upload is no longer available.', 404);
      job.at = Date.now();
      if (job.busy) reject('ADMIN_UPLOAD_BUSY', 'Another upload operation is in progress.', 409);
      if (r.operation === 'upload.abort') { await this.discard(r.uploadId); return { cancelled: true }; }
      if (r.operation === 'upload.chunk') {
        if (typeof r.data !== 'string' || r.data.length > Math.ceil(CHUNK / 3) * 4) reject('INVALID_INPUT', 'Invalid file chunk.');
        const bytes = Buffer.from(r.data, 'base64'); if (bytes.toString('base64') !== r.data || bytes.length > CHUNK) reject('INVALID_INPUT', 'Invalid file chunk.');
        if (r.offset !== job.written || !bytes.length || job.written + bytes.length > job.size) reject('ADMIN_UPLOAD_CONFLICT', 'Upload offset changed.', 409);
        job.busy = true;
        try {
          let written = 0;
          while (written < bytes.length) { const part = await job.file.write(bytes, written, bytes.length - written, job.written + written); if (!part.bytesWritten) throw new Error('Upload write made no progress'); written += part.bytesWritten; }
          job.written += bytes.length;
        } finally { job.busy = false; }
        return { offset: job.written };
      }
      if (job.written !== job.size) reject('ADMIN_UPLOAD_INCOMPLETE', 'Upload is incomplete.', 409);
      return guard(async () => {
        try {
          const stat = await exists(at(job.parent, job.name));
          if ((stat ? revision(stat) : null) !== job.revision) reject('ADMIN_FILE_CONFLICT', 'The file changed. Reload it before saving.', 409);
          await job.file.sync();
          if (job.revision === null) { await link(at(job.parent, job.temporary), at(job.parent, job.name)); await unlink(at(job.parent, job.temporary)); }
          else await rename(at(job.parent, job.temporary), at(job.parent, job.name));
          return { saved: true, path: job.path };
        } finally { await this.discard(r.uploadId); }
      });
    }
    const location = await parent(root, path);
    try {
      if (r.operation === 'files.read' || r.operation === 'files.download' || r.operation === 'files.preview') {
        const { file, stat } = await regular(location.handle, location.name);
        try {
          if (r.operation === 'files.preview') {
            if (r.sessionId !== undefined) v.text(r.sessionId, 'session', 128);
            return this.previews.open({ user, root, path, contextSessionId: r.sessionId, self: r.action === 'member.content' }, caller, users);
          }
          const rev = revision(stat); if (r.revision !== undefined && r.revision !== rev) reject('ADMIN_FILE_CONFLICT', 'The file changed. Restart the download.', 409);
          if (r.operation === 'files.read') {
            if (stat.size > TEXT_LIMIT) return { binary: true, size: stat.size, revision: rev, reason: 'large' };
            const data = Buffer.alloc(stat.size); let position = 0;
            while (position < data.length) { const part = await file.read(data, position, data.length - position, position); if (!part.bytesRead) break; position += part.bytesRead; }
            if (position !== stat.size || revision(await file.stat()) !== rev) reject('ADMIN_FILE_CONFLICT', 'The file changed. Reload it.', 409);
            let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return { binary: true, size: stat.size, revision: rev }; }
            return text.includes('\0') ? { binary: true, size: stat.size, revision: rev } : { text, size: stat.size, revision: rev };
          }
          const offset = r.offset ?? 0; v.integer(offset, 'offset'); if (offset > stat.size) reject('INVALID_INPUT', 'Invalid download offset.');
          const bytes = Buffer.alloc(Math.min(CHUNK, stat.size - offset)); const read = await file.read(bytes, 0, bytes.length, offset);
          if (revision(await file.stat()) !== rev || (!read.bytesRead && offset < stat.size)) reject('ADMIN_FILE_CONFLICT', 'The file changed. Restart the download.', 409);
          return { data: bytes.subarray(0, read.bytesRead).toString('base64'), size: stat.size, revision: rev, nextOffset: offset + read.bytesRead };
        } finally { await file.close(); }
      }
      if (r.operation === 'upload.begin') {
        v.integer(r.size, 'file size'); if (this.uploads.size >= 32) reject('ADMIN_UPLOAD_BUSY', 'Too many active uploads.', 409);
        const current = await exists(at(location.handle, location.name));
        if (current && !current.isFile()) reject('ADMIN_FILE_TYPE', 'Only regular files may be replaced.');
        if ((current ? revision(current) : null) !== (r.revision ?? null)) reject('ADMIN_FILE_CONFLICT', 'The file changed or the destination already exists.', 409);
        const id = randomUUID(), temporary = UPLOAD_PREFIX + id;
        const held = await directory(root, posix.dirname(path) === '.' ? '' : posix.dirname(path));
        let file;
        try { file = await open(at(held, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, current ? current.mode & 0o777 : 0o600); }
        catch (error) { await held.close(); throw error; }
        this.uploads.set(id, { owner: tokenKey(caller), userId: user.id, parent: held, file, temporary, name: location.name, path, revision: current ? revision(current) : null, size: r.size, written: 0, at: Date.now() });
        return { uploadId: id, chunkBytes: CHUNK };
      }
      return await guard(async () => {
        if (r.operation === 'files.mkdir') { await mkdir(at(location.handle, location.name), { mode: 0o700 }); return { created: true }; }
        if (this.protectedDirectory(user.id, root, path)) reject('ADMIN_DIRECTORY_BOUND', 'Session working directories must keep their location. Manage their contents instead.', 409);
        const stat = await lstat(at(location.handle, location.name));
        if (r.revision !== revision(stat)) reject('ADMIN_FILE_CONFLICT', 'The item changed. Refresh the directory.', 409);
        if (r.operation === 'files.rename') {
          const target = await parent(root, relativePath(r.to, false));
          try {
            if (await exists(at(target.handle, target.name))) reject('ADMIN_FILE_EXISTS', 'The destination already exists.', 409);
            await rename(at(location.handle, location.name), at(target.handle, target.name)); return { renamed: true };
          } finally { await target.handle.close(); }
        }
        if (r.operation === 'files.delete') {
          if (r.confirm !== true) reject('ADMIN_DELETE_CONFIRMATION', 'Confirm deletion before continuing.', 409);
          return this.recycleDelete({ root, user, path, location, revision: r.revision });
        }
        reject('INVALID_INPUT', 'Unknown file operation.');
      });
    } finally { await location.handle.close(); }
  }
  async discard(id) {
    const job = this.uploads.get(id); if (!job) return;
    this.uploads.delete(id);
    try { await job.file.close(); await unlink(at(job.parent, job.temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await job.parent.close(); }
  }
  async cancelUserUploads(userId) { await Promise.all([...this.uploads].filter(([, job]) => job.userId === userId).map(([id]) => this.discard(id))); }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.all([...this.uploads.keys()].map(id => this.discard(id))); }
}
