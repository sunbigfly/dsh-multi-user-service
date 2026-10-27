import { reject } from './errors.js';
import { posix, win32 } from 'node:path';

export const ID = /^(usr|prj|rte|inv)_[0-9a-f]{32}$/;
export const KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const SALT = /^[0-9a-f]{32}$/;
export const PASSWORD_HASH = /^[0-9a-f]{128}$/;

export function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    reject('INVALID_INPUT', 'Expected a plain JSON object.');
  }
  const names = Object.keys(value);
  if (Object.getOwnPropertySymbols(value).length || names.some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    reject('INVALID_INPUT', 'Unknown or missing field.');
  }
  return value;
}

export function text(value, name, maximum = 160, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    reject('INVALID_INPUT', `Invalid ${name}.`);
  }
  return value;
}

export function bool(value, name) {
  if (typeof value !== 'boolean') reject('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}

export function modelAccess(value) {
  if (!['inherit', 'custom'].includes(value)) reject('INVALID_INPUT', 'Invalid model access mode.');
  return value;
}

export const ACCESS_FLAGS = Object.freeze(['terminal', 'files', 'attachments', 'tasks', 'subagents', 'interactions']);
export const ACCESS_LISTS = Object.freeze(['tools', 'skills', 'agentPresets', 'permissionPresets', 'plugins', 'mcpServers']);
export const ACCESS_FIELDS = Object.freeze([...ACCESS_FLAGS, ...ACCESS_LISTS, 'sharedDirectories']);

export function sharedDirectories(value = []) {
  const seen = new Set();
  return list(value, 32).map(row => {
    object(row, ['path', 'mode']);
    const path = text(row.path, 'shared directory', 4096);
    const windows = process.platform === 'win32' && /^[A-Za-z]:\//.test(path);
    if (!(windows || posix.isAbsolute(path)) || (windows ? win32.resolve(path).replaceAll('\\', '/') : posix.resolve(path)) !== path || path.includes('\\') || path === '/' || /^[A-Za-z]:\/$/.test(path) || seen.has(path) || /(?:^|\/)usr_[0-9a-f]{32}(?:\/|$)/.test(path)) reject('INVALID_INPUT', 'Shared directories require distinct canonical absolute paths outside member homes.');
    if (!['read-only', 'read-write'].includes(row.mode)) reject('INVALID_INPUT', 'Invalid shared directory mode.');
    seen.add(path);
    return { path, mode: row.mode };
  }).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
}

/** Missing/null lists inherit the Host; an explicit empty list disables that
 * resource family. Flags default to enabled for existing installations. */
export function accountAccess(value = {}) {
  object(value, ACCESS_FIELDS, []);
  const result = {};
  for (const key of ACCESS_FLAGS) result[key] = value[key] === undefined ? true : bool(value[key], key);
  for (const key of ACCESS_LISTS) {
    const list = value[key];
    if (list === undefined || list === null) result[key] = null;
    else {
      if (!Array.isArray(list) || list.length > 512 || list.some(id => typeof id !== 'string' || !id.length || id.length > 256 || /[\s\x00-\x1f\x7f]/.test(id)) || new Set(list).size !== list.length) reject('INVALID_INPUT', `Invalid ${key} access list.`);
      result[key] = [...list].sort();
    }
  }
  result.sharedDirectories = sharedDirectories(value.sharedDirectories);
  return result;
}

export const PREFERENCE_FIELDS = Object.freeze([...ACCESS_FLAGS, ...ACCESS_LISTS]);
export function personalAccess(value = {}) {
  object(value, PREFERENCE_FIELDS, []);
  const normalized = accountAccess(value);
  return Object.fromEntries(PREFERENCE_FIELDS.map(key => [key, normalized[key]]));
}

/** Personal choices can only reduce the administrator's current grants. */
export function effectiveAccess(user) {
  const granted = accountAccess(user.access), selected = personalAccess(user.preferences);
  for (const key of ACCESS_FLAGS) granted[key] &&= selected[key];
  for (const key of ACCESS_LISTS) {
    if (selected[key] !== null) granted[key] = granted[key] === null ? [...selected[key]] : granted[key].filter(id => selected[key].includes(id));
  }
  return granted;
}

export function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) reject('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}

export function id(value, prefix) {
  if (typeof value !== 'string' || !ID.test(value) || (prefix && !value.startsWith(`${prefix}_`))) {
    reject('INVALID_INPUT', 'Invalid identifier.');
  }
  return value;
}

export function key(value) {
  if (typeof value !== 'string' || !KEY.test(value) || value.includes('://') || value.includes('..')) {
    reject('INVALID_INPUT', 'Invalid controlled identifier.');
  }
  return value;
}

export function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) {
    reject('INVALID_INPUT', 'Username must contain 3–64 letters, digits, dots, underscores or hyphens.');
  }
  return value.toLowerCase();
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) {
    reject('INVALID_INPUT', 'Password must contain 12–1024 characters.');
  }
  return value;
}

export function list(value, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) {
    reject('INVALID_INPUT', 'Invalid bounded list.');
  }
  return value;
}

