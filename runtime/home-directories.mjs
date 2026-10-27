import path from 'node:path';
import * as v from '../core/validation.js';
import { LanError, reject } from '../core/errors.js';

const clone = value => structuredClone(value);
/** Client-facing allocation only. Host storage paths and IDs stay in the broker;
 * administrators configure roots through the separately authorized policy. */
export function publicHome(home) {
  return { status: ['ready', 'pending', 'unavailable'].includes(home?.status) ? home.status : 'unavailable', automatic: true,
    path: typeof home?.path === 'string' && home.path ? '~' : null };
}
/** Administrator-selected broker storage only. Never a client-controlled cwd. */
export function homeRoot(value) {
  const windows = process.platform === 'win32' && typeof value === 'string' && /^[A-Za-z]:\//.test(value);
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[\\\u0000-\u001f\u007f]/.test(value) || !(windows || value.startsWith('/')) || value === '/' || /^[A-Za-z]:\/$/.test(value) || (windows ? path.win32.resolve(value).replaceAll('\\', '/') : path.posix.resolve(value)) !== value) reject('INVALID_HOME_ROOT', 'Use a canonical absolute server directory.', 400);
  const reserved = ['/usr', '/etc', '/run', '/dev', '/proc', '/sys', '/bin', '/sbin', '/lib', '/lib64', '/boot'];
  if (reserved.some(root => value === root || value.startsWith(root + '/')) || ['/home', '/tmp', '/var', '/mnt', '/opt', '/srv', '/media'].includes(value) || /^\/(?:mnt|media)\/[^/]+$/.test(value)) reject('INVALID_HOME_ROOT', 'Choose a dedicated private data directory, not a system or shared mount root.', 400);
  if (value.split('/').some(part => /^(?:usr|prj)_[0-9a-f]{32}$/.test(part))) reject('INVALID_HOME_ROOT', 'The shared root cannot be inside a generated user or project directory.', 400);
  return value;
}
function disjointRoots(roots) {
  const unique = new Set(roots.filter(root => root !== null));
  for (const root of unique) {
    let parent = path.posix.dirname(root);
    while (parent !== '/' && parent !== path.posix.dirname(parent)) {
      if (unique.has(parent)) reject('HOME_ROOT_OVERLAP', 'Storage roots must be separate directories, not ancestors or descendants of an existing allocation root.', 409);
      parent = path.posix.dirname(parent);
    }
  }
}
function document(value) {
  v.object(value, ['version', 'revision', 'root', 'defaultRoot', 'homes', 'projects']);
  if (value.version !== 1) reject('HOME_STATE_INVALID', 'Unsupported home directory state.', 503);
  v.integer(value.revision, 'revision');
  for (const root of [value.root, value.defaultRoot]) if (root !== null) homeRoot(root);
  const homes = new Map(), projects = new Set();
  for (const entry of v.list(value.homes, 32768)) {
    v.object(entry, ['userId', 'root']); v.id(entry.userId, 'usr');
    if (entry.root !== null) homeRoot(entry.root);
    if (homes.has(entry.userId)) reject('HOME_STATE_INVALID', 'Duplicate home allocation.', 503);
    homes.set(entry.userId, entry);
  }
  for (const entry of v.list(value.projects, 32768)) {
    v.object(entry, ['userId', 'projectId', 'root']); v.id(entry.userId, 'usr'); v.id(entry.projectId, 'prj');
    if (entry.root !== null) homeRoot(entry.root);
    if (!homes.has(entry.userId) || projects.has(entry.projectId)) reject('HOME_STATE_INVALID', 'Invalid project directory allocation.', 503);
    projects.add(entry.projectId);
  }
  disjointRoots([value.root, value.defaultRoot, ...value.homes.map(entry => entry.root), ...value.projects.map(entry => entry.root)]);
  return clone(value);
}

/** Dedicated durable single writer. User IDs, not usernames, determine names.
 * Home/root bindings precede physical creation and never move on config edits.
 * No model route or namespace readiness is needed to own a home directory. */
