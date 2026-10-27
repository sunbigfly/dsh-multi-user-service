/**
 * Public-API-only proof that a non-owner "member" Peer on the SAME running Host
 * is served by the REAL installed services, and that the ONLY authorization
 * this fixture adds is `ctx.remoteAccess.registerPolicy(kind, policy)`.
 *
 * Deliberately absent: kernel loader, partition/namespace shims, subagent or
 * session fabrication, patched packages, replacement HTTP server, ports, and a
 * handcrafted Session API. Everything mounted below is an installed package
 * reached through its own `lib/index.js` entry, on a plain `Cordis.Context`,
 * with the public plugin API only: `ctx.plugin`, `ctx.provide`, `ctx.typert`,
 * `ctx.remoteAccess`, `ctx.sessions`, `connection.createPeer` and
 * `connection.createSharedFetchHandler`.
 *
 * The member graph is:
 *   owner Peer  -> real Gateway -> real SessionController -> real Sessions
 *   member Peer -> real Gateway -> real SessionController -> real Sessions
 * with `Access.decide()` in front of every non-owner call and
 * `Access.allows()` filtering every list row.
 *
 * @module verification/public-member-access
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Non-owner principal kind this proof serves. */
export const MEMBER_KIND = 'lan-member';
/** The one role this proof grants: Session reads plus the live-control stream. */
export const MEMBER_ROLE = Object.freeze({
  name: 'member',
  resource: 'session',
  actions: Object.freeze(['session/list', 'session/page', 'session/follow', 'session/control']),
});
/** Member id -> the single Session id that member is granted. */
export const MEMBER_SESSIONS = Object.freeze({ alice: 'alice-session', bob: 'bob-session' });

/**
 * Mount a real installed Host graph and serve members from it.
 * @param {object} options - fixture inputs.
 * @param {string} options.modules - installed `node_modules` directory holding `@deepseek-ai/*`.
 * @param {string} options.directory - caller-owned empty scratch directory.
 * @param {boolean} [options.memberPolicy] - register the `lan-member` policy (false proves fail-closed).
 * @returns {Promise<object>} the live graph, Peers, RPC helpers, and disposal.
 */