export function routeIds(value) {
  const result = list(value).map((value) => id(value, 'rte'));
  if (new Set(result).size !== result.length) reject('INVALID_INPUT', 'Duplicate route identifier.');
  return result;
}

export function environmentEntries(value) {
  const result = list(value).map((entry) => {
    if (typeof entry === 'string') return { id: key(entry), label: key(entry) };
    object(entry, ['id', 'label']);
    return { id: key(entry.id), label: text(entry.label, 'label', 160) };
  });
  if (new Set(result.map((entry) => entry.id)).size !== result.length) {
    reject('INVALID_INPUT', 'Duplicate environment identifier.');
  }
  return result;
}

function match(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) reject('INVALID_INPUT', 'Invalid stored credential.');
}

function unique(values) {
  if (new Set(values).size !== values.length) reject('INVALID_INPUT', 'Duplicate stored identifier.');
}

export function modelCatalog(value) {
  const result = list(value, 1024).map(entry => {
    object(entry, ['id', 'label', 'provider', 'providerName', 'model', 'modelName', 'reasoningEffort', 'effortName']);
    id(entry.id, 'rte'); text(entry.label, 'label'); key(entry.provider); text(entry.providerName, 'provider name');
    text(entry.model, 'model', 256); text(entry.modelName, 'model name');
    if (entry.reasoningEffort !== null) key(entry.reasoningEffort);
    if (entry.effortName !== null) text(entry.effortName, 'effort name');
    if ((entry.reasoningEffort === null) !== (entry.effortName === null)) reject('INVALID_INPUT', 'Reasoning effort metadata is inconsistent.');
    return { ...entry };
  });
  unique(result.map(entry => entry.id));
  unique(result.map(entry => JSON.stringify([entry.provider, entry.model, entry.reasoningEffort])));
  return result;
}

