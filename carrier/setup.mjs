import { hostname } from 'node:os';
import { posix } from 'node:path';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import * as v from '../core/validation.js';
import { reject } from '../core/errors.js';
import { homeRoot } from '../runtime/home-directories.mjs';
import { memberAlias } from './auth.mjs';

/** First-run service configuration, independent of account and native DSH data. */
export class ServerSetup {
  constructor({ store, core, homes, origin, ownerOrigin, aliases = [], recommendedRoot = null, validateDirectories, modelVariants = () => 0, onConfigured = () => {}, now = Date.now }) {
    Object.assign(this, { store, core, homes, origin, ownerOrigin, aliases, recommendedRoot, validateDirectories, modelVariants, onConfigured, now });
  }
  validOrigin(value) {
    if (value === this.origin) return new URL(value);
    return memberAlias(value, this.origin, this.ownerOrigin);
  }
  async start(coreState) {
    const saved = await this.store.load();
    const state = saved ?? { version: 1, revision: 0, required: !coreState?.users?.length, memberOrigin: this.aliases[0] ?? this.origin, sharedDirectories: [], completedAt: coreState?.users?.length ? this.now() : null };
    v.object(state, ['version', 'revision', 'required', 'memberOrigin', 'sharedDirectories', 'completedAt']);
    if (state.version !== 1) reject('SETUP_INVALID', 'Unsupported setup state.', 503);
    v.integer(state.revision, 'setup revision'); v.bool(state.required, 'setup required');
    this.validOrigin(state.memberOrigin); v.sharedDirectories(state.sharedDirectories);
    if (state.completedAt !== null) v.integer(state.completedAt, 'setup completed');
    if (state.required !== (state.completedAt === null)) reject('SETUP_INVALID', 'Inconsistent setup state.', 503);
    if (saved === null) await this.store.save(structuredClone(state));
    this.state = structuredClone(state);
    return this;
  }
  snapshot() {
    const base = new URL(this.state.memberOrigin);
    const host = hostname().toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
    return { ...structuredClone(this.state), recommendedSharedDirectory: this.recommendedRoot, suggestedHost: host ? `${host}.local` : '', port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)), modelVariants: this.modelVariants(), fallbackUrl: this.origin + '/lan/' };
  }
  authorizeUser(user) {
    if (this.state.required && user?.role !== 'admin') reject('SETUP_REQUIRED', '管理员尚未完成首次设置，请稍后登录 / Initial server setup is not complete.', 503);
  }
  defaults(request) {
    if (!['admin.createUser', 'admin.createInvite'].includes(request.action) || Object.hasOwn(request.access ?? {}, 'sharedDirectories')) return request;
    return { ...request, access: { ...request.access, sharedDirectories: structuredClone(this.state.sharedDirectories) } };
  }
  complete(request, caller) {
    return this.core.runAdministratorOperation(caller, async coreState => {
      v.object(request, ['action', 'expectedRevision', 'root', 'homeRevision', 'sharedDirectories', 'memberHost', 'createRecommended'], ['action', 'expectedRevision', 'root', 'homeRevision', 'sharedDirectories', 'memberHost']);
      if (request.action !== 'admin.completeSetup') reject('UNKNOWN_ACTION', 'Unknown setup action.', 404);
      v.integer(request.expectedRevision, 'setup revision'); v.integer(request.homeRevision, 'home revision');
      if (request.expectedRevision !== this.state.revision || !this.state.required) reject('SETUP_CONFLICT', 'Setup changed. Reload before continuing.', 409);
      const root = homeRoot(request.root), sharedDirectories = v.sharedDirectories(request.sharedDirectories);
      const host = v.text(request.memberHost, 'member hostname', 253).toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host) && !/^\[[0-9a-f:]+\]$/.test(host)) reject('INVALID_INPUT', 'Use a hostname without a protocol, port or path.');
      const base = new URL(this.state.memberOrigin), memberOrigin = `${base.protocol}//${host}${base.port ? ':' + base.port : ''}`;
      this.validOrigin(memberOrigin);
      const policy = await this.homes.policy();
      if (policy.revision !== request.homeRevision) reject('HOME_DIRECTORY_CONFLICT', 'Member data directory settings changed. Reload before continuing.', 409);
      const createRecommended = request.createRecommended === undefined ? false : v.bool(request.createRecommended, 'create recommended directory');
      if (createRecommended && (!this.recommendedRoot || !sharedDirectories.some(row => row.path === this.recommendedRoot))) reject('INVALID_INPUT', 'Choose the recommended shared directory before creating it.');
      await this.validateDirectories(sharedDirectories.filter(row => !createRecommended || row.path !== this.recommendedRoot), root);
      if (createRecommended) {
        homeRoot(this.recommendedRoot);
        if (this.recommendedRoot === root || this.recommendedRoot.startsWith(root + '/') || root.startsWith(this.recommendedRoot + '/')) reject('INVALID_INPUT', 'Shared and private member directories must be separate.');
        const parent = posix.dirname(this.recommendedRoot);
        if ((await realpath(parent)).replaceAll('\\', '/') !== parent) reject('INVALID_INPUT', 'Recommended directory parent must be canonical.');
        try { await mkdir(this.recommendedRoot, { mode: 0o750 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const info = await lstat(this.recommendedRoot);
        if (!info.isDirectory() || info.isSymbolicLink()) reject('INVALID_INPUT', 'The recommended shared path must be a directory, not a link.');
      }
      await this.validateDirectories(sharedDirectories, root);
      await this.homes.synchronize(coreState);
      if (root !== policy.root) await this.homes.update({ root, expectedRevision: policy.revision });
      const next = { version: 1, revision: this.state.revision + 1, required: false, memberOrigin, sharedDirectories, completedAt: this.now() };
      await this.store.save(structuredClone(next));
      this.state = next;
      this.onConfigured(memberOrigin);
      return this.snapshot();
    });
  }
}
