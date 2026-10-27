import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { reject } from '../core/errors.js';

const loginKey = caller => createHash('sha256').update(caller.token).digest('hex');
export const PREVIEW_ACTIONS = Object.freeze(['session/list', 'session/follow', 'session/page', 'session/projections', 'session/attachment', 'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'workspaceFiles/changes']);

/** Explicit, login-bound read grants for the native conversation/file UI. */
export class AdministratorPreviews {
  constructor({ core, hostCapability, ownership, sessions, invalidate = () => {} }) {
    Object.assign(this, { core, hostCapability, ownership, sessions, invalidate });
    this.leases = new Map(); this.listeners = new Set();
  }
  valid(lease) {
    try { return lease.expiresAt > Date.now() && (lease.self ? this.core.memberAccess(lease.adminId, this.hostCapability).files && this.ownership.ownerOf(lease.sessionId) === lease.adminId : this.core.memberIsAdministrator(lease.adminId, this.hostCapability)); }
    catch { return false; }
  }
  bindings(principal) {
    if (principal?.kind !== 'lan-member') return [];
    return [...this.leases.values()].filter(lease => lease.login === principal.sessionId && lease.adminId === principal.userId && this.valid(lease)).map(lease => ({
      role: { name: 'administrator-preview', resource: { kind: 'session' }, actions: PREVIEW_ACTIONS },
      resource: { kind: 'session', id: lease.sessionId },
    }));
  }
  fileRoot(principal, sessionId) {
    return [...this.leases.values()].find(lease => lease.login === principal?.sessionId && lease.adminId === principal?.userId && lease.sessionId === sessionId && this.valid(lease))?.root;
  }
  active(sessionId) { return [...this.leases.values()].some(lease => lease.sessionId === sessionId && this.valid(lease)); }
  async open({ user, root, sessionId, contextSessionId, path, self = false }, caller, users) {
    const auth = await this.core.restoreLogin(caller.token, caller.audience ?? 'member');
    if (self ? auth.user.id !== user.id || !this.core.memberAccess(auth.user.id, this.hostCapability).files : auth.user.role !== 'admin') reject('FORBIDDEN', 'Preview access is not authorized.', 403);
    if (contextSessionId !== undefined) {
      if (path === undefined) reject('FORBIDDEN', 'A preview container is only valid for files.', 403);
      // A native owner window may be showing an unmanaged Host conversation.
      // The hint can reuse only this login's Session; otherwise use the managed fallback.
      if (this.ownership.ownerOf(contextSessionId) === auth.user.id) sessionId = contextSessionId;
    }
    if (!sessionId) {
      const rows = await this.sessions.list({});
      const owned = new Set(this.ownership.entriesOf(user.id).map(row => row.sessionId));
      sessionId = rows.items.find(row => owned.has(row.sessionId))?.sessionId
        ?? rows.items.find(row => users.some(owner => this.ownership.entriesOf(owner.id).some(entry => entry.sessionId === row.sessionId)))?.sessionId;
    }
    if (!sessionId) reject('ADMIN_PREVIEW_UNAVAILABLE', 'A workspace conversation is required for the native file preview.', 409);
    if (self && this.ownership.ownerOf(sessionId) !== auth.user.id) reject('FORBIDDEN', 'A personal preview requires an owned conversation.', 403);
    const previewId = randomUUID();
    const login = loginKey(caller);
    for (const [id, lease] of this.leases) if (!this.valid(lease) || lease.login === login) this.leases.delete(id);
    this.leases.set(previewId, { login, adminId: auth.user.id, sessionId, root, expiresAt: auth.expiresAt, self });
    this.changed();
    return { previewId, sessionId, userId: user.id, displayName: user.displayName, ...(self ? { self: true } : {}), ...(path === undefined ? {} : { fileDirectory: posix.dirname(root + '/' + path), fileAddress: `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${(root + '/' + path).split('/').map(encodeURIComponent).join('/')}` }) };
  }
  release(previewId, caller) {
    const lease = this.leases.get(previewId);
    if (lease && lease.login !== loginKey(caller)) reject('FORBIDDEN', 'Preview belongs to another login.', 403);
    this.leases.delete(previewId); this.changed(); return { closed: true };
  }
  changed() { this.invalidate(); for (const listener of this.listeners) listener(); }
  close() { this.leases.clear(); this.changed(); }
}

/** The native follow's first yield is a complete, paginated snapshot. Closing
 * that iterator before its next step deliberately skips Agent promotion. Keep
 * following committed native events without copying the native history format. */
export async function* previewHistory({ ctx, follow, receiver, request, signal, previews }) {
  const id = request.address.sessionId;
  const queue = []; let wake;
  const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
  const dispose = ctx.on('session/event', (session, event) => { if (session.id === id) { queue.push(event); notify(); } }, { global: true });
  previews.listeners.add(notify); signal.addEventListener('abort', notify, { once: true });
  try {
    const iterator = follow.call(receiver, request, signal)[Symbol.asyncIterator]();
    let first;
    try { first = await iterator.next(); } finally { await iterator.return?.(); }
    if (first.done || first.value.type !== 'snapshot') reject('ADMIN_PREVIEW_UNAVAILABLE', 'Native conversation snapshot is unavailable.', 503);
    let cursor = first.value.cursor;
    yield first.value;
    while (!signal.aborted && previews.active(id)) {
      const event = queue.shift();
      if (!event) { await new Promise(resolve => { wake = resolve; }); continue; }
      if (event.seq <= cursor) continue;
      cursor = event.seq; yield { type: 'event', event };
    }
  } finally { dispose(); previews.listeners.delete(notify); signal.removeEventListener('abort', notify); }
}

export function installPreviewHistory(ctx, previews) {
  const controller = ctx.get('sessionController'), original = controller.follow;
  function follow(request, signal) {
    if (request.address?.kind === 'session' && previews.active(request.address.sessionId) && !ctx.get('sessions').get(request.address.sessionId)) {
      return previewHistory({ ctx, follow: original, receiver: this, request, signal, previews });
    }
    return original.call(this, request, signal);
  }
  controller.follow = follow;
  return () => { if (controller.follow === follow) controller.follow = original; };
}

/** Keep DSH's native listing and watch implementation, resolving only an
 * explicitly leased preview path against that lease's read-only root. */
export function installPreviewFileScopes(ctx, previews) {
  const files = ctx.get('workspaceFiles'), restore = [];
  for (const method of ['list', 'changes']) {
    const original = files[method];
    function previewScope(scope, path, signal) {
      const root = previews.fileRoot(this.ctx.invocation?.peer?.principal, scope.sessionId);
      const absolute = posix.resolve(scope.workspaceRoot, path.replaceAll('\\', '/'));
      const selected = root && (absolute === root || absolute.startsWith(root + '/')) ? { ...scope, workspaceRoot: root } : scope;
      return original.call(this, selected, path, signal);
    }
    files[method] = previewScope;
    restore.push(() => { if (files[method] === previewScope) files[method] = original; });
  }
  return () => restore.reverse().forEach(dispose => dispose());
}
