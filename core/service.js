import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify, types } from 'node:util';
import { LanError, reject } from './errors.js';
import * as v from './validation.js';
import { accountAccess } from './validation.js';
import { PersistentSessions } from './remember-sessions.js';
import { MemoryStore as SessionMemoryStore } from './store.js';
export { LanError } from './errors.js';
export { MemoryStore } from './store.js';
export { Lifecycle } from './lifecycle.js';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 12 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACTIONS = {
  status: [], me: [], snapshot: ['section'],
  'preferences.update': ['access', 'expectedRevision'],
  'password.change': ['currentPassword', 'password'],
  bootstrap: ['username', 'displayName', 'password', 'remember'],
  'owner.recoverAdministrator': ['username', 'password'],
  login: ['username', 'password', 'remember'],
  redeem: ['inviteToken', 'username', 'password', 'displayName', 'remember'],
  logout: [],
  'admin.createUser': ['username', 'displayName', 'password', 'modelAccess', 'routeIds', 'defaultRouteId', 'access'],
  'admin.createInvite': ['displayName', 'modelAccess', 'routeIds', 'defaultRouteId', 'access'],
  'admin.listInvites': ['page'],
  'admin.getUser': ['userId'],
  'admin.listUsers': ['query', 'status', 'page', 'pageSize', 'summary', 'includeHistory'],
  'usage.list': ['query', 'status', 'page', 'pageSize'],
  'admin.revokeInvite': ['inviteId', 'expectedRevision'],
  'admin.reissueInvite': ['inviteId', 'expectedRevision'],
  'admin.updateUser': ['userId', 'expectedRevision', 'displayName', 'role', 'disabled', 'modelAccess', 'routeIds', 'defaultRouteId', 'access'],
  'admin.prepareBatchAccess': ['userIds', 'query', 'status', 'capture'],
  'admin.batchUpdateAccess': ['targets', 'selectionId', 'modelAccess', 'routeIds', 'defaultRouteId', 'access'],
  'admin.archiveUser': ['userId', 'expectedRevision'],
  'admin.restoreUser': ['userId', 'expectedRevision'],
  'admin.deleteUser': ['userId', 'expectedRevision', 'confirmUsername'],
  'admin.resetPassword': ['userId', 'password'],
  'admin.upsertRoute': ['routeId', 'label', 'provider', 'model', 'enabled', 'default'],
  'admin.publishEnvironment': ['skills', 'mcp', 'agents', 'contentRevision'],
  'projects.create': ['title', 'routeId'],
  'projects.rename': ['projectId', 'title'],
  'routes.select': ['projectId', 'routeId'],
  'projects.open': ['projectId'],
  'terminal.open': ['projectId'],
  'projects.activity': ['projectId', 'event'],
};
const READS = new Set(['status', 'me', 'snapshot', 'admin.listInvites', 'admin.getUser', 'admin.listUsers', 'usage.list']);
const PUBLIC = new Set(['status', 'bootstrap', 'login', 'redeem', 'owner.recoverAdministrator']);
const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (prefix) => `${prefix}_${randomBytes(16).toString('hex')}`;
const secret = () => randomBytes(32).toString('base64url');
const freshState = () => ({ version: 1, users: [], invites: [], routes: [], environment: { version: 0, skills: [], mcp: [], agents: [] }, projects: [], usage: [] });
// Empty legacy grants meant "not configured". An explicit custom empty list
// now means disabled; existing nonempty allowlists keep their restrictions.
const modelAccessOf = user => user.modelAccess ?? (user.routeIds.length ? 'custom' : 'inherit');
const publicUser = (user) => {
  const { id, username, displayName, role, disabled, routeIds, defaultRouteId } = user;
  return { id, username, displayName, role, disabled, archivedAt: user.archivedAt ?? null, revision: user.revision ?? 0, modelAccess: modelAccessOf(user), routeIds: [...routeIds], defaultRouteId, access: accountAccess(user.access) };
};
const preferenceView = user => {
  const granted = accountAccess(user.access), selection = v.personalAccess(user.preferences);
  for (const key of v.ACCESS_LISTS) if (granted[key] !== null && selection[key] !== null) selection[key] = selection[key].filter(id => granted[key].includes(id));
  return { revision: user.preferencesRevision ?? 0, selection, granted, effective: v.effectiveAccess(user) };
};
const inviteStatus = (invite, now) => invite.usedAt !== undefined ? 'used' : invite.revokedAt !== undefined ? 'revoked' : invite.expiresAt <= now ? 'expired' : 'pending';
const publicInvite = (invite, now) => ({ id: invite.id, displayName: invite.displayName, createdAt: invite.createdAt, expiresAt: invite.expiresAt, status: inviteStatus(invite, now), revision: invite.revision ?? 0, ...(invite.usedAt !== undefined ? { usedAt: invite.usedAt, usedBy: invite.usedBy } : {}), ...(invite.revokedAt !== undefined ? { revokedAt: invite.revokedAt } : {}) });
function appendInvite(state, invite, now) {
  if (state.invites.length >= 4096) {
    const index = state.invites.findIndex(row => inviteStatus(row, now) !== 'pending');
    if (index < 0) reject('INVITE_LIMIT', 'Too many pending invitations. Revoke an unused invitation first.', 409);
    state.invites.splice(index, 1);
  }
  state.invites.push(invite);
}