/** Validate the *entire* versioned document, including references, before publishing it. */
export function validateState(state) {
  const fields = ['version', 'users', 'invites', 'routes', 'environment', 'projects', 'usage'];
  object(state, [...fields, 'retiredUsers'], fields);
  if (state.version !== 1) reject('INVALID_INPUT', 'Unsupported state version.');
  for (const route of list(state.routes, 1024)) {
    object(route, ['id', 'label', 'provider', 'model', 'enabled', 'default', 'reasoningEffort', 'effortName', 'providerName', 'modelName'], ['id', 'label', 'provider', 'model', 'enabled', 'default']);
    if (route.reasoningEffort !== undefined && route.reasoningEffort !== null) key(route.reasoningEffort);
    for (const name of ['effortName', 'providerName', 'modelName']) if (route[name] !== undefined && route[name] !== null) text(route[name], name);
    id(route.id, 'rte'); text(route.label, 'label'); key(route.provider);
    text(route.model, 'model', 256); bool(route.enabled, 'enabled'); bool(route.default, 'default');
  }
  unique(state.routes.map((route) => route.id));
  if (state.routes.filter((route) => route.default).length > 1) reject('INVALID_INPUT', 'Multiple default routes.');
  const routes = new Set(state.routes.map((route) => route.id));
  const policy = (value) => {
    if (value.modelAccess !== undefined) modelAccess(value.modelAccess);
    if (value.access !== undefined) accountAccess(value.access);
    routeIds(value.routeIds);
    if (value.routeIds.some((routeId) => !routes.has(routeId))) reject('INVALID_INPUT', 'Unknown stored route.');
    if (value.defaultRouteId !== null && !value.routeIds.includes(id(value.defaultRouteId, 'rte'))) {
      reject('INVALID_INPUT', 'Invalid stored default route.');
    }
  };
  for (const user of list(state.users, 4096)) {
    const fields = ['id', 'username', 'displayName', 'role', 'disabled', 'routeIds', 'defaultRouteId', 'passwordSalt', 'passwordHash'];
    object(user, [...fields, 'modelAccess', 'access', 'preferences', 'preferencesRevision', 'revision', 'archivedAt', 'archiveDisabled'], fields);
    id(user.id, 'usr');
    if (username(user.username) !== user.username) reject('INVALID_INPUT', 'Stored username is not canonical.');
    text(user.displayName, 'displayName', 80);
    if (!['admin', 'member'].includes(user.role)) reject('INVALID_INPUT', 'Invalid stored role.');
    bool(user.disabled, 'disabled'); policy(user);
    if (user.preferences !== undefined) personalAccess(user.preferences);
    if (user.preferencesRevision !== undefined) integer(user.preferencesRevision, 'preferences revision');
    if (user.revision !== undefined) integer(user.revision, 'account revision');
    if (user.archivedAt !== undefined) { integer(user.archivedAt, 'archive time'); bool(user.archiveDisabled, 'previous disabled state'); if (!user.disabled) reject('INVALID_INPUT', 'Archived accounts cannot sign in.'); }
    else if (user.archiveDisabled !== undefined) reject('INVALID_INPUT', 'Invalid account archive state.');
    match(user.passwordSalt, SALT); match(user.passwordHash, PASSWORD_HASH);
  }
  unique(state.users.map((user) => user.id)); unique(state.users.map((user) => user.username));
  if (state.users.length && !state.users.some((user) => user.role === 'admin' && !user.disabled)) {
    reject('INVALID_INPUT', 'Stored state has no active administrator.');
  }
  const retained = list(state.retiredUsers ?? [], 4096);
  for (const user of retained) {
    object(user, ['id', 'username', 'displayName', 'role', 'disabled', 'archivedAt', 'deletedAt']);
    id(user.id, 'usr'); if (username(user.username) !== user.username) reject('INVALID_INPUT', 'Invalid retained username.');
    text(user.displayName, 'displayName', 80); if (!['admin', 'member'].includes(user.role) || user.disabled !== true) reject('INVALID_INPUT', 'Invalid retained account.');
    integer(user.archivedAt, 'archive time'); integer(user.deletedAt, 'deletion time'); if (user.deletedAt < user.archivedAt) reject('INVALID_INPUT', 'Invalid account deletion time.');
  }
  const identities = [...state.users, ...retained].map(user => user.id); unique(identities);
  const users = new Set(identities);
  for (const invite of list(state.invites, 4096)) {
    const fields = ['id', 'tokenHash', 'displayName', 'routeIds', 'defaultRouteId', 'createdAt', 'expiresAt'];
    object(invite, [...fields, 'modelAccess', 'access', 'usedAt', 'usedBy', 'revokedAt', 'revision'], fields);
    id(invite.id, 'inv'); match(invite.tokenHash, HASH);
    if (invite.displayName !== null) text(invite.displayName, 'displayName', 80);
    policy(invite); integer(invite.createdAt, 'createdAt'); integer(invite.expiresAt, 'expiresAt');
    if (invite.expiresAt <= invite.createdAt) reject('INVALID_INPUT', 'Invalid invite expiry.');
    if (invite.revision !== undefined) integer(invite.revision, 'invite revision');
    if (invite.usedAt !== undefined) { integer(invite.usedAt, 'invite use time'); id(invite.usedBy, 'usr'); if (!users.has(invite.usedBy)) reject('INVALID_INPUT', 'Unknown invitation member.'); }
    else if (invite.usedBy !== undefined) reject('INVALID_INPUT', 'Invalid invitation member.');
    if (invite.revokedAt !== undefined) integer(invite.revokedAt, 'invite revocation time');
  }
  unique(state.invites.map((invite) => invite.id)); unique(state.invites.map((invite) => invite.tokenHash));
  object(state.environment, ['version', 'skills', 'mcp', 'agents', 'contentRevision'], ['version', 'skills', 'mcp', 'agents']);
  if (state.environment.contentRevision !== undefined && state.environment.contentRevision !== null &&
      (typeof state.environment.contentRevision !== 'string' || !/^[0-9a-f]{64}$/.test(state.environment.contentRevision))) reject('INVALID_INPUT', 'Invalid shared content revision.');
  integer(state.environment.version, 'environment version');
  for (const section of ['skills', 'mcp', 'agents']) {
    for (const entry of list(state.environment[section])) object(entry, ['id', 'label']);
    environmentEntries(state.environment[section]);
  }
  for (const project of list(state.projects, 16384)) {
    object(project, ['id', 'ownerId', 'title', 'relativePath', 'rootSessionId', 'state', 'routeId', 'createdAt', 'updatedAt', 'lastActivityAt']);
    id(project.id, 'prj'); id(project.ownerId, 'usr'); id(project.routeId, 'rte'); text(project.title, 'title', 160);
    if (!users.has(project.ownerId) || !routes.has(project.routeId) ||
        project.relativePath !== `${project.ownerId}/${project.id}` || project.rootSessionId !== null || project.state !== 'reserved') {
      reject('INVALID_INPUT', 'Invalid project reservation.');
    }
    integer(project.createdAt, 'createdAt'); integer(project.updatedAt, 'updatedAt'); integer(project.lastActivityAt, 'lastActivityAt');
    if (project.updatedAt < project.createdAt || project.lastActivityAt < project.createdAt) reject('INVALID_INPUT', 'Invalid project time.');
  }
  unique(state.projects.map((project) => project.id));
  for (const usage of list(state.usage, 4096)) {
    object(usage, ['userId', 'calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls']);
    id(usage.userId, 'usr');
    if (!users.has(usage.userId)) reject('INVALID_INPUT', 'Unknown usage owner.');
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls']) integer(usage[field], field);
    const sum = usage.inputTokens + usage.outputTokens;
    if (usage.unknownCalls > usage.calls || !Number.isSafeInteger(sum) || usage.totalTokens < sum ||
        (usage.calls === usage.unknownCalls && (usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.totalTokens !== 0))) {
      reject('INVALID_INPUT', 'Invalid usage aggregate.');
    }
  }
  unique(state.usage.map((usage) => usage.userId));
  if (!state.users.length && (retained.length || state.invites.length || state.projects.length || state.usage.length || state.routes.length || state.environment.version !== 0 ||
      state.environment.skills.length || state.environment.mcp.length || state.environment.agents.length)) {
    reject('INVALID_INPUT', 'Uninitialized state contains privileged data.');
  }
  return state;
}
