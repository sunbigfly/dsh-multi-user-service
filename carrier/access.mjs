/**
 * Member ownership and access policy.
 *
 * A member Peer is a first-class non-owner principal: the stock gateway asks
 * `ctx.remoteAccess` before it dispatches any RPC for it. Nothing is granted by
 * default, so this module keeps the durable map that makes grants possible —
 * which session and which project directory belong to which user — plus the one
 * function that forces a member `session/create` into the member's own home.
 */
import { posix } from 'node:path';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Diagnostic trail for refused member calls. Members are denied by design for
// many endpoints; this records what the Gateway resolved so a wrong refusal can
// be told apart from a deliberate one.
const TRACE = join(tmpdir(), 'lan-access-trace.log');
const trace = request => {
  try {
    appendFileSync(TRACE, `${JSON.stringify({ at: new Date().toISOString(), action: request?.action, resources: request?.resources, args: request?.args === undefined ? null : Object.keys(request.args) })}\n`);
  } catch { /* Diagnostics never change a decision. */ }
};

const USER_ID = /^usr_[0-9a-f]{32}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Directory segment used when a member create names no project. */
export const MEMBER_DEFAULT_PROJECT = 'workspace';

/**
 * Normalize one path for member confinement.
 *
 * The Host writes the member home with `posix.join` even on Windows, so the same
 * value can arrive as `C:\Users\x/.local/share/…`. Forward slashes are the
 * common form Node accepts on every platform, and a drive letter counts as an
 * absolute root exactly like `/` does on POSIX.
 * @param value - any candidate path.
 * @returns the normalized path, or `null` when it is not absolute.
 */
export function memberPath(value) {
  if (typeof value !== 'string' || value === '') return null;
  const slashed = value.replaceAll('\\', '/');
  const absolute = slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed);
  if (!absolute) return null;
  const normalized = posix.normalize(slashed);
  if (normalized === '/' || /^[A-Za-z]:\/?$/.test(normalized)) return null;
  return normalized;
}

/**
 * RPC actions a member may perform on its own session. Only resources the
 * durable map attributes to the principal are ever bound, so this list can
 * never widen the set of reachable sessions.
 */
export const MEMBER_SESSION_ACTIONS = Object.freeze([
  // `session/list` and `session/search` are checked per result item through
  // `allows(resource)`, so the action must sit on the session binding too — the
  // global grant alone filters every Session out and the sidebar stays empty.
  'session/list', 'session/search',
  // The member page adopts an existing Session into the chosen Workspace by
  // repeating `session/create` with that `sessionId`; without this action on the
  // Session resource the Host refuses the adoption.
  'session/create',
  'session/attachment', 'session/cancel', 'session/control', 'session/follow',
  'session/fork', 'session/modelCatalog', 'session/page', 'session/projections',
  'session/prompt', 'session/rename', 'session/selectModel', 'session/updateQueue',
  // The native client updates running/activity state from forwarded events.
  // Gateway checks these separately from RPCs, against the same owned Session.
  'event:api-session/status', 'event:api-session/activity',
  'event:api-session/added', 'event:api-session/removed', 'event:api-session/error',
  'agentPresets/select',
  'commands/list', 'commands/execute',
  'skills/list',
  'job/list', 'job/follow', 'job/kill',
  'dynamicCordisRunner/resolveInspectQuery',
  'userQuestions/answer', 'userQuestions/attachWait',
  // Terminal and file panels are addressed by the member's own Agent, so the
  // Carrier checks file previews against the owned cwd; native Bash and terminal
  // providers additionally receive the member's private filesystem view.
  'terminal/attach', 'terminal/close', 'terminal/create', 'terminal/environment',
  'terminal/list', 'terminal/rename', 'terminal/retain', 'terminal/shells',
  'workspaceFiles/changes', 'workspaceFiles/list', 'workspaceFiles/read',
  'workspaceFiles/readBytes', 'workspaceFiles/stat',
  // Session bookkeeping a member performs on its own Session from the sidebar.
  'workspace/archiveSession', 'workspace/unarchiveSession',
  'workspace/pinSession', 'workspace/unpinSession',
  'workspace/insertSessionBefore', 'workspace/insertBefore', 'workspace/renameSession',
]);

/**
 * Resource-free actions. `session/create` carries no session or workspace id
 * yet — that is exactly why creating one is the only way a member ever gains a
 * resource — so it is granted globally and nothing else is. Both read actions
 * include only the Sessions `remoteAccess.allows()` admits, so the host's own
 * Sessions stay invisible even though the request itself names no resource.
 */