async function passwordFields(password) {
  v.password(password);
  const passwordSalt = randomBytes(16).toString('hex');
  const key = await scrypt(password, passwordSalt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { passwordSalt, passwordHash: key.toString('hex') };
}

async function passwordMatches(password, user) {
  // The same KDF work is performed for an unknown username.
  const key = await scrypt(password, user?.passwordSalt ?? '00000000000000000000000000000000', 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(user?.passwordHash ?? '0'.repeat(128), 'hex');
  return timingSafeEqual(key, expected) && Boolean(user);
}

/**
 * Policy/metadata service only. No action in this pilot invokes a host process,
 * creates a directory, binds a DSH session, or enables an execution adapter.
 */
export class LanService {
  #store;
  #now;
  #runtime;
  #state = null;
  #started = false;
  #closed = false;
  #queue = Promise.resolve();
  #sessions;
  #providers = new Set();
  #modelCatalog = null;
  #loginCap;#loginDescriptors=new WeakMap();
  #modelEpoch={};#modelChanging=false;
  #memberModels = new Set();
  #memberModelPending = new Set();
  #nativeUsage = new Map();
  #passwordAttempts = new Map();
  #batchSelections = new Map();

  constructor({ store, now = Date.now, runtime = null, sessions = null, hostCapability } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof now !== 'function') {
      throw new TypeError('LanService requires a load/save store and a clock function.');
    }
    this.#store = store;
    this.#now = now;
    this.#runtime = runtime;
    if(hostCapability!==undefined&&(!hostCapability||typeof hostCapability!=='object'||types.isProxy(hostCapability)||Array.isArray(hostCapability)))throw TypeError('Login lifetime requires an opaque Host capability.');this.#loginCap=hostCapability;this.#sessions = sessions ?? new PersistentSessions({ store: new SessionMemoryStore(), now, hostCapability });
  }

  #serial(operation) {
    const pending = this.#queue.then(operation);
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #time() { return v.integer(this.#now(), 'server time'); }

  async start() {
    return this.#serial(async () => {
      if (this.#closed) reject('SERVICE_CLOSED', 'Service is closed.', 503);
      if (this.#started) return;
      let state;
      try {
        const loaded = await this.#store.load();
        v.validateState(loaded === null ? freshState() : loaded);
        state = loaded === null ? freshState() : clone(loaded);
      } catch {
        reject('STORAGE_INVALID', 'Stored workspace state is unavailable or invalid.', 503);
      }
      await this.#sessions.start();if(this.#closed)reject('SERVICE_CLOSED','Service is closed.',503);
      this.#state = state;
      this.#started = true;
    });
  }

  async close() {
    this.#batchSelections.clear();
    for (const cut of [...this.#memberModels]) cut.controller.abort(new Error('Member model authority closed'));
    this.#memberModels.clear();
    this.#closed=true;const sessionsClosing=this.#sessions.close();
    return this.#serial(async () => {
      this.#closed = true;
      this.#started = false;
      await sessionsClosing;
    });
  }

  /** Host-only registry input. A provider key is not a credential or a URL. */
  async setProviderKeys(keys) {
    return this.#serial(() => {
      if (this.#closed) reject('SERVICE_CLOSED', 'Service is closed.', 503);
      const previous = this.#memberModelSignatures(this.#state);
      const providers=new Set(v.list(keys, 1024).map(v.key));this.#modelEpoch={};this.#providers=providers;
      this.#retireMemberModels(previous);
    });
  }

  /** Trusted Host catalog only; no action accepts provider/model/effort keys. */
  async setModelCatalog(entries) {
    const catalog = v.modelCatalog(entries);
    return this.#serial(async () => {
      this.#ready();
      // Bootstrap must not durably contain privileged routes before an admin
      // exists. It materializes this exact catalog in the bootstrap commit.
      const previous = this.#memberModelSignatures(this.#state);
      this.#modelEpoch={};this.#modelCatalog = clone(catalog); // revocation is fail-closed even if durable reconciliation fails
      this.#retireMemberModels(previous);
      if (this.#state.users.length) {
        const draft = clone(this.#state); this.#materializeCatalog(draft, catalog);
        if (JSON.stringify(draft) !== JSON.stringify(this.#state)) await this.#commit(state => { this.#materializeCatalog(state, catalog); return null; });
      }
      this.#modelCatalog = clone(catalog);
    });
  }
  #materializeCatalog(state, catalog) {
    const tuple = route => JSON.stringify([route.provider, route.model, route.reasoningEffort ?? null]);
    const current = new Map(catalog.map(entry => [tuple(entry), entry]));
    const migrated = new Map();
    for (const route of state.routes) {
      const replacement = current.get(tuple(route));
      if (replacement && route.id !== replacement.id) migrated.set(route.id, replacement.id);
    }
    const remap = value => migrated.get(value) ?? value;
    for (const owner of [...state.users, ...state.invites]) {
      owner.routeIds = [...new Set(owner.routeIds.map(remap))];
      if (owner.defaultRouteId !== null) owner.defaultRouteId = remap(owner.defaultRouteId);
    }
    for (const project of state.projects) project.routeId = remap(project.routeId);
    const previous = state.routes;
    const active = catalog.map(entry => ({ ...entry, enabled: true, default: previous.some(route => route.default && tuple(route) === tuple(entry)) }));
    // Preserve unavailable routes for historical project/user references, but
    // never dispatch them or infer an effort from an adapter default.
    state.routes = [...active, ...previous.filter(route => !current.has(tuple(route))).map(route => ({ ...route, enabled: false, default: false }))];
  }
  #catalogAllows(route) {
    return this.#modelCatalog === null || this.#modelCatalog.some(entry => entry.id === route.id && entry.provider === route.provider && entry.model === route.model && entry.reasoningEffort === (route.reasoningEffort ?? null));
  }

  #ready() {
    if (!this.#started || this.#closed) reject('SERVICE_UNAVAILABLE', 'Workspace service is not running.', 503);
  }

  #capabilities() {
    return { mode: 'local-pilot', sharedAccess: false, isolatedExecution: false, terminal: false, accountLifecycle: true,
      modelInvocation: false, idleMinutes: 15, environmentVersion: this.#state.environment.version };
  }

  async #authenticate(context) {
    return this.#sessions.authenticate(context.token, { audience: context.audience ?? 'legacy', lookupUser: userId => this.#state.users.find(candidate => candidate.id === userId) });
  }

  /** Private carrier integration: requires the opaque cookie, never a user ID.
   * Owner/member callers must supply their fixed, trusted audience. */
  async restoreLogin(token, audience) {
    return this.#serial(async () => {
      this.#ready();
      if (!['owner', 'member'].includes(audience)) reject('UNAUTHENTICATED', 'Sign in is required.', 401);
      const auth = await this.#authenticate({ token, audience });
      return { user: publicUser(auth.user), csrf: auth.csrf, remember: auth.session.remember, expiresAt: auth.session.expiresAt };
    });
  }

  /** Host-only capture after actual credential authentication. No wire action
   * can mint a loginId, and no token/hash is exposed in the returned descriptor. */
  async captureLogin(token,audience,cap){if(!this.#loginCap||cap!==this.#loginCap||audience!=='member')reject('UNAUTHENTICATED','Login lifetime unavailable.',401);return this.#serial(async()=>{this.#ready();const auth=await this.#authenticate({token,audience}),source=this.#sessions.captureLogin(auth,cap);let descriptor=this.#loginDescriptors.get(source);if(!descriptor){const expected={id:auth.user.id,passwordSalt:auth.user.passwordSalt,passwordHash:auth.user.passwordHash},assertCurrent=()=>{this.#ready();source.assertCurrent();const current=this.#state.users.find(user=>user.id===expected.id);if(!current||current.disabled||current.passwordSalt!==expected.passwordSalt||current.passwordHash!==expected.passwordHash)reject('UNAUTHENTICATED','Login lifetime unavailable.',401);};descriptor=Object.freeze({principal:Object.freeze({kind:'lan-project-member',userId:source.userId,loginId:source.loginId}),assertCurrent,observe:()=>{assertCurrent();const watch=source.observe();try{assertCurrent();if(watch.state!=='pending')reject('UNAUTHENTICATED','Login lifetime unavailable.',401);return watch;}catch(error){watch.close();throw error;}}});this.#loginDescriptors.set(source,descriptor);}descriptor.assertCurrent();return descriptor;});}

  loginAuthority(cap){if(!this.#loginCap||cap!==this.#loginCap)throw Error('Login lifetime unavailable.');return Object.freeze({resolve:principal=>{const source=this.#sessions.resolveLogin(principal,cap),descriptor=this.#loginDescriptors.get(source);if(!descriptor)throw Error('Login lifetime unavailable.');descriptor.assertCurrent();return descriptor;}});}

  /** Credential-free effective model grants for an EXACT captured member login.
   * Host capability only: never a Remote method, raw state snapshot or work grant.
   * Cuts cannot renew after any model policy commit/refresh or pending write. */
  modelAuthority(cap){
    if(!this.#loginCap||cap!==this.#loginCap)throw Error('Model authority unavailable.');
    const authority=this.loginAuthority(cap),deny=()=>{throw Error('Model authority unavailable.');};
    return Object.freeze({capture:principal=>{
      this.#ready();const login=authority.resolve(principal);login.assertCurrent();
      if(this.#modelChanging||this.#modelCatalog===null)deny();
      const epoch=this.#modelEpoch,policy=this.#memberModelPolicy(login.principal.userId);
      if(!policy)deny();
      const routes=policy.routes.map(route=>Object.freeze(route));
      const seal=()=>{this.#ready();if(this.#modelChanging||this.#modelEpoch!==epoch)deny();this.#sessions.sealLogin(login.principal,cap);};
      const assertCurrent=()=>{seal();login.assertCurrent();seal();};assertCurrent();
      return Object.freeze({routes:Object.freeze(routes),defaultRouteId:policy.defaultRouteId,assertCurrent,seal});
    }});
  }

  #memberModelPolicy(userId, state = this.#state) {
    const user = state?.users.find(row => row.id === userId);
    if (!user || user.disabled || this.#modelCatalog === null) return null;
    const modelAccess = modelAccessOf(user), allowed = new Set(user.routeIds);
    const routes = state.routes.filter(route => (modelAccess === 'inherit' || allowed.has(route.id)) && route.enabled && this.#providers.has(route.provider) && this.#catalogAllows(route))
      .map(route => Object.fromEntries(['id', 'provider', 'providerName', 'model', 'modelName', 'reasoningEffort', 'effortName'].map(key => [key, route[key] ?? null])))
      .sort((a, b) => a.id.localeCompare(b.id));
    const defaultRouteId = modelAccess === 'custom' && routes.some(route => route.id === user.defaultRouteId) ? user.defaultRouteId : null;
    return { modelAccess, routes, defaultRouteId,
      fingerprint: digest(JSON.stringify([user.passwordSalt, user.passwordHash, modelAccess, routes.map(route => [route.id, route.provider, route.model, route.reasoningEffort]), defaultRouteId, v.effectiveAccess(user)])) };
  }

  #memberModelSignatures(state) {
    return new Map((state?.users ?? []).map(user => [user.id, user.disabled ? null : digest(JSON.stringify([user.passwordSalt, user.passwordHash, v.effectiveAccess(user), this.#memberModelPolicy(user.id, state)?.fingerprint ?? null]))]));
  }

  #retireMemberModels(previous, next = this.#state) {
    const current = this.#memberModelSignatures(next);
    const changed = new Set([...previous.keys(), ...current.keys()].filter(id => previous.get(id) !== current.get(id)));
    for (const cut of [...this.#memberModels]) if (changed.has(cut.userId)) {
      cut.controller.abort(new Error('Member model authorization changed'));
      this.#memberModels.delete(cut);
    }
    return changed;
  }

  /** Native background work belongs to an account, independent of a browser's
   * cookie lifetime. Only the trusted Host can capture this account authority.
   * Pending grant cuts retire affected users; unrelated users keep running.
   */
  memberModels(userId, cap) {
    if (!this.#loginCap || cap !== this.#loginCap) reject('FORBIDDEN', 'Trusted member model authority required.', 403);
    this.#ready(); v.id(userId, 'usr');
    const policy = this.#memberModelPolicy(userId);
    if (!policy || this.#memberModelPending.has(userId)) reject('MODEL_DENIED', 'Member model authorization is unavailable.', 403);
    const controller = new AbortController(), cut = { userId, controller }, fingerprint = policy.fingerprint;
    this.#memberModels.add(cut);
    let closed = false;
    const assertCurrent = () => {
      this.#ready();
      if (closed || controller.signal.aborted || this.#memberModelPending.has(userId) || this.#memberModelPolicy(userId)?.fingerprint !== fingerprint) reject('MODEL_DENIED', 'Member model authorization changed.', 403);
    };
    return Object.freeze({ modelAccess: policy.modelAccess, routes: Object.freeze(policy.routes.map(route => Object.freeze(route))), defaultRouteId: policy.defaultRouteId,
      signal: controller.signal, assertCurrent, close: () => { closed = true; this.#memberModels.delete(cut); } });
  }

  /** Trusted account policy read used at each native capability boundary. */
  memberAccess(userId, cap) {
    if (!this.#loginCap || cap !== this.#loginCap) reject('FORBIDDEN', 'Trusted member authority required.', 403);
    this.#ready(); v.id(userId, 'usr');
    const user = this.#state.users.find(row => row.id === userId);
    if (!user || user.disabled || this.#memberModelPending.has(userId)) reject('FORBIDDEN', 'Member access is unavailable.', 403);
    return v.effectiveAccess(user);
  }

  memberIsAdministrator(userId, cap) {
    this.memberAccess(userId, cap);
    return this.#state.users.find(row => row.id === userId).role === 'admin';
  }

  /** Trusted own-account operations never receive another user's state. */
  runMemberOperation(context, operation) {
    if (typeof operation !== 'function') throw new TypeError('A trusted Host operation is required.');
    return this.#serial(async () => {
      this.#ready();
      v.object(context, ['token', 'csrf', 'audience', 'ownerBootstrap'], []);
      const auth = await this.#authenticate(context);
      this.#csrf(context, auth.session);
      return operation({ user: publicUser(auth.user), access: v.effectiveAccess(auth.user) });
    });
  }

  /** Trusted Host-only port for user-confirmed administration in a separate
   * plugin domain. No Remote action accepts a callback. The account queue stays
   * held through the durable write, so disable/reset cannot race the authority
   * check. The callback receives a detached state snapshot and must not call
   * back into this core queue. The snapshot never crosses a browser boundary. */
  async runAdministratorOperation(context, operation) {
    if (typeof operation !== 'function') throw new TypeError('A trusted Host operation is required.');
    return this.#serial(async () => {
      this.#ready();
      v.object(context, ['token', 'csrf', 'audience', 'ownerBootstrap'], []);
      const auth = await this.#authenticate(context);
      this.#csrf(context, auth.session);
      if (auth.user.role !== 'admin') reject('FORBIDDEN', 'Administrator access is required.', 403);
      return operation(clone(this.#state));
    });
  }

  #csrf(context, session) {
    if (typeof context.csrf !== 'string' || !TOKEN.test(context.csrf) || digest(context.csrf) !== session.csrfHash) {
      reject('CSRF_INVALID', 'A valid CSRF token is required.', 403);
    }
  }

  async #sessionFor(user, request, context) {
    // Legacy direct integrations retain their historical 12-hour, memory-only
    // default. Production carriers always pass a fixed owner/member audience.
    const audience = context.audience ?? 'legacy';
    const remember = request.remember ?? audience !== 'legacy';
    if (typeof remember !== 'boolean') reject('INVALID_INPUT', 'Invalid remember option.');
    const session = await this.#sessions.issue(user, { remember, audience });
    return { ...session, user: publicUser(user) };
  }

  async #revoke(userId) { await this.#sessions.revokeUser(userId); }

  async #commit(change) {
    const draft = clone(this.#state);
    const result = await change(draft);
    v.validateState(draft);
    // No model DATA cut may survive a pending durable policy change, including
    // a failed save. Existing project/read/login semantics remain unchanged.
    this.#modelEpoch={};this.#modelChanging=true;
    const affected = this.#retireMemberModels(this.#memberModelSignatures(this.#state), draft);
    for (const id of affected) this.#memberModelPending.add(id);
    try { await this.#store.save(clone(draft));this.#state=draft; }
    catch { reject('STORAGE_FAILURE', 'Workspace changes could not be saved.', 503); }
    finally { this.#modelChanging=false; for (const id of affected) this.#memberModelPending.delete(id); }
    return clone(result);
  }

  #policy(routeIds, defaultRouteId, state = this.#state) {
    const routes = v.routeIds(routeIds);
    if (routes.some((routeId) => !state.routes.some((route) => route.id === routeId))) {
      reject('ROUTE_UNAVAILABLE', 'An allowed route does not exist.', 409);
    }
    const preferred = defaultRouteId === undefined ? null : defaultRouteId;
    if (preferred !== null && !routes.includes(v.id(preferred, 'rte'))) reject('INVALID_INPUT', 'Default route must belong to the allowlist.');
    return { routeIds: [...routes], defaultRouteId: preferred };
  }

  #route(user, requested) {
    const allowed = route => modelAccessOf(user) === 'inherit' || user.routeIds.includes(route.id);
    let routeId = requested;
    if (routeId === undefined) {
      const globalDefault = this.#state.routes.find((route) => route.default && allowed(route));
      routeId = (modelAccessOf(user) === 'custom' ? user.defaultRouteId : null) ?? globalDefault?.id;
    }
    if (routeId === undefined || routeId === null) reject('ROUTE_UNAVAILABLE', 'Select an authorized model route.', 403);
    v.id(routeId, 'rte');
    const route = this.#state.routes.find((candidate) => candidate.id === routeId);
    if (!route || !route.enabled || !allowed(route) || !this.#providers.has(route.provider) || !this.#catalogAllows(route)) {
      reject('ROUTE_UNAVAILABLE', 'The model route is not available to this account.', 403);
    }
    return route;
  }

  #project(user, projectId, checkRoute = true) {
    v.id(projectId, 'prj');
    const project = this.#state.projects.find((candidate) => candidate.id === projectId && candidate.ownerId === user.id);
    // Same response for a missing or foreign project; administrators have no owner bypass.
    if (!project) reject('PROJECT_NOT_FOUND', 'Project was not found.', 404);
    if (checkRoute) this.#route(user, project.routeId);
    return project;
  }

  #usageBoard(request = {}) {
    const { items, ...paging } = this.#userPage({ ...request, includeHistory: true });
    let unknown = false;
    const users = items.map((user) => {
      const legacy = this.#state.usage.find((entry) => entry.userId === user.id), native = this.#nativeUsage.get(user.id);
      const record = legacy || native ? Object.fromEntries(['calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls'].map(key => [key, (legacy?.[key] ?? 0) + (native?.[key] ?? 0)])) : null;
      const incomplete = !record || record.unknownCalls > 0 || (native?.unavailableSessions ?? 0) > 0;
      if (incomplete) unknown = true;
      const knownCalls = record ? record.calls - record.unknownCalls : null;
      return { displayName: user.displayName, calls: record && (record.calls > 0 || !incomplete || record.unknownCalls > 0) ? record.calls : null,
        inputTokens: record && (knownCalls > 0 || !incomplete) ? record.inputTokens : null,
        outputTokens: record && (knownCalls > 0 || !incomplete) ? record.outputTokens : null,
        totalTokens: record && (knownCalls > 0 || !incomplete) ? record.totalTokens : null,
        incomplete, unavailableSessions: native?.unavailableSessions ?? 0,
        unknownCalls: record?.unknownCalls ?? null, knownCalls,
        knownTokens: knownCalls > 0 ? { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens } : null };
    });
    return { users, unknown, ...paging };
  }

  /** Host-only absolute native-log aggregates; deliberately absent from RPC. */
  setNativeUsage(rows, cap) {
    return this.#serial(() => {
      this.#ready();
      if (!this.#loginCap || cap !== this.#loginCap) reject('FORBIDDEN', 'Trusted usage authority required.', 403);
      const next = new Map();
      for (const row of v.list(rows)) {
        v.object(row, ['userId', 'calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls', 'unavailableSessions']);
        v.id(row.userId, 'usr');
        if (![...this.#state.users, ...(this.#state.retiredUsers ?? [])].some(user => user.id === row.userId) || next.has(row.userId)) reject('INVALID_INPUT', 'Invalid usage owner.');
        for (const key of ['calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls', 'unavailableSessions']) v.integer(row[key], key);
        if (row.unknownCalls > row.calls || row.totalTokens !== row.inputTokens + row.outputTokens) reject('INVALID_INPUT', 'Invalid native usage totals.');
        next.set(row.userId, clone(row));
      }
      this.#nativeUsage = next;
      return this.#usageBoard();
    });
  }

  #filteredUsers(request = {}) {
    const query = request.query === undefined ? '' : v.text(request.query, 'account query', 160, 0).toLowerCase();
    const status = request.status === undefined ? 'all' : request.status;
    if (!['all', 'enabled', 'disabled', 'archived'].includes(status)) reject('INVALID_INPUT', 'Invalid account status filter.');
    const users = request.includeHistory ? [...this.#state.users, ...(this.#state.retiredUsers ?? [])] : this.#state.users;
    const rows = users.filter(user => `${user.displayName} ${user.username}`.toLowerCase().includes(query)
      && (status === 'archived' ? user.archivedAt !== undefined : request.includeHistory || user.archivedAt === undefined)
      && (['all', 'archived'].includes(status) || user.disabled === (status === 'disabled')));
    return { rows, query, status };
  }

  #userPage(request = {}) {
    const { rows, query, status } = this.#filteredUsers(request);
    const requestedPage = request.page === undefined ? 0 : v.integer(request.page, 'account page');
    const pageSize = request.pageSize === undefined ? 10 : request.pageSize;
    if (![5, 10, 20, 50].includes(pageSize)) reject('INVALID_INPUT', 'Invalid account page size.');
    const pages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(requestedPage, pages - 1);
    const items = rows.slice(page * pageSize, (page + 1) * pageSize);
    return { items, total: rows.length, page, pageSize, pages, query, status };
  }

  #listUsers(request = {}) {
    if (request.summary !== undefined) v.bool(request.summary, 'account summary');
    if (request.includeHistory !== undefined) v.bool(request.includeHistory, 'historical accounts');
    if (request.includeHistory && request.summary !== true) reject('INVALID_INPUT', 'Historical accounts are available only as content-owner summaries.');
    const page = this.#userPage(request);
    return { ...page, items: page.items.map(user => request.summary ? { ...Object.fromEntries(['id', 'username', 'displayName', 'role', 'disabled'].map(key => [key, user[key]])), archivedAt: user.archivedAt ?? null, deletedAt: user.deletedAt ?? null } : publicUser(user)) };
  }

  #snapshot(user) {
    const result = { user: publicUser(user), preferences: preferenceView(user), capabilities: this.#capabilities(),
      projects: this.#state.projects.filter((project) => project.ownerId === user.id).map(clone),
      routes: this.#state.routes.filter((route) => (modelAccessOf(user) === 'inherit' || user.routeIds.includes(route.id)) && route.enabled)
        .filter(route => this.#catalogAllows(route))
        .map(({ id, label, enabled, default: isDefault, reasoningEffort, effortName }) => ({ id, label, enabled, default: isDefault, ...(reasoningEffort !== undefined ? { reasoningEffort, effortName: effortName ?? null } : {}) })),
      usage: this.#usageBoard() };
    if (user.role === 'admin') {
      const { items: users, ...userPage } = this.#listUsers();
      result.admin = { users, userPage, routes: clone(this.#state.routes),
        environment: clone(this.#state.environment), availableProviderKeys: [...this.#providers].sort(),
        catalogManaged: this.#modelCatalog !== null, modelCatalog: clone(this.#modelCatalog ?? []) };
    }
    return result;
  }

  /** All requests (including reads/auth) run behind the same durable mutation queue. */
  async execute(request, context = {}) {
    return this.#serial(async () => {
      this.#ready();
      v.object(context, ['token', 'csrf', 'ownerBootstrap', 'audience'], []);
      if (context.audience !== undefined && !['owner', 'member', 'legacy'].includes(context.audience)) reject('INVALID_INPUT', 'Invalid login audience.');
      if (Object.hasOwn(context, 'ownerBootstrap')) v.bool(context.ownerBootstrap, 'ownerBootstrap');
      v.object(request, ['action', ...new Set(Object.values(ACTIONS).flat())], ['action']);
      if (typeof request.action !== 'string' || !Object.hasOwn(ACTIONS, request.action)) reject('UNKNOWN_ACTION', 'Unknown workspace action.', 404);
      const action = request.action;
      v.object(request, ['action', ...ACTIONS[action]], ['action']);
      if (action === 'snapshot' && request.section !== undefined && !['base', 'catalog', 'usage', 'full'].includes(request.section)) reject('INVALID_INPUT', 'Invalid snapshot section.');
      if (Object.hasOwn(request, 'remember')) v.bool(request.remember, 'remember');
      let auth;
      if (!PUBLIC.has(action)) {
        auth = await this.#authenticate(context);
        if (!READS.has(action)) this.#csrf(context, auth.session);
        if (action.startsWith('admin.') && auth.user.role !== 'admin') reject('FORBIDDEN', 'Administrator access is required.', 403);
      }
      switch (action) {
        case 'status': return { initialized: this.#state.users.length > 0, capabilities: this.#capabilities() };
        case 'me': return { user: publicUser(auth.user) };
        case 'snapshot': return this.#snapshot(auth.user);
        case 'admin.listUsers': return this.#listUsers(request);
        case 'usage.list': return this.#usageBoard(request);
        case 'admin.getUser': {
          const userId = v.id(request.userId, 'usr'), user = this.#state.users.find(row => row.id === userId);
          if (!user) reject('USER_NOT_FOUND', 'Account was not found.', 404);
          const preferences = preferenceView(user);
          if (user.disabled) preferences.effective = Object.fromEntries(Object.entries(preferences.effective).map(([key, value]) => [key, typeof value === 'boolean' ? false : []]));
          const routes = user.disabled ? [] : this.#state.routes.filter(route => route.enabled && (modelAccessOf(user) === 'inherit' || user.routeIds.includes(route.id)) && this.#catalogAllows(route)).map(({ id, label }) => ({ id, label }));
          return { user: publicUser(user), preferences, routes };
        }
        case 'password.change': {
          if (typeof request.currentPassword !== 'string' || request.currentPassword.length > 1024) reject('INVALID_INPUT', 'Invalid current password.');
          v.password(request.password);
          const now = this.#now(), old = this.#passwordAttempts.get(auth.user.id);
          const attempts = !old || now - old.at >= 60000 || now < old.at ? { at: now, count: 0 } : old;
          attempts.count++; this.#passwordAttempts.set(auth.user.id, attempts);
          if (attempts.count > 10) reject('AUTH_RATE_LIMIT', 'Too many password attempts; retry later.', 429);
          if (!await passwordMatches(request.currentPassword, auth.user)) reject('CURRENT_PASSWORD_INVALID', 'Current password is incorrect.', 403);
          if (request.currentPassword === request.password) reject('PASSWORD_UNCHANGED', 'Choose a different password.');
          const fields = await passwordFields(request.password);
          await this.#revoke(auth.user.id);
          await this.#commit(state => { Object.assign(state.users.find(row => row.id === auth.user.id), fields); return null; });
          this.#passwordAttempts.delete(auth.user.id);
          return { ok: true, signedOut: true, userId: auth.user.id };
        }
        case 'preferences.update': {
          v.integer(request.expectedRevision, 'preferences revision');
          if (request.expectedRevision !== (auth.user.preferencesRevision ?? 0)) reject('PREFERENCES_CONFLICT', 'Personal preferences changed. Reload before saving.', 409);
          const access = v.personalAccess(request.access), granted = accountAccess(auth.user.access);
          for (const key of v.ACCESS_LISTS) if (granted[key] !== null && access[key]?.some(id => !granted[key].includes(id))) reject('FORBIDDEN', 'A personal selection exceeds the administrator grant.', 403);
          return this.#commit(state => {
            const user = state.users.find(row => row.id === auth.user.id);
            user.preferences = access; user.preferencesRevision = (user.preferencesRevision ?? 0) + 1;
            return { user: publicUser(user), preferences: preferenceView(user) };
          });
        }
        case 'bootstrap': {
          if (context.ownerBootstrap !== true) reject('OWNER_REQUIRED', 'Owner authorization is required for initial setup.', 403);
          if (this.#state.users.length) reject('ALREADY_INITIALIZED', 'An administrator has already been initialized.', 409);
          const username = v.username(request.username);
          const displayName = v.text(request.displayName, 'displayName', 80);
          const fields = await passwordFields(request.password);
          const user = { id: identifier('usr'), username, displayName, role: 'admin', disabled: false,
            modelAccess: 'inherit', routeIds: [], defaultRouteId: null, ...fields };
          await this.#commit((state) => { state.users.push(user); if (this.#modelCatalog !== null) this.#materializeCatalog(state, this.#modelCatalog); return null; });
          return this.#sessionFor(user, request, context);
        }
        case 'owner.recoverAdministrator': {
          if (context.ownerBootstrap !== true || context.audience === 'member') reject('OWNER_REQUIRED', 'Native DSH owner authorization is required.', 403);
          const username = v.username(request.username), user = this.#state.users.find(row => row.username === username && row.role === 'admin');
          if (!user) reject('USER_NOT_FOUND', 'An existing administrator username is required.', 404);
          const fields = await passwordFields(request.password);
          await this.#revoke(user.id);
          await this.#commit(state => { const target = state.users.find(row => row.id === user.id); Object.assign(target, fields, { disabled: false, revision: (user.revision ?? 0) + 1 }); delete target.archivedAt; delete target.archiveDisabled; return null; });
          return { ok: true, userId: user.id };
        }
        case 'login': {
          const username = v.username(request.username);
          if (typeof request.password !== 'string' || request.password.length > 1024) reject('INVALID_INPUT', 'Invalid password.');
          const user = this.#state.users.find((candidate) => candidate.username === username);
          const matches = await passwordMatches(request.password, user);
          if (!matches || user.disabled) reject('INVALID_CREDENTIALS', 'Username or password is incorrect.', 401);
          return this.#sessionFor(user, request, context);
        }
        case 'redeem': {
          if (typeof request.inviteToken !== 'string' || !TOKEN.test(request.inviteToken)) reject('INVITE_INVALID', 'Invitation is invalid or expired.', 400);
          const invite = this.#state.invites.find((candidate) => candidate.tokenHash === digest(request.inviteToken));
          if (!invite || inviteStatus(invite, this.#time()) !== 'pending') reject('INVITE_INVALID', 'Invitation is invalid or expired.', 400);
          const username = v.username(request.username);
          if (this.#state.users.some((candidate) => candidate.username === username)) reject('USERNAME_TAKEN', 'Username is already in use.', 409);
          const displayName = v.text(request.displayName, 'displayName', 80);
          const fields = await passwordFields(request.password);
          const user = { id: identifier('usr'), username, displayName, role: 'member', disabled: false,
            modelAccess: modelAccessOf(invite), routeIds: [...invite.routeIds], defaultRouteId: invite.defaultRouteId, access: accountAccess(invite.access), ...fields };
          await this.#commit((state) => {
            Object.assign(state.invites.find(candidate => candidate.id === invite.id), { usedAt: this.#time(), usedBy: user.id, revision: (invite.revision ?? 0) + 1 });
            state.users.push(user);
            return null;
          });
          return this.#sessionFor(user, request, context);
        }
        case 'logout': await this.#sessions.revokeToken(auth.tokenHash, { hashed: true }); return { ok: true };
        case 'admin.createUser': {
          const username = v.username(request.username);
          const displayName = v.text(request.displayName, 'displayName', 80);
          if (this.#state.users.some((candidate) => candidate.username === username)) reject('USERNAME_TAKEN', 'Username is already in use.', 409);
          const policy = { ...this.#policy(request.routeIds ?? [], request.defaultRouteId), modelAccess: v.modelAccess(request.modelAccess ?? (request.routeIds === undefined ? 'inherit' : 'custom')) };
          const fields = await passwordFields(request.password);
          const user = { id: identifier('usr'), username, displayName, role: 'member', disabled: false, ...policy, access: accountAccess(request.access), ...fields };
          return this.#commit((state) => { state.users.push(user); return { user: publicUser(user) }; });
        }
        case 'admin.createInvite': {
          const displayName = request.displayName === undefined ? null : v.text(request.displayName, 'displayName', 80);
          const policy = { ...this.#policy(request.routeIds ?? [], request.defaultRouteId), modelAccess: v.modelAccess(request.modelAccess ?? (request.routeIds === undefined ? 'inherit' : 'custom')) };
          const inviteToken = secret();
          const createdAt = this.#time();
          const expiresAt = createdAt + INVITE_MS;
          const invite = { id: identifier('inv'), tokenHash: digest(inviteToken), displayName, ...policy, access: accountAccess(request.access), createdAt, expiresAt };
          await this.#commit((state) => {
            appendInvite(state, invite, createdAt);
            return null;
          });
          return { inviteToken, ...publicInvite(invite, createdAt) };
        }
        case 'admin.listInvites': {
          const page = request.page === undefined ? 0 : v.integer(request.page, 'invite page');
          const rows = [...this.#state.invites].reverse(), pages = Math.max(1, Math.ceil(rows.length / 20)), current = Math.min(page, pages - 1);
          return { items: rows.slice(current * 20, (current + 1) * 20).map(row => publicInvite(row, this.#time())), total: rows.length, page: current, pages };
        }
        case 'admin.revokeInvite':
        case 'admin.reissueInvite': {
          const inviteId = v.id(request.inviteId, 'inv'), invite = this.#state.invites.find(row => row.id === inviteId);
          if (!invite) reject('INVITE_NOT_FOUND', 'Invitation was not found.', 404);
          v.integer(request.expectedRevision, 'invite revision');
          if (request.expectedRevision !== (invite.revision ?? 0)) reject('INVITE_CONFLICT', 'Invitation changed. Reload before continuing.', 409);
          if (action === 'admin.revokeInvite' && inviteStatus(invite, this.#time()) !== 'pending') reject('INVITE_CONFLICT', 'Only pending invitations can be revoked.', 409);
          const now = this.#time(), inviteToken = secret();
          const next = { id: identifier('inv'), tokenHash: digest(inviteToken), displayName: invite.displayName, modelAccess: modelAccessOf(invite), routeIds: [...invite.routeIds], defaultRouteId: invite.defaultRouteId, access: accountAccess(invite.access), createdAt: now, expiresAt: now + INVITE_MS };
          return this.#commit(state => {
            const target = state.invites.find(row => row.id === inviteId);
            if (target.usedAt === undefined) target.revokedAt = now;
            target.revision = (target.revision ?? 0) + 1;
            if (action === 'admin.reissueInvite') { appendInvite(state, next, now); return { inviteToken, ...publicInvite(next, now) }; }
            return { invite: publicInvite(target, now) };
          });
        }
        case 'admin.archiveUser':
        case 'admin.restoreUser':
        case 'admin.deleteUser': {
          const userId = v.id(request.userId, 'usr'), user = this.#state.users.find(row => row.id === userId);
          if (!user) reject('USER_NOT_FOUND', 'Account was not found.', 404);
          v.integer(request.expectedRevision, 'account revision');
          if (request.expectedRevision !== (user.revision ?? 0)) reject('ACCOUNT_CONFLICT', 'Account changed. Reload before continuing.', 409);
          const archived = user.archivedAt !== undefined;
          if (action === 'admin.archiveUser') {
            if (archived) reject('ACCOUNT_ARCHIVED', 'The account is already archived.', 409);
            if (user.role === 'admin' && !this.#state.users.some(row => row.id !== userId && row.role === 'admin' && !row.disabled)) reject('LAST_ADMIN', 'Keep at least one active administrator.', 409);
            if (userId === auth.user.id) reject('SELF_ACCOUNT', 'Use another administrator to archive this account.', 409);
          } else if (!archived) reject('ARCHIVE_REQUIRED', 'Archive the account before restoring or deleting it.', 409);
          if (action === 'admin.deleteUser') {
            if (request.confirmUsername !== user.username) reject('DELETE_CONFIRMATION', 'Enter the exact username to confirm deletion.', 400);
            if ((this.#state.retiredUsers?.length ?? 0) >= 4096) reject('ACCOUNT_HISTORY_FULL', 'Retained account history has reached its limit.', 409);
          }
          await this.#revoke(userId);
          return this.#commit(state => {
            const target = state.users.find(row => row.id === userId);
            if (action === 'admin.deleteUser') {
              const retained = { ...Object.fromEntries(['id', 'username', 'displayName', 'role', 'archivedAt'].map(key => [key, target[key]])), disabled: true, deletedAt: Math.max(this.#time(), target.archivedAt) };
              (state.retiredUsers ??= []).push(retained);
              state.users = state.users.filter(row => row.id !== userId);
              return { ok: true, userId, dataRetained: true };
            }
            if (action === 'admin.archiveUser') { target.archiveDisabled = target.disabled; target.archivedAt = this.#time(); target.disabled = true; }
            else { target.disabled = target.archiveDisabled; delete target.archivedAt; delete target.archiveDisabled; }
            target.revision = (target.revision ?? 0) + 1;
            return { user: publicUser(target), userId };
          });
        }
        case 'admin.prepareBatchAccess': {
          const capture = request.capture === undefined ? true : v.bool(request.capture, 'capture selection');
          let users;
          if (request.userIds !== undefined) {
            if (request.query !== undefined || request.status !== undefined) reject('INVALID_INPUT', 'Choose account IDs or a filter, not both.');
            const ids = v.list(request.userIds, 4096).map(id => v.id(id, 'usr'));
            if (!ids.length || new Set(ids).size !== ids.length) reject('INVALID_INPUT', 'Choose distinct accounts.');
            const index = new Map(this.#state.users.map(user => [user.id, user]));
            users = ids.map(id => { const user = index.get(id); if (!user) reject('USER_NOT_FOUND', 'Account was not found.', 404); if (user.archivedAt !== undefined) reject('ACCOUNT_ARCHIVED', 'Restore archived accounts before editing permissions.', 409); return user; });
          } else {
            if (request.status === 'archived') reject('ACCOUNT_ARCHIVED', 'Restore archived accounts before editing permissions.', 409);
            users = this.#filteredUsers(request).rows;
          }
          const result = { count: users.length, userIds: users.map(user => user.id), items: users.slice(0, 50).map(user => ({ id: user.id, username: user.username, displayName: user.displayName })) };
          if (capture) {
            if (!users.length) reject('INVALID_INPUT', 'Choose accounts before editing permissions.');
            const now = this.#time();
            for (const [id, entry] of this.#batchSelections) if (entry.expiresAt <= now) this.#batchSelections.delete(id);
            const own = [...this.#batchSelections].filter(([, entry]) => entry.login === auth.tokenHash);
            if (own.length >= 8) this.#batchSelections.delete(own[0][0]);
            while (this.#batchSelections.size >= 32) this.#batchSelections.delete(this.#batchSelections.keys().next().value);
            const selectionId = secret();
            this.#batchSelections.set(selectionId, { login: auth.tokenHash, expiresAt: now + 15 * 60 * 1000, targets: users.map(user => ({ userId: user.id, expectedRevision: user.revision ?? 0 })) });
            Object.assign(result, { selectionId, source: publicUser(users[0]) });
          }
          return result;
        }
        case 'admin.batchUpdateAccess': {
          let targets = request.targets;
          if (request.selectionId !== undefined) {
            if (targets !== undefined || typeof request.selectionId !== 'string' || !TOKEN.test(request.selectionId)) reject('INVALID_INPUT', 'Use one valid selection.');
            const selection = this.#batchSelections.get(request.selectionId);
            if (!selection || selection.expiresAt <= this.#time()) reject('BATCH_SELECTION_EXPIRED', 'Selection expired. Select the accounts again.', 409);
            if (selection.login !== auth.tokenHash) reject('FORBIDDEN', 'Selection belongs to another login.', 403);
            targets = selection.targets;
          } else if (!Array.isArray(targets) || targets.length > 100) reject('INVALID_INPUT', 'Use a prepared selection for large account lists.');
          if (!targets.length) reject('INVALID_INPUT', 'Choose accounts to update.');
          if (!['modelAccess', 'routeIds', 'defaultRouteId', 'access'].some(field => Object.hasOwn(request, field))) reject('INVALID_INPUT', 'Choose permissions to apply.');
          if (request.access !== undefined) v.object(request.access, v.ACCESS_FIELDS, []);
          const seen = new Set(), userIndex = new Map(this.#state.users.map(user => [user.id, user]));
          const changes = targets.map(target => {
            v.object(target, ['userId', 'expectedRevision']);
            const userId = v.id(target.userId, 'usr'); v.integer(target.expectedRevision, 'account revision');
            if (seen.has(userId)) reject('INVALID_INPUT', 'Choose distinct accounts.');
            seen.add(userId);
            const user = userIndex.get(userId);
            if (!user) reject('USER_NOT_FOUND', 'Account was not found.', 404);
            if (target.expectedRevision !== (user.revision ?? 0)) reject('ACCOUNT_CONFLICT', 'An account changed. Reload the selected accounts before saving.', 409);
            if (user.archivedAt !== undefined) reject('ACCOUNT_ARCHIVED', 'Restore archived accounts before editing permissions.', 409);
            const fields = { id: userId, revision: (user.revision ?? 0) + 1 };
            if (['modelAccess', 'routeIds', 'defaultRouteId'].some(key => Object.hasOwn(request, key))) {
              const ids = request.routeIds === undefined ? user.routeIds : v.routeIds(request.routeIds);
              const preferred = request.defaultRouteId === undefined ? (ids.includes(user.defaultRouteId) ? user.defaultRouteId : null) : request.defaultRouteId;
              Object.assign(fields, this.#policy(ids, preferred), { modelAccess: v.modelAccess(request.modelAccess ?? (request.routeIds === undefined ? modelAccessOf(user) : 'custom')) });
            }
            if (request.access !== undefined) fields.access = accountAccess({ ...accountAccess(user.access), ...request.access });
            return fields;
          });
          const result = await this.#commit(state => {
            const index = new Map(state.users.map(user => [user.id, user]));
            for (const fields of changes) Object.assign(index.get(fields.id), fields);
            return { updatedUserIds: changes.map(user => user.id), count: changes.length };
          });
          if (request.selectionId) this.#batchSelections.delete(request.selectionId);
          return result;
        }
        case 'admin.updateUser': {
          const userId = v.id(request.userId, 'usr');
          const user = this.#state.users.find((candidate) => candidate.id === userId);
          if (!user) reject('USER_NOT_FOUND', 'Account was not found.', 404);
          v.integer(request.expectedRevision, 'account revision');
          if (request.expectedRevision !== (user.revision ?? 0)) reject('ACCOUNT_CONFLICT', 'Account changed. Reload before saving.', 409);
          if (user.archivedAt !== undefined) reject('ACCOUNT_ARCHIVED', 'Restore this archived account before editing it.', 409);
          if (!['displayName', 'role', 'disabled', 'modelAccess', 'routeIds', 'defaultRouteId', 'access'].some((field) => Object.hasOwn(request, field))) reject('INVALID_INPUT', 'No account changes were supplied.');
          const displayName = request.displayName === undefined ? user.displayName : v.text(request.displayName, 'displayName', 80);
          const role = request.role === undefined ? user.role : request.role;
          if (!['admin', 'member'].includes(role)) reject('INVALID_INPUT', 'Invalid account role.');
          const disabled = request.disabled === undefined ? user.disabled : v.bool(request.disabled, 'disabled');
          if ((disabled || role !== 'admin') && user.role === 'admin' && !this.#state.users.some((candidate) => candidate.id !== user.id && candidate.role === 'admin' && !candidate.disabled)) {
            reject('LAST_ADMIN', 'The last active administrator cannot be disabled or demoted.', 409);
          }
          const ids = request.routeIds === undefined ? user.routeIds : v.routeIds(request.routeIds);
          const defaultId = request.defaultRouteId === undefined ? (ids.includes(user.defaultRouteId) ? user.defaultRouteId : null) : request.defaultRouteId;
          const policy = { ...this.#policy(ids, defaultId), modelAccess: v.modelAccess(request.modelAccess ?? (request.routeIds === undefined ? modelAccessOf(user) : 'custom')) };
          if (request.access !== undefined) v.object(request.access, v.ACCESS_FIELDS, []);
          const access = accountAccess({ ...accountAccess(user.access), ...request.access });
          if (disabled || role !== user.role) await this.#revoke(user.id);
          const result = await this.#commit((state) => {
            const target = state.users.find((candidate) => candidate.id === user.id);
            Object.assign(target, { displayName, role, disabled, ...policy, access, revision: (target.revision ?? 0) + 1 });
            return { user: publicUser(target), roleChanged: role !== user.role };
          });
          return result;
        }
        case 'admin.resetPassword': {
          const userId = v.id(request.userId, 'usr');
          if (!this.#state.users.some((candidate) => candidate.id === userId)) reject('USER_NOT_FOUND', 'Account was not found.', 404);
          const fields = await passwordFields(request.password);
          await this.#revoke(userId);
          await this.#commit((state) => { Object.assign(state.users.find((candidate) => candidate.id === userId), fields); return null; });
          return { ok: true };
        }
        case 'admin.upsertRoute': {
          if (this.#modelCatalog !== null) reject('CATALOG_MANAGED', 'Choose a model and reasoning level from the current DSH model catalog.', 409);
          const routeId = request.routeId === undefined ? identifier('rte') : v.id(request.routeId, 'rte');
          if (request.routeId !== undefined && !this.#state.routes.some((candidate) => candidate.id === routeId)) reject('ROUTE_NOT_FOUND', 'Route was not found.', 404);
          const provider = v.key(request.provider);
          if (!this.#providers.has(provider)) reject('PROVIDER_UNAVAILABLE', 'Choose a provider registered in DSH.', 409);
          const previous = this.#state.routes.find((candidate) => candidate.id === routeId);
          const route = { id: routeId, label: v.text(request.label, 'label'), provider,
            model: v.text(request.model, 'model', 256), enabled: v.bool(request.enabled, 'enabled'),
            default: request.default === undefined ? (previous?.default ?? false) : v.bool(request.default, 'default') };
          return this.#commit((state) => {
            if (route.default) for (const candidate of state.routes) candidate.default = false;
            const index = state.routes.findIndex((candidate) => candidate.id === route.id);
            if (index < 0) state.routes.push(route); else state.routes[index] = route;
            return { route };
          });
        }
        case 'admin.publishEnvironment': {
          const contentRevision = request.contentRevision ?? null;
          if (contentRevision !== null && (typeof contentRevision !== 'string' || !/^[0-9a-f]{64}$/.test(contentRevision))) reject('INVALID_INPUT', 'Invalid shared content revision.');
          const environment = { version: this.#state.environment.version + 1, contentRevision,
            skills: v.environmentEntries(request.skills), mcp: v.environmentEntries(request.mcp), agents: v.environmentEntries(request.agents) };
          return this.#commit((state) => { state.environment = environment; return { environment }; });
        }
        case 'projects.create': {
          const route = this.#route(auth.user, request.routeId);
          const createdAt = this.#time();
          const projectId = identifier('prj');
          const project = { id: projectId, ownerId: auth.user.id,
            title: request.title === undefined ? 'Untitled project' : v.text(request.title, 'title'),
            relativePath: `${auth.user.id}/${projectId}`, rootSessionId: null, state: 'reserved', routeId: route.id,
            createdAt, updatedAt: createdAt, lastActivityAt: createdAt };
          return this.#commit((state) => { state.projects.push(project); return { project }; });
        }
        case 'routes.select': {
          const project = this.#project(auth.user, request.projectId, false);
          const route = this.#route(auth.user, request.routeId);
          const updatedAt = this.#time();
          return this.#commit(state => {
            const target = state.projects.find(candidate => candidate.id === project.id);
            Object.assign(target, { routeId: route.id, updatedAt });
            return { project: target };
          });
        }
        case 'projects.rename': {
          const project = this.#project(auth.user, request.projectId, false);
          const title = v.text(request.title, 'title');
          const updatedAt = this.#time();
          return this.#commit((state) => {
            const target = state.projects.find((candidate) => candidate.id === project.id);
            Object.assign(target, { title, updatedAt });
            return { project: target };
          });
        }
        case 'projects.activity': {
          const project = this.#project(auth.user, request.projectId);
          if (!['user-input', 'terminal-input', 'preview-input'].includes(request.event)) reject('INVALID_INPUT', 'Only effective user activity is accepted.');
          const now = this.#time();
          return this.#commit((state) => {
            const target = state.projects.find((candidate) => candidate.id === project.id);
            Object.assign(target, { updatedAt: now, lastActivityAt: now });
            return { project: target };
          });
        }
        case 'projects.open':
        case 'terminal.open':
          this.#project(auth.user, request.projectId);
          // No boolean, adapter name, client claim or host fallback can open this boundary.
          reject('ISOLATION_UNAVAILABLE', 'Project execution requires an independently reviewed isolated runtime and member transport.', 503);
        default: reject('UNKNOWN_ACTION', 'Unknown workspace action.', 404);
      }
    });
  }

  /**
   * Internal integration API only; deliberately absent from execute(). The caller
   * must possess the exact non-null runtime object injected by the trusted Host.
   * No project/title/path/provider information is added to the public board.
   */
  async recordUsage(record, source) {
    return this.#serial(async () => {
      this.#ready();
      if (this.#runtime === null || source !== this.#runtime) reject('UNTRUSTED_RUNTIME', 'Usage must be recorded by the trusted runtime.', 403);
      v.object(record, ['projectId', 'inputTokens', 'outputTokens', 'totalTokens', 'calls'], ['projectId']);
      const projectId = v.id(record.projectId, 'prj');
      const project = this.#state.projects.find((candidate) => candidate.id === projectId);
      if (!project) reject('PROJECT_NOT_FOUND', 'Project was not found.', 404);
      const calls = record.calls === undefined ? 1 : v.integer(record.calls, 'calls', 1);
      const fields = ['inputTokens', 'outputTokens', 'totalTokens'];
      for (const field of fields) if (Object.hasOwn(record, field)) v.integer(record[field], field);
      const complete = fields.every((field) => Object.hasOwn(record, field));
      if (complete) {
        const sum = record.inputTokens + record.outputTokens;
        if (!Number.isSafeInteger(sum) || record.totalTokens < sum) reject('INVALID_INPUT', 'Total tokens must safely cover input and output tokens.');
      }
      return this.#commit((state) => {
        let aggregate = state.usage.find((entry) => entry.userId === project.ownerId);
        if (!aggregate) { aggregate = { userId: project.ownerId, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0 }; state.usage.push(aggregate); }
        aggregate.calls += calls;
        if (complete) for (const field of fields) aggregate[field] += record[field];
        else aggregate.unknownCalls += calls;
        return { ok: true };
      });
    });
  }
}