export class HomeDirectories {
  constructor({ store, runtime, defaultRoot = null }) {
    if (!store?.load || !store?.save || !runtime?.directoryInfo || !runtime?.ensureHome) throw new TypeError('Home directories require storage and private directory broker ports.');
    if (defaultRoot !== null) homeRoot(defaultRoot);
    this.store = store; this.runtime = runtime; this.defaultRoot = defaultRoot; this.queue = Promise.resolve(); this.started = false;
  }
  serial(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async read() {
    if (!this.started) reject('HOME_NOT_READY', 'Home allocation is not ready.', 503);
    const value = await this.store.load();
    if (value == null) reject('HOME_STATE_MISSING', 'Home allocation state is missing; it will not be reset.', 503);
    return document(value);
  }
  async save(value) {
    document(value);
    try { await this.store.save(clone(value)); }
    catch { reject('HOME_STORAGE_FAILURE', 'Home allocation was not confirmed durable.', 503); }
  }
  async start(coreState) {
    return this.serial(async () => {
      const stored = await this.store.load();
      if (stored === null) {
        const state = { version: 1, revision: 0, root: null, defaultRoot: this.defaultRoot, homes: [], projects: [] };
        // Old releases used only this startup root. Pin it before publishing a
        // migration with existing projects; never defer it to another worker HOME.
        if (coreState?.projects?.length && state.defaultRoot === null) {
          try { state.defaultRoot = await this.effectiveRoot(null); }
          catch { reject('HOME_LEGACY_ROOT_UNCONFIRMED', 'Keep the original server storage root and projectRoot configured when upgrading existing projects. Their legacy storage root could not be confirmed.', 503); }
        }
        this.addAllocations(state, coreState, true); await this.save(state);
      } else {
        const state = document(stored);
        if (state.projects.some(entry => entry.root === null)) {
          try { await this.pinDefault(state); }
          catch { reject('HOME_LEGACY_ROOT_UNCONFIRMED', 'The saved legacy project root could not be confirmed. Keep the original projectRoot and Linux distribution configured.', 503); }
        }
      }
      this.started = true; return this;
    });
  }
  addAllocations(state, coreState, legacy = false) {
    coreState ??= { users: [], projects: [] };
    let changed = false;
    for (const user of coreState.users) {
      v.id(user.id, 'usr');
      if (!state.homes.some(entry => entry.userId === user.id)) {
        state.homes.push({ userId: user.id, root: state.root ?? state.defaultRoot }); changed = true;
      }
    }
    for (const project of coreState.projects) {
      v.id(project.id, 'prj'); v.id(project.ownerId, 'usr');
      const home = state.homes.find(entry => entry.userId === project.ownerId);
      if (!home) reject('HOME_STATE_INVALID', 'A project has no home owner.', 503);
      const existing = state.projects.find(entry => entry.projectId === project.id);
      if (existing && existing.userId !== project.ownerId) reject('HOME_STATE_INVALID', 'Project ownership changed.', 503);
      if (!existing) { state.projects.push({ userId: project.ownerId, projectId: project.id, root: legacy ? state.defaultRoot : home.root }); changed = true; }
    }
    return changed;
  }
  async synchronize(coreState) {
    const input = clone(coreState);
    return this.serial(async () => { const state = await this.read(); if (this.addAllocations(state, input)) await this.save(state); });
  }
  async effectiveRoot(root) {
    let result;
    try { result = await this.runtime.directoryInfo({ root }); }
    catch (error) {
      const invalid = ['INVALID_PROJECT_ROOT', 'UNSAFE_PROJECT_ROOT'].includes(error?.code);
      throw new LanError(invalid ? 'INVALID_HOME_ROOT' : 'HOME_BROKER_UNAVAILABLE', invalid ? 'Choose a dedicated canonical Linux directory. Existing directories must be privately owned (0700), with no symbolic links.' : 'The private Linux directory broker is unavailable. No host fallback or directory relocation was performed.', invalid ? 400 : 503);
    }
    return homeRoot(result?.root);
  }
  async pinDefault(state) {
    if (state.defaultRoot !== null) return;
    const root = await this.effectiveRoot(null);
    state.defaultRoot = root;
    for (const entry of [...state.homes, ...state.projects]) if (entry.root === null) entry.root = root;
    // The actual default is durable before its first physical directory is made.
    await this.save(state);
  }
  async policyFrom(state) {
    let root = state.root ?? state.defaultRoot;
    try { root = await this.effectiveRoot(root); } catch { /* Unavailable broker never discards administrator configuration. */ }
    return { revision: state.revision, root, configuredRoot: state.root, defaultRoot: state.defaultRoot, allocation: 'system', existingHomesPreserved: true };
  }
  async policy() { return this.serial(async () => this.policyFrom(await this.read())); }
  async own(userId) {
    v.id(userId, 'usr');
    return this.serial(async () => {
      const state = await this.read(), allocation = state.homes.find(entry => entry.userId === userId);
      if (!allocation) reject('HOME_NOT_ALLOCATED', 'The user home has not been allocated.', 503);
      let root = allocation.root, status = 'unavailable';
      try {
        if (root === null) { await this.pinDefault(state); root = allocation.root; }
        root = await this.effectiveRoot(root);
        const result = await this.runtime.ensureHome({ root, userId });
        if (result?.root !== root || result?.userId !== userId || result?.relativePath !== userId) reject('HOME_BROKER_INVALID', 'Home directory identity was not confirmed.', 503);
        status = 'ready';
      } catch { /* Logical binding remains durable; no unconfined fallback. */ }
      return { userId, relativePath: userId, root, path: root ? path.posix.join(root, userId) : null, status, automatic: true };
    });
  }
  async projectRoot({ userId, projectId }) {
    v.id(userId, 'usr'); v.id(projectId, 'prj');
    return this.serial(async () => {
      const state = await this.read();
      const home = state.homes.find(entry => entry.userId === userId);
      if (!home) reject('HOME_NOT_ALLOCATED', 'The user home has not been allocated.', 503);
      let entry = state.projects.find(entry => entry.projectId === projectId);
      if (entry && entry.userId !== userId) reject('PROJECT_NOT_FOUND', 'Project was not found.', 404);
      if (!entry) { entry = { userId, projectId, root: home.root }; state.projects.push(entry); await this.save(state); }
      if (entry.root === null) await this.pinDefault(state);
      return this.effectiveRoot(entry.root);
    });
  }
  async update(request) {
    const input = clone(request);
    return this.serial(async () => {
      v.object(input, ['root', 'expectedRevision']); homeRoot(input.root); v.integer(input.expectedRevision, 'expectedRevision');
      const state = await this.read();
      if (state.revision !== input.expectedRevision) reject('HOME_DIRECTORY_CONFLICT', 'The home directory policy changed. Reload before saving.', 409);
      if (state.revision === Number.MAX_SAFE_INTEGER) reject('HOME_REVISION_EXHAUSTED', 'The home policy revision is exhausted.', 503);
      // Resolve legacy defaults before cutover; a restart or changed worker HOME
      // must not silently rebind an existing user's null/default allocation.
      if (state.defaultRoot === null) await this.pinDefault(state);
      disjointRoots([input.root, state.root, state.defaultRoot, ...state.homes.map(entry => entry.root), ...state.projects.map(entry => entry.root)]);
      const resolved = await this.effectiveRoot(input.root);
      if (resolved !== input.root) reject('INVALID_HOME_ROOT', 'The selected directory is not canonical.', 400);
      state.root = input.root; state.revision++; await this.save(state);
      return this.policyFrom(state);
    });
  }
}

/** Same user-only authority for owner and member carriers. No model tool can
 * choose host storage, bypass CSRF or silently relocate another user's files. */
export function createHomeDirectoryController({ core, homes }) {
  return async (request, caller) => {
    v.object(request, ['action', 'root', 'expectedRevision']);
    if (request.action !== 'admin.updateHomeDirectory') reject('UNKNOWN_ACTION', 'Unknown home directory action.', 404);
    const fields = clone({ root: request.root, expectedRevision: request.expectedRevision });
    return core.runAdministratorOperation(caller, async state => {
      // Allocate any accounts created before this cutover under the old policy
      // while the authoritative account queue remains held.
      if (state) await homes.synchronize(state);
      return homes.update(fields);
    });
  };
}