export const MEMBER_GLOBAL_ACTIONS = Object.freeze([
  'dynamicCordisRunner/syncInspectManifest', 'dynamicCordisRunner/inventory',
  'session/create', 'session/list', 'session/search',
  // The live-control stream names no Session in its call, so the Gateway decides
  // it on `global`; the Host itself filters the frames to the Sessions this
  // principal may read (`allows()`), which is why the grant stays global.
  'session/control',
  // The member page asks these before it renders the workspace picker and the
  // folder browser. The Host never sees them: the carrier answers them from the
  // member's own project directories.
  'workspace/follow', 'workspace/create', 'workspace/rename',
  'directoryPicker/list', 'directoryPicker/pick', 'directoryPicker/createDirectory',
]);

/** Tools that touch files or run code: they run only under the Host's file
 * sandbox. `run_code` is the batching transport whose inner calls meet the same
 * guard. */
const MEMBER_FILE_TOOLS = Object.freeze(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'run_code', 'working_directory']);

/** Native DSH modes eligible for account-authorized tools. */
const MEMBER_SANDBOX_MODES = new Set(['workspace-write', 'read-only', 'danger-full-access']);

/**
 * The synchronous part of account tool authorization. Calls retain the native
 * DSH policy selected for the Session and may only request administrator-granted
 * modes. Managed file paths are checked separately; script effects follow DSH.
 * @param exec - the tool execution (`name`, `arguments`).
 * @param allowed - tool names this Session kept.
 * @param mode - the Session's effective sandbox mode, if a policy is mounted.
 * @returns a denial reason, or `undefined` to let the call proceed.
 */
export function memberToolDenial(exec, { allowed, mode, allowedModes = [mode] }) {
  if (allowed !== null && !allowed.has(exec?.name)) return MEMBER_TOOL_DENIAL;
  if (!MEMBER_FILE_TOOLS.includes(exec.name)) return undefined;
  if (!MEMBER_SANDBOX_MODES.has(mode)) return 'Member file tools require a recognized native DSH sandbox policy.';
  const requested = exec.arguments?.sandbox_permissions;
  if (requested !== undefined && !allowedModes.includes(requested)) return 'Members cannot leave their authorized sandbox modes.';
  return undefined;
}

/**
 * Lexical containment of a file tool's path arguments in the Session
 * directory. Relative paths resolve against that directory; a glob pattern is
 * only checked when it is absolute.
 * @param args - the tool arguments.
 * @param cwd - the Session's working directory.
 * @returns the absolute paths named by the call, or `null` when one leaves `cwd`.
 */
export function memberToolPaths(args, cwd, roots = [cwd]) {
  const root = memberPath(cwd);
  if (root === null) return null;
  const paths = [];
  for (const field of ['file_path', 'path', 'pattern', 'cd', 'workdir', 'cwd']) {
    const value = args?.[field];
    if (typeof value !== 'string' || value === '') continue;
    const absolute = memberPath(value);
    if (field === 'pattern' && absolute === null) continue;
    const target = absolute ?? posix.normalize(posix.join(root, value.replaceAll('\\', '/')));
    if (!roots.some(allowed => target === allowed || target.startsWith(allowed + '/'))) return null;
    paths.push(target);
  }
  return paths;
}

/**
 * Asynchronous containment check: every named path, or its nearest existing
 * ancestor, must resolve inside the real Session directory, so a link the
 * member made inside the workspace cannot reach a Host file.
 * @returns a denial reason, or `undefined`.
 */