export async function publicMemberAccessFixture({ modules, directory, memberPolicy = true } = {}) {
  if (typeof modules !== 'string' || modules.length === 0) throw new TypeError('publicMemberAccessFixture: installed modules directory is required');
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('publicMemberAccessFixture: a scratch directory is required');
  const load = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { default: Registry }, { default: Access }, { default: Gateway }, { HostConnectionService },
    { default: Sessions }, { default: Projections }, { default: Agents }, Jsonl, { default: Workspace },
    { default: LocalFs }, { default: Query }, { default: DefaultModel }, { default: Attachments }, { default: Uploads },
    { default: Commands }, { default: Llm }, { default: Controller }, { DomainFacility }, { JsonStorageBackend },
    { BackendRegistry }, { TYPERT: SessionWire }] = await Promise.all([
    'cordis', 'dsh-typert-registry', 'dsh-api-remote-access', 'dsh-api-gateway', 'dsh-client-connection',
    'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-session-persistence-jsonl', 'dsh-workspace',
    'dsh-fs-local', 'dsh-session-query', 'dsh-agent-default-model', 'dsh-attachment-local', 'dsh-client-file-upload',
    'dsh-commands', 'dsh-llm', 'dsh-api-session-controller', 'dsh-storage-domain', 'dsh-storage-json', 'dsh-storage',
    'dsh-api-session-controller/typert.host',
  ].map(name => name.endsWith('/typert.host')
    ? import(pathToFileURL(path.join(modules, '@deepseek-ai', name.split('/')[0], 'lib/typert.host.js')).href)
    : load(name)));

  const fibers = [], peers = new Map(), disposers = [];
  let root, host, facility, backend, closed, policyBinding, fetcher;

  const close = () => closed ??= (async () => {
    const errors = [];
    for (const [label, release] of [
      ['peers', () => Promise.all([...peers.values()].reverse().map(peer => peer.dispose()))],
      ['disposers', () => Promise.all(disposers.splice(0).reverse().map(remove => remove()))],
      ['fibers', () => Promise.all(fibers.splice(0).reverse().map(fiber => fiber.dispose()))],
      ['facility', () => facility?.closeAll()],
      ['backend', () => backend?.close()],
    ]) {
      try { await release(); } catch (error) { errors.push(Object.assign(error instanceof Error ? error : new Error(String(error)), { cleanupStage: label })); }
    }
    if (errors.length !== 0) throw new AggregateError(errors, 'public member access fixture cleanup failed');
  })();

  try {
    // One plain Context. No loader, no bootstrap registration, no kernel.
    root = new Context();
    const storage = new BackendRegistry();
    backend = new JsonStorageBackend(path.join(directory, 'domains'));
    storage.register('json', backend);
    facility = new DomainFacility({ storage: { backend: storage }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'json' });

    const mount = async (plugin, config) => {
      const fiber = root.plugin(plugin, config);
      fibers.push(fiber);
      await fiber.await();
      return fiber;
    };

    // --- real public services, mounted in dependency order -------------------
    await mount(Registry);
    await mount(Access);
    await mount({ apply(ctx) { ctx.provide('storageDomain', facility); } });
    await mount(Gateway, {});
    await mount({ apply(ctx) { new HostConnectionService(ctx, [], {}); } });
    await mount(Sessions);
    await mount(Projections);
    await mount(Agents);
    await mount(Llm);
    await mount(DefaultModel, { provider: 'offline-member-proof', model: 'offline' });
    await mount(LocalFs, { cwd: path.join(directory, 'host') });
    await mount(Jsonl, { root: path.join(directory, 'sessions'), compression: 'none' });
    await mount(Workspace);
    await mount(Query);
    await mount(Attachments, { dshHome: path.join(directory, 'home') });
    await mount(Commands);
    await mount(Uploads);
    // The real Session Remote domain and its real Host controller.
    await mount({ inject: ['typert'], apply(ctx) { ctx.typert.register(SessionWire); } });
    await mount(Controller, { nativeOpen: false });

    // --- persisted Sessions, one distinct project root per member ------------
    const cwds = {};
    for (const userId of Object.keys(MEMBER_SESSIONS)) {
      const cwd = path.join(directory, `${userId}-workspace`);
      cwds[userId] = cwd;
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(path.join(cwd, 'README.md'), `${userId} project root\n`);
    }
    await mount({
      inject: ['typert', 'typertGateway', 'remoteAccess', 'connection', 'sessions', 'sessionPersistence', 'sessionQuery', 'sessionController'],
      apply(ctx) {
        host = ctx;
        for (const [userId, sessionId] of Object.entries(MEMBER_SESSIONS)) ctx.sessions.create(sessionId, { meta: { cwd: cwds[userId] } });
      },
    });
    await host.sessionPersistence.flush();

    // --- the ONLY authorization added by this fixture ------------------------
    const policy = Object.freeze({
      bindings(value) {
        if (value?.kind !== MEMBER_KIND) return [];
        const granted = MEMBER_SESSIONS[value.userId];
        if (granted === undefined) return [];
        const binding = resource => Object.freeze({ role: MEMBER_ROLE, resource: Object.freeze(resource) });
        // `session/list` resolves to `global`, then filters rows through `allows()`.
        return [binding({ kind: 'global' }), binding({ kind: 'session', id: granted })];
      },
      explain: () => 'member-session-not-granted',
    });
    policyBinding = memberPolicy ? host.remoteAccess.registerPolicy(MEMBER_KIND, policy) : undefined;
    if (policyBinding !== undefined) disposers.push(policyBinding);

    // --- Peers and calls -----------------------------------------------------
    const peer = userId => {
      const existing = peers.get(userId);
      if (existing !== undefined) return existing;
      const principal = userId === 'owner'
        ? Object.freeze({ kind: 'owner' })
        : Object.freeze({ kind: MEMBER_KIND, userId, loginId: `L-${userId}` });
      const value = host.connection.createPeer({ principal, interactions: 'answer' });
      peers.set(userId, value);
      return value;
    };
    const endpoint = method => method.split('/');
    const rpc = (userId, method, args = {}) => {
      const [namespace, member] = endpoint(method);
      return host.typertGateway.invoke({ namespace, method: member, args, peer: peer(userId) });
    };
    // Streams carry their own `@Remote({ mode: 'stream' })` carrier, so they need
    // the stream entry point rather than `invoke`.
    const stream = (userId, method, args = {}) => {
      const [namespace, member] = endpoint(method);
      return host.typertGateway.stream({ namespace, method: member, args, peer: peer(userId) });
    };
    fetcher ??= host.connection.createSharedFetchHandler('/api');
    const http = async (userId, method, args = {}) => {
      const response = await fetcher.fetch(new Request('http://public-member-access.test/api/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `public-member-access-${method}`, method, payload: { args } }),
      }), peer(userId));
      const body = await response.json();
      return { status: response.status, result: body.result };
    };

    return {
      modules, directory, host, policy, cwds, sessions: MEMBER_SESSIONS, memberPolicy,
      peer, rpc, stream, http, close,
      get registeredPolicy() { return policyBinding !== undefined; },
      registerPolicy() {
        if (policyBinding === undefined) {
          policyBinding = host.remoteAccess.registerPolicy(MEMBER_KIND, policy);
          disposers.push(policyBinding);
        }
        return policyBinding;
      },
    };
  } catch (error) {
    await close().catch(cleanup => { throw new AggregateError([error, cleanup], 'public member access fixture failed and cleanup failed'); });
    throw error;
  }
}