export async function memberPathDenial(exec, cwd, { realpath, sharedDirectories = [] }) {
  if (!['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'working_directory', 'bash', 'pwsh', 'subagent', 'subagent_fork'].includes(exec?.name)) return undefined;
  const shared = ['bash', 'pwsh', 'working_directory', 'subagent', 'subagent_fork'].includes(exec.name) ? [] : sharedDirectories;
  const ranges = [{ path: cwd, mode: 'read-write' }, ...shared].sort((a, b) => b.path.length - a.path.length);
  const paths = memberToolPaths(exec.arguments, cwd, ranges.map(row => row.path));
  const denied = 'Member file tools are limited to this conversation\'s workspace.';
  if (paths === null) return denied;
  let root;
  try { root = memberPath(await realpath(cwd)); } catch { return denied; }
  for (const path of paths) {
    const range = ranges.find(row => path === row.path || path.startsWith(row.path + '/'));
    if (!range || ['write', 'edit'].includes(exec.name) && range.mode !== 'read-write') return denied;
    let probe = path, real;
    for (;;) {
      try { real = memberPath(await realpath(probe)); break; } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return denied;
        const parent = posix.dirname(probe);
        if (parent === probe) return denied;
        probe = parent;
      }
    }
    const resolvedRoot = range.path === cwd ? root : range.path;
    if (real === null || (real !== resolvedRoot && !real.startsWith(`${resolvedRoot}/`))) return denied;
    const realRange = ranges.find(row => real === row.path || real.startsWith(row.path + '/'));
    if (['write', 'edit'].includes(exec.name) && realRange?.mode !== 'read-write') return denied;
  }
  return undefined;
}

/** Settings fields that decide where a stored model credential is sent. */
const ROUTING_FIELD = /^(?:baseurl|apikey|apikeyenv|headers|endpoint|url|proxy|credentials?|token|secret)$/i;

/**
 * Whether a member `settings/update` or `settings/mutate` leaves every
 * credential-routing field (endpoint, headers, credential reference) exactly as
 * the Host has it. Model lists, overrides and interface preferences may change.
 * @param endpoint - `settings/update` or `settings/mutate`.
 * @param args - the RPC arguments (`{ns, patch}` or `{ns, ops}`).
 * @param current - the namespace's current effective value.
 */
export function memberSettingsChangeAllowed({ endpoint, args, current }) {
  const at = path => path.reduce((node, key) => node !== null && typeof node === 'object' ? node[key] : undefined, current);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const unchanged = (value, path) => {
    if (value === null || typeof value !== 'object') return true;
    for (const [key, child] of Object.entries(value)) {
      const next = [...path, key];
      if (ROUTING_FIELD.test(key) ? !same(child, at(next)) : !unchanged(child, next)) return false;
    }
    return true;
  };
  if (endpoint === 'settings/update') return unchanged(args?.patch, []);
  if (endpoint !== 'settings/mutate' || !Array.isArray(args?.ops)) return false;
  return args.ops.every(op => {
    const path = Array.isArray(op?.path) && op.path.every(key => typeof key === 'string' || Number.isInteger(key)) ? op.path.map(String) : null;
    if (path === null) return false;
    const routed = path.some(key => ROUTING_FIELD.test(key));
    if (op.op !== 'set') return !routed;
    return routed ? same(op.value, at(path)) : unchanged(op.value, path);
  });
}

/** Denial the guard returns for every other tool in a member session. */
export const MEMBER_TOOL_DENIAL = 'Member sessions cannot execute tools.';

/**
 * Intersect inherited Host tools with the administrator's optional allowlist.
 * Unknown names would make `tools.restrict()` throw, so they are dropped.
 * @param schemas - the array returned by `ctx.tools.schemas(scopeParentOf(agent))`.
 * @returns the allowed tool names present on this host.
 */
export function memberToolAllow(schemas, grants = null) {
  const known = new Set();
  for (const schema of Array.isArray(schemas) ? schemas : []) if (typeof schema?.name === 'string') known.add(schema.name);
  // `run_code` is the reserved PTC transport `tools.restrict()` refuses to name.
  return [...known].filter(name => name !== 'run_code' && (grants === null || grants.includes(name)));
}

/**
 * Map one requested member cwd onto the member's own home.
 *
 * The target is always `<member root>/<project>`; a request outside the member
 * root is refused rather than silently relocated, and a missing request lands
 * in the default project. This is the single place member creates are pinned.
 * @param memberRoot - the member's private home, e.g. `/srv/members/usr_…`.
 * @param requested - the `cwd` the member asked for, if any.
 * @returns `{cwd, projectId}` or `null` when the request must be denied.
 */
export function memberSessionCwd({ memberRoot, requested }) {
  const root = memberPath(memberRoot);
  if (root === null || root.endsWith('/..')) return null;
  if (requested === undefined || requested === null || requested === '') return { cwd: posix.join(root, MEMBER_DEFAULT_PROJECT), projectId: MEMBER_DEFAULT_PROJECT };
  const candidate = memberPath(requested);
  if (candidate === null) return null;
  const relative = posix.relative(root, candidate);
  if (relative.startsWith('/') || relative === '..' || relative.startsWith('../')) return null;
  if (relative === '') return { cwd: posix.join(root, MEMBER_DEFAULT_PROJECT), projectId: MEMBER_DEFAULT_PROJECT };
  const projectId = relative.split('/')[0];
  if (!PROJECT_SEGMENT.test(projectId) || projectId === '.' || projectId === '..') return null;
  return { cwd: posix.join(root, projectId), projectId };
}

/**
 * The `lan-member` access policy. Bindings are derived from the durable
 * ownership map only: a principal sees exactly the sessions recorded for its own
 * user id, and no policy state ever names another user's resource.
 * @param ownership - a started {@link MemberOwnership}.
 */
export function memberAccessPolicy(ownership, allows = () => true, previewBindings = () => []) {
  return {
    bindings(principal) {
      if (principal?.kind !== 'lan-member' || typeof principal.userId !== 'string') return [];
      const allowed = action => { try { return allows(principal.userId, action); } catch { return false; } };
      const bindings = [{
        role: { name: 'member-create', resource: { kind: 'global' }, actions: MEMBER_GLOBAL_ACTIONS.filter(allowed) },
        resource: { kind: 'global' },
      }];
      // Native subagent control has no gateway resource annotation. Bind only
      // these two calls, conditioned on BOTH durable addresses belonging to the
      // caller; the native service still verifies the exact parent relation.
      bindings.push({
        role: { name: 'member-subagent-control', resource: { kind: 'global' }, actions: ['subagents/prompt', 'subagents/interruptByParent'].filter(allowed) },
        resource: { kind: 'global' },
        condition({ action, args }) {
          const address = action === 'subagents/prompt' ? args?.request : args;
          return address?.mode === 'continuable'
            && ownership.ownerOf(address.parentSessionId) === principal.userId
            && ownership.ownerOf(address.childSessionId) === principal.userId
            ? { kind: 'allow' } : { kind: 'deny', reason: 'member-resource-not-owned' };
        },
      });
      // The native session catalog asks for bindings once per result. All of
      // this member's sessions share the same action policy; recomputing it for
      // every session makes catalog filtering quadratic in policy evaluations.
      // Keep this local to one call so revocations take effect on the next check.
      const sessionActions = MEMBER_SESSION_ACTIONS.filter(allowed);
      for (const id of ownership.sessionIdsOf(principal.userId)) {
        bindings.push({
          role: { name: 'member-session', resource: { kind: 'session' }, actions: sessionActions },
          resource: { kind: 'session', id },
        });
      }
      bindings.push(...previewBindings(principal));
      return bindings;
    },
    explain(request) { trace(request); return 'member-resource-not-owned'; },
  };
}

const clone = value => structuredClone(value);
const emptyState = () => ({ sessions: {}, projects: {} });

/**
 * Durable `session → user` and `cwd → user` map. Reads are synchronous against
 * the loaded snapshot (the access policy must answer without awaiting), writes
 * update that snapshot immediately and persist serially.
 */
export class MemberOwnership {
  #store;
  #state = emptyState();
  #queue = Promise.resolve();

  constructor({ store }) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new TypeError('Member ownership requires a store');
    this.#store = store;
  }

  async start() {
    const saved = await this.#store.load();
    this.#state = this.#normalize(saved);
    return this;
  }

  #normalize(saved) {
    const state = emptyState();
    for (const [sessionId, entry] of Object.entries(saved?.sessions ?? {})) {
      if (!SESSION_ID.test(sessionId) || !USER_ID.test(entry?.userId ?? '')) continue;
      state.sessions[sessionId] = {
        userId: entry.userId,
        projectId: PROJECT_SEGMENT.test(entry?.projectId ?? '') ? entry.projectId : MEMBER_DEFAULT_PROJECT,
        cwd: memberPath(entry?.cwd),
        at: Number.isFinite(entry?.at) ? entry.at : 0,
      };
    }
    for (const [key, entry] of Object.entries(saved?.projects ?? {})) {
      if (!USER_ID.test(entry?.userId ?? '') || typeof entry?.projectId !== 'string') continue;
      const cwd = memberPath(entry?.cwd);
      if (cwd === null) continue;
      state.projects[key] = { userId: entry.userId, projectId: entry.projectId, cwd, at: Number.isFinite(entry?.at) ? entry.at : 0 };
    }
    return state;
  }

  /** Session ids owned by one user. */
  sessionIdsOf(userId) {
    if (typeof userId !== 'string') return [];
    return Object.keys(this.#state.sessions).filter(id => this.#state.sessions[id].userId === userId);
  }

  /** Recorded sessions of one user, with the project each one belongs to. */
  entriesOf(userId) {
    if (typeof userId !== 'string') return [];
    return Object.entries(this.#state.sessions)
      .filter(([, entry]) => entry.userId === userId)
      .map(([sessionId, entry]) => ({ sessionId, projectId: entry.projectId, cwd: entry.cwd }));
  }

  privateRoots() {
    return [...new Set([...Object.values(this.#state.sessions), ...Object.values(this.#state.projects)].flatMap(entry => {
      if (!entry.cwd) return [];
      const segment = '/' + entry.userId, at = entry.cwd.indexOf(segment + '/');
      return [at < 0 ? entry.cwd : entry.cwd.slice(0, at + segment.length)];
    }))];
  }

  /** Recorded project cwds of one user. */
  cwdsOf(userId) {
    if (typeof userId !== 'string') return [];
    return [...new Set(Object.values(this.#state.projects).filter(entry => entry.userId === userId).map(entry => entry.cwd))];
  }

  /** Owner of one session id, if any. */
  ownerOf(sessionId) {
    return typeof sessionId === 'string' ? this.#state.sessions[sessionId]?.userId : undefined;
  }

  /**
   * True when `cwd` is a directory this host forced on some member create.
   * Agents created for those sessions must not see host tools.
   */
  isMemberCwd(cwd) {
    return this.bindingForCwd(cwd) !== undefined;
  }

  bindingForCwd(cwd) {
    const candidate = memberPath(cwd);
    if (candidate === null) return undefined;
    let match;
    for (const entry of [...Object.values(this.#state.sessions), ...Object.values(this.#state.projects)]) {
      if (entry.cwd === null) continue;
      if ((candidate === entry.cwd || candidate.startsWith(entry.cwd.endsWith('/') ? entry.cwd : `${entry.cwd}/`)) && (!match || entry.cwd.length > match.cwd.length)) match = entry;
    }
    return match ? { userId: match.userId, projectId: match.projectId, cwd: match.cwd } : undefined;
  }

  /**
   * Claim a project directory before its session exists. A create in flight
   * already forces this cwd, so the Agent the gateway builds for it must be
   * locked down even though the response — and the session id — is not back yet.
   * @param entry - `{userId, projectId, cwd}`.
   */
  reserve({ userId, projectId, cwd }) {
    if (!USER_ID.test(userId ?? '')) return;
    const directory = memberPath(cwd);
    if (directory === null) return;
    const project = PROJECT_SEGMENT.test(projectId ?? '') ? projectId : MEMBER_DEFAULT_PROJECT;
    const key = `${userId}/${project}`, at = Date.now();
    const existing = this.#state.projects[key];
    if (existing?.cwd === directory) return;
    this.#state.projects[key] = { userId, projectId: project, cwd: directory, at };
    const snapshot = clone(this.#state);
    this.#queue = this.#queue.then(() => this.#store.save(snapshot), () => this.#store.save(snapshot));
  }

  /**
   * Record a successful member create. The in-memory map updates before the
   * returned promise settles so a following `agent/created` already sees it.
   * @param entry - `{userId, sessionId, projectId, cwd}`.
   */
  record({ userId, sessionId, projectId, cwd }) {
    if (!USER_ID.test(userId ?? '')) return Promise.reject(new TypeError('Member ownership requires a user id'));
    if (!SESSION_ID.test(sessionId ?? '')) return Promise.reject(new TypeError('Member ownership requires a session id'));
    const project = PROJECT_SEGMENT.test(projectId ?? '') ? projectId : MEMBER_DEFAULT_PROJECT;
    const directory = memberPath(cwd);
    const at = Date.now();
    this.#state.sessions[sessionId] = { userId, projectId: project, cwd: directory, at };
    if (directory !== null) this.#state.projects[`${userId}/${project}`] = { userId, projectId: project, cwd: directory, at };
    const snapshot = clone(this.#state);
    this.#queue = this.#queue.then(() => this.#store.save(snapshot), () => this.#store.save(snapshot));
    return this.#queue;
  }

  /** Drop every recorded resource of one user (account removal). */
  forget(userId) {
    if (!USER_ID.test(userId ?? '')) return Promise.resolve();
    for (const [id, entry] of Object.entries(this.#state.sessions)) if (entry.userId === userId) delete this.#state.sessions[id];
    for (const [key, entry] of Object.entries(this.#state.projects)) if (entry.userId === userId) delete this.#state.projects[key];
    const snapshot = clone(this.#state);
    this.#queue = this.#queue.then(() => this.#store.save(snapshot), () => this.#store.save(snapshot));
    return this.#queue;
  }

  async close() {
    try { await this.#queue; } catch { /* a failed write is already reported by the caller */ }
  }
}
