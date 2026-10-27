import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { installMemberCordis } from './carrier/cordis.mjs';
import { NativeUsage, nativeUsageRevisions } from './carrier/usage.mjs';
import { MemberLimits, installMemberLimitAdmission, installMemberLimitPrompt } from './carrier/limits.mjs';
import { BackupControl, installBackupAgent, installBackupModelGuard, installBackupOperationGuard } from './carrier/backup.mjs';
import { Branding } from './carrier/branding.mjs';
import { Administration, renameNativeSession } from './carrier/administration.mjs';
import { memberEntry } from './runtime/member-entry.mjs';
import { requiresModelCatalog } from './runtime/model-catalog.mjs';
import { AdministratorPreviews, installPreviewHistory, installPreviewFileScopes } from './carrier/admin-previews.mjs';
import { installAdministratorDesktop } from './carrier/desktop.mjs';
import { ServerSetup } from './carrier/setup.mjs';
import { dirname, resolve, posix } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DomainStore } from './domain-store.js';
import { MemberSessions } from './carrier/auth.mjs';
import { mountMemberCarrier } from './carrier/member.mjs';
import { installMemberTerminals } from './carrier/execution.mjs';
import { createMemberBoundary, installMemberBoundary, memberHome, memberSourceIsolated } from './carrier/member-boundary.mjs';
import { MemberAttachmentAccess } from './carrier/attachments.mjs';
import { readMemberAttachments } from './carrier/workspaces.mjs';
import { MemberOwnership, memberAccessPolicy, memberToolAllow, memberPathDenial } from './carrier/access.mjs';
import { MemberCapabilities, installMemberScheduleAdmission } from './carrier/capabilities.mjs';
import { installMemberSkills, installMemberSkillScopes } from './carrier/skills.mjs';
import { installMemberAgentPresets } from './carrier/presets.mjs';
import { installMemberPermissions, installMemberCommands } from './carrier/permissions.mjs';
import { installMemberInteractions } from './carrier/interactions.mjs';
import { installMemberResourceTools, installMemberMcpResources, installMemberMcpContext, toolOrigin } from './carrier/resources.mjs';
import { resolveSharedDirectories, installMemberFileRanges } from './carrier/file-ranges.mjs';
import { sharedDirectories as validateDirectoryFields } from './core/validation.js';
import { MemberHomeRuntime } from './carrier/home-runtime.mjs';
import { nativeMemberSessions } from './carrier/native-sessions.mjs';
import { MemberModels, installMemberModelStream, installMemberModelSelection } from './carrier/models.mjs';
import { HomeDirectories, createHomeDirectoryController, publicHome } from './runtime/home-directories.mjs';
import { createIsolationCheck } from './runtime/isolation-check.mjs';
import { reject } from './core/errors.js';
import { resolveHostPackage } from './carrier/host-package.mjs';

const json = value => new Response(JSON.stringify({ ok: true, result: value }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' } });
const spec = name => ({ name, version: 1, layout: 'single', tables: { state: { valueSchema: z.json() } } });

/** One carrier over the existing Host; no duplicate Agent graph or worker. */
export async function mountMemberHost(ctx, { core, coreStore, hostCapability, updateProviders, catalog, config = {} }) {
  const ownerOrigin = ctx.webServer.getOrigin();
  const memberOrigin = memberEntry({ ownerOrigin, memberOrigin: config.memberOrigin });
  const domains = [], cleanup = [];
  let disposed = false, closingPromise, timer, projects, ownership, removeCarrier, executionBoundary;
  const runtime = new MemberHomeRuntime({ projectRoot: config.projectRoot || null,
    checkExecution: async workspaceRoot => {
      executionBoundary?.assertAvailable();
      if (!executionBoundary) reject('MEMBER_BOUNDARY_UNAVAILABLE', 'Member directory enforcement is not ready.', 503);
      const result = await ctx.get('sandbox').confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot });
      return { ...result, memberDirectoryBoundary: true };
    } });
  const open = async name => { const domain = await ctx.storageDomain.open(spec(name)); domains.push(domain); return new DomainStore(domain); };
  const prefix = config.domainPrefix || 'lan_workspace';
  if (!/^[a-z][a-z0-9_]{0,55}$/.test(prefix)) throw new TypeError('Invalid private storage namespace');
  async function close() {
    if (closingPromise) return closingPromise;
    disposed = true; clearInterval(timer);
    closingPromise = (async () => {
      const failures = [];
      for (const dispose of [() => removeCarrier?.(), () => projects?.close()]) { try { await dispose(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Native member work did not stop; authorization guards retained');
      for (const dispose of cleanup.slice().reverse()) { try { await dispose(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Member resources did not all close');
      for (const domain of domains.slice().reverse()) await domain.close();
      await runtime.close();
    })();
    return closingPromise;
  }
  try {
    const branding = await new Branding({ store: await open(prefix + '_branding'), core }).start();
    const homes = await new HomeDirectories({ store: await open(prefix + '_homes'), runtime, defaultRoot: config.projectRoot || null }).start(await coreStore.load());
    const contentApi = ctx.connection.createSharedFetchHandler('/api');
    const contentPeer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
    cleanup.push(() => contentPeer.dispose());
    const contentCall = async (method, args) => {
      const response = await contentApi.fetch(new Request(new URL('/api/' + method, ownerOrigin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'lan-admin-content-' + randomUUID(), method, payload: { args } }) }), contentPeer);
      const result = (await response.json()).result;
      if (!result?.ok) reject('ADMIN_SESSION_UNAVAILABLE', result?.error?.message || 'Native session operation failed.', 409);
      return result.value;
    };
    const { normalizeSessionTitle } = await import(pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-session-title')).href);
    const publishAdministrativeTitle = async id => {
      const projections = await contentCall('session/projections', { request: { sessionId: id } });
      const row = (await contentCall('session/list', { _request: {} })).items.find(item => item.sessionId === id);
      if (row) ctx.emit('api-session/added', { ...row, ...(projections?.kind === 'sequenced' ? { projections } : {}) });
    };
    const previews = new AdministratorPreviews({ core, hostCapability, ownership: { entriesOf: id => ownership.entriesOf(id), ownerOf: id => ownership.ownerOf(id) },
      sessions: { list: () => contentCall('session/list', { _request: {} }) }, invalidate: () => ctx.remoteAccess.invalidate() });
    cleanup.push(() => previews.close());
    const previewHistory = ctx.inject(['sessionController'], child => child.effect(() => installPreviewHistory(child, previews)));
    const previewFiles = ctx.inject(['workspaceFiles'], child => child.effect(() => installPreviewFileScopes(child, previews)));
    cleanup.push(() => previewFiles.dispose());
    cleanup.push(() => previewHistory.dispose());
    const administration = new Administration({ core, ownership: { entriesOf: id => ownership.entriesOf(id) }, homes, previews, recycleStore: await open(prefix + '_recycle'),
      sessions: { list: request => contentCall('session/list', { _request: request }), inspect: (...args) => ctx.get('sessionController').inspect(...args),
        rename: request => renameNativeSession({ ctx, normalizeTitle: normalizeSessionTitle, publish: publishAdministrativeTitle }, request),
        cancel: request => { const agent = ctx.agents.get(request.sessionId); agent?.cancel({ kind: 'user' }, { keepInbox: true }); return { accepted: Boolean(agent) }; } },
      archiveChanged: (userId, ids) => ctx.emit('lan-workspace/archives-changed', userId, ids) });
    cleanup.push(() => administration.close());
    const synchronizeHomes = async () => homes.synchronize(await coreStore.load());
    await synchronizeHomes();
    ownership = await new MemberOwnership({ store: await open(prefix + '_ownership') }).start();
    cleanup.push(() => ownership.close());
    projects = nativeMemberSessions({ ctx, ownership, runtime });
    const models = new MemberModels({ core, hostCapability, ownership, ctx });
    const runtimePaths = [process.execPath, resolve(dirname(resolveHostPackage('@deepseek-ai/dsh/package.json')), '../..')];
    const dshHome = process.env.DSH_HOME || resolve(homedir(), '.dsh');
    const protectedRoots = [...['storages', 'sessions', 'attachments', 'profiles', 'settings.yaml', 'cordis.yml', 'auth.json'].map(path => resolve(dshHome, path)), resolve(homedir(), '.local/share/dsh-lan'), resolve(homedir(), '.local/share/dsh-lan-backups'), resolve(homedir(), '.ssh'), resolve(homedir(), '.codex/auth.json'), resolve(homedir(), '.codex/config.toml')];
    const origins = ctx.get('lanToolOrigins');
    if (!origins) throw new Error('Native tool registration origins are unavailable');
    const capabilities = new MemberCapabilities({ core, hostCapability, ownership, ctx, origins, protectedRoots, readonlyRoots: runtimePaths });
    executionBoundary = await createMemberBoundary({ runtimePaths });
    const resourceBindings = new Map();
    cleanup.push(() => { for (const restore of resourceBindings.values()) restore(); resourceBindings.clear(); });
    const ensureResourceContext = context => {
      for (const [name, install] of [['tools', installMemberResourceTools], ['mcpResources', installMemberMcpResources], ['systemPrompt', installMemberMcpContext]]) {
        const service = context.get(name);
        if (!service) continue;
        const original = service[Symbol.for('cordis.original')] ?? service;
        if (!resourceBindings.has(original)) resourceBindings.set(original, install(service, { models, capabilities, ownership, origins }));
      }
    };
    for (const name of ['tools', 'mcpResources', 'systemPrompt']) {
      const observer = ctx.inject([name], ensureResourceContext);
      cleanup.push(() => observer.dispose());
    }
    const interactions = ctx.inject(['typertGateway'], child => installMemberInteractions(child.get('typertGateway'), { ownership, capabilities }));
    cleanup.push(() => interactions.dispose());
    const cordis = ctx.inject(['dynamicCordisRunner', 'typertGateway'], child => installMemberCordis(child.get('dynamicCordisRunner'), child.get('typertGateway'), { models, ownership, capabilities }));
    cleanup.push(() => cordis.dispose());
    const bindingForPolicy = policy => {
      const userId = models.requestUser({ sessionId: policy.sessionId }) ?? ownership.bindingForCwd(policy.workspaceRoot)?.userId;
      if (!userId) return undefined;
      const binding = ownership.bindingForCwd(policy.workspaceRoot);
      if (!binding || binding.userId !== userId) reject('MEMBER_EXECUTION_DENIED', 'Member execution requires its private workspace.', 403);
      capabilities.policy(userId);
      const home = memberHome(binding);
      return { ...binding, home, sharedDirectories: capabilities.directories(userId), protectedRoots: [...protectedRoots, ...ownership.privateRoots().filter(root => root !== home)] };
    };
    const bindingForExecution = spec => {
      const candidate = ownership.bindingForCwd(spec.cwd);
      const userId = models.requestUser({ sessionId: spec.env?.DSH_SESSION_ID }) ?? candidate?.userId;
      if (!userId) return undefined;
      if (candidate && candidate.userId !== userId) reject('MEMBER_EXECUTION_DENIED', 'Execution belongs to a different account.', 403);
      capabilities.policy(userId);
      const actor = ctx.agents.currentInitiator?.();
      const cwd = candidate?.cwd ?? (actor && capabilities.userOf(actor) === userId ? actor.session?.header?.cwd : undefined)
        ?? ownership.entriesOf(userId)[0]?.cwd ?? ownership.cwdsOf(userId)[0];
      const binding = ownership.bindingForCwd(cwd);
      if (!binding || binding.userId !== userId || typeof spec.cwd !== 'string') reject('MEMBER_EXECUTION_DENIED', 'Member execution requires its private account directory.', 403);
      const home = memberHome(binding);
      return { ...binding, home, sharedDirectories: capabilities.directories(userId), protectedRoots: [...protectedRoots, ...ownership.privateRoots().filter(root => root !== home)] };
    };
    const executionBindings = new Map();
    cleanup.push(() => { for (const restore of executionBindings.values()) restore(); executionBindings.clear(); });
    const ensureExecutionContext = context => {
      for (const name of ['sandbox', 'subprocess']) {
        const service = context.get(name);
        if (!service) continue;
        const original = service[Symbol.for('cordis.original')] ?? service;
        if (!executionBindings.has(original)) executionBindings.set(original, installMemberBoundary(service, { boundary: executionBoundary, bindingForPolicy, bindingForExecution, kind: name,
          trusted: origins.service(service)?.plugin === '@deepseek-ai/dsh-' + (name === 'sandbox' ? 'sandbox-local' : 'subprocess-local') }));
      }
    };
    for (const name of ['sandbox', 'subprocess']) {
      const observer = ctx.inject([name], ensureExecutionContext);
      cleanup.push(() => observer.dispose());
    }
    const permissionBindings = new Map();
    cleanup.push(() => { for (const restore of permissionBindings.values()) restore(); permissionBindings.clear(); });
    const ensurePermissionContext = context => {
      for (const [name, install] of [['permissionPresets', installMemberPermissions], ['commands', installMemberCommands]]) {
        const service = context.get(name);
        if (!service) continue;
        const original = service[Symbol.for('cordis.original')] ?? service;
        if (!permissionBindings.has(original)) permissionBindings.set(original, install(service, { models, capabilities, ownership }));
      }
    };
    for (const name of ['permissionPresets', 'commands']) {
      const observer = ctx.inject([name], ensurePermissionContext);
      cleanup.push(() => observer.dispose());
    }
    const validateAccess = async (request, caller) => {
      if (!['admin.createUser', 'admin.createInvite', 'admin.updateUser', 'admin.batchUpdateAccess'].includes(request.action) || !Object.hasOwn(request.access ?? {}, 'sharedDirectories')) return;
      const rows = validateDirectoryFields(request.access.sharedDirectories);
      await core.runAdministratorOperation(caller, () => resolveSharedDirectories(rows, { protectedRoots: [...protectedRoots, ...ownership.privateRoots()], readonlyRoots: runtimePaths, strict: true }));
    };
    const skillBindings = new Map();
    cleanup.push(() => { for (const restore of skillBindings.values()) restore(); skillBindings.clear(); });
    const ensureSkills = skills => {
      if (!skills) return;
      const original = skills[Symbol.for('cordis.original')] ?? skills;
      if (!skillBindings.has(original)) skillBindings.set(original, installMemberSkills(skills, { models, capabilities, ownership }));
    };
    const rootSkills = ctx.inject(['skills'], child => { ensureSkills(child.get('skills')); });
    cleanup.push(() => rootSkills.dispose());
    const attachmentAccess = await new MemberAttachmentAccess(await open(prefix + '_attachment_access')).start(async () => {
      const snapshot = await coreStore.load(), legacy = [];
      for (const user of snapshot?.users ?? []) {
        const home = await homes.own(user.id);
        if (home?.path) legacy.push({ userId: user.id, ids: await readMemberAttachments({ home: home.path }) });
      }
      return legacy;
    });
    cleanup.push(() => attachmentAccess.close());
    const isolation = createIsolationCheck({ core, runtime });
    const updateHomeDirectory = createHomeDirectoryController({ core, homes });
    let auth;
    const initialHomePolicy = await homes.policy();
    const setup = await new ServerSetup({ store: await open(prefix + '_setup'), core, homes, origin: memberOrigin, ownerOrigin, aliases: config.memberAliases, recommendedRoot: initialHomePolicy.root ? posix.join(posix.dirname(initialHomePolicy.root), 'dsh-shared') : null,
      validateDirectories: (rows, privateRoot) => resolveSharedDirectories(rows, { protectedRoots: [...protectedRoots, ...ownership.privateRoots(), privateRoot], readonlyRoots: runtimePaths, strict: true }),
      modelVariants: () => catalog?.status().available ?? 0,
      onConfigured: origin => { if (origin !== memberOrigin) auth.addAliases([origin]); },
    }).start(await coreStore.load());
    auth = new MemberSessions({ core, origin: memberOrigin, ownerOrigin, aliases: [...new Set([...(config.memberAliases ?? []), setup.state.memberOrigin])].filter(origin => origin !== memberOrigin), onLogin: synchronizeHomes, authorizeUser: user => setup.authorizeUser(user) });
    cleanup.push(() => auth.close());
    cleanup.push(ctx.remoteAccess.registerPolicy('lan-member', memberAccessPolicy(ownership, (userId, action) => { capabilities.assertEndpoint(userId, action); return true; }, principal => previews.bindings(principal))));
    const { scopeParentOf, createScope, scopeOf } = await import(pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-scope')).href);
    const presetSkills = ctx.inject(['agentPresets'], child => installMemberSkillScopes(child.get('agentPresets'), {
      scopeOf, isMember: agent => ownership.isMemberCwd(agent.session.header.cwd), install: ensureSkills,
      installContext: context => { ensurePermissionContext(context); ensureResourceContext(context); },
    }));
    cleanup.push(() => presetSkills.dispose());
    const presetAccess = ctx.inject(['agentPresets'], child => installMemberAgentPresets(child.get('agentPresets'), { scopeOf, models, capabilities, ownership }));
    cleanup.push(() => presetAccess.dispose());
    const brands = await import(pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-llm')).href);
    const usage = new NativeUsage({ core, coreStore, hostCapability, ownership, query: { observeSession: (...args) => ctx.get('sessionQuery').observeSession(...args) }, lastUsage: stream => brands.lastAssistantStreamChunk(stream, 'usage')?.usage,
      revisions: ids => nativeUsageRevisions(ids, { sessions: ctx.sessions, persistence: ctx.get('sessionPersistence') }),
    });
    const { RemoteError } = await import(pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-typert-protocol')).href);
    let backup;
    const backupAgents = new Map();
    const protectBackupAgent = agent => {
      if (backup && !backupAgents.has(agent)) backupAgents.set(agent, installBackupAgent(agent, backup));
    };
    cleanup.push(() => { for (const release of backupAgents.values()) release(); backupAgents.clear(); });
    cleanup.push(ctx.on('agent/disposed', ({ agent }) => { backupAgents.get(agent)?.(); backupAgents.delete(agent); }, { global: true }));
    if (config.backupControlPath) {
      const busy = () => {
        const agents = ctx.agents.list(), jobs = ctx.get('jobs'), terminals = ctx.get('terminalController');
        if (administration.uploads.size || agents.some(agent => agent.status !== 'idle' || agent.phase?.kind === 'maintenance')) return true;
        if (jobs && [undefined, ...agents.map(agent => agent.id)].some(owner => jobs.list(owner).some(job => ['running', 'stopping'].includes(job.status)))) return true;
        const owners = terminals?.[Symbol.for('cordis.original')]?.owners ?? terminals?.owners;
        if (terminals && !(owners instanceof Map)) return true;
        return owners ? [...owners.keys()].some(id => terminals.list(id).some(row => !['exited', 'failed'].includes(row.state))) : false;
      };
      backup = await new BackupControl({ path: config.backupControlPath, busy, RemoteError, plan: async () => {
        const roots = [{ key: 'dsh', path: dshHome }, { key: 'lan-state', path: dirname(config.backupControlPath) }];
        const state = await coreStore.load();
        for (const user of state.users) {
          const home = await homes.own(user.id);
          if (!home.path) throw new Error('A member home could not be mapped for backup');
          roots.push({ key: 'home-' + user.id, path: home.path });
        }
        const allocation = await homes.read();
        for (const entry of allocation.projects) if (entry.root) roots.push({ key: 'legacy-' + entry.projectId, path: resolve(entry.root, entry.userId) });
        await ctx.get('sessionPersistence').flush();
        return roots.filter((row, i) => roots.findIndex(other => other.path === row.path) === i);
      } }).start();
      cleanup.push(() => backup.close());
      for (const agent of ctx.agents.list()) protectBackupAgent(agent);
      const terminalBackup = ctx.inject(['terminalController'], child => installBackupOperationGuard(child.get('terminalController'), 'create', backup));
      cleanup.push(() => terminalBackup.dispose());
    }
    const limits = await new MemberLimits({ store: await open(prefix + '_limits'), core, coreStore, hostCapability, usage, RemoteError }).start();
    limits.beforeAdmission = () => backup?.assertAvailable();
    await usage.refresh();
    const modelBinding = ctx.inject(['llm', 'sessionController'], child => {
      const stream = installMemberModelStream(child.get('llm'), { models, limits, ...brands });
      const backupStream = backup ? installBackupModelGuard(child.get('llm'), backup) : () => {};
      let selection, prompt;
      try {
        selection = installMemberModelSelection(child.get('sessionController'), { models });
        prompt = installMemberLimitPrompt(child.get('sessionController'), limits, id => models.userOf(id));
      }
      catch (error) { selection?.(); backupStream(); stream(); throw error; }
      return () => { prompt(); selection(); backupStream(); stream(); };
    });
    cleanup.push(() => modelBinding.dispose());
    const modeOf = session => { try { return ctx.get?.('sandboxPolicy')?.resolve({ session }).mode; } catch { return undefined; } };
    const filesystem = ctx.inject(['fs'], child => installMemberFileRanges(child.get('fs'), { bindingForPolicy }));
    cleanup.push(() => filesystem.dispose());
    const terminals = ctx.inject(['terminalController'], child => installMemberTerminals(child.get('terminalController'), {
      isMember: agent => ownership.isMemberCwd(agent?.session?.header?.cwd),
      authorize: (agent, method) => capabilities.assertEndpoint(capabilities.userOf(agent), `terminal/${method}`),
    }));
    cleanup.push(() => terminals.dispose());
    cleanup.push(ctx.on('agent/created', async ({ agent }) => {
      protectBackupAgent(agent);
      const cwd = agent?.session?.header?.cwd, binding = ownership.bindingForCwd(cwd);
      const caller = models.requestUser({ sessionId: agent.id });
      if (caller && (!binding || binding.userId !== caller)) reject('MEMBER_EXECUTION_DENIED', 'A child Agent cannot leave its account workspace.', 403);
      if (!binding) return;
      if (disposed) throw new Error('Member service is closing');
      // Native subagents inherit the private cwd; retain their real Session ids
      // in the same durable ownership map used by the original HTTP/WS gateway.
      if (!ownership.ownerOf(agent.id)) await ownership.record({ ...binding, sessionId: agent.id, cwd });
      agent.ctx.effect(() => installMemberScheduleAdmission(agent, capabilities));
      agent.ctx.effect(() => installMemberLimitAdmission(agent, limits, binding.userId));
      ensurePermissionContext(agent.ctx);
      ensureExecutionContext(agent.ctx);
      agent.ctx.get('permissionPresets')?.pinInitialPermission(agent.session);
      await models.initialize(agent, ctx.get('sessionController'));
      const scope = agent.ctx;
      ensureResourceContext(scope);
      if (!scope?.tools) throw new Error('Member Agent tools are unavailable');
      ensureSkills(ctx.get('agentPresets')?.serviceFor(agent, 'skills') ?? scope.get('skills'));
      scope.effect(() => {
        const policy = capabilities.policy(binding.userId);
        const inherited = scope.tools.schemas(scopeParentOf(agent));
        const names = memberToolAllow(inherited);
        const allow = names.filter(name => capabilities.toolAllowed(policy, name, agent));
        const disposers = [
          ...(!capabilities.toolAllowed(policy, 'run_code', agent) && scope.tools.modeFor(agent) !== 'native' ? [scope.tools.presentAs('native')] : []),
          scope.tools.restrict(policy.tools === null ? { deny: names.filter(name => !allow.includes(name)) } : { allow }),
          scope.tools.guard(exec => capabilities.toolDenial(exec, modeOf(exec?.agent?.session ?? agent.session))),
          scope.on('tools/pre-execute', async (exec, next) => {
            const reason = await memberPathDenial(exec, cwd, { realpath, sharedDirectories: capabilities.directories(binding.userId) });
            return reason === undefined ? models.forTool(agent, next) : { kind: 'deny', reason };
          }),
        ];
        return () => { for (const dispose of disposers.reverse()) dispose(); };
      });
    }, { global: true }));
    const homeSnapshot = async (snapshot, { section = 'full' } = {}, revalidate) => {
      const withUsage = section === 'full' || section === 'usage';
      const withCatalog = section === 'full' || section === 'catalog';
      const usageBoard = withUsage ? await usage.refresh() : snapshot.usage;
      await synchronizeHomes();
      let toolCatalog, skillCatalog, agentPresetCatalog, permissionPresetCatalog, pluginCatalog, mcpCatalog, unAttributedTools, skillCatalogComplete = true;
      if (withCatalog && (snapshot.admin || snapshot.preferences)) {
        const names = new Set(ctx.tools.schemas().map(row => row.name));
        const skills = new Map();
        const plugins = new Map(), servers = new Set(), unknown = new Set();
        const collectResources = (context, scope) => {
          for (const definition of context.tools.view(scope).visible.values()) {
            const source = toolOrigin(origins, definition, context);
            if (!source) { unknown.add(definition.name); continue; }
            const entry = plugins.get(source.plugin) ?? { id: source.plugin, label: source.plugin, tools: new Set() };
            entry.tools.add(definition.name); plugins.set(source.plugin, entry);
            if (source.mcpServer) servers.add(source.mcpServer);
          }
          for (const name of context.get('mcpResources')?.layers.merge(scope, layer => layer.servers).keys() ?? []) servers.add(name);
        };
        collectResources(ctx);
        const presets = ctx.get('agentPresets');
        agentPresetCatalog = await presets?.list() ?? [];
        permissionPresetCatalog = ctx.get('permissionPresets')?.catalog().options.map(row => ({ id: row.value, label: row.name, description: row.description })) ?? [];
        for (const preset of agentPresetCatalog) {
          if (preset.broken) continue;
          const lease = await presets.acquireScope(preset.id);
          const cold = createScope(ctx, {}, { parent: lease.key });
          try {
            collectResources(cold.ctx, lease.key);
            for (const row of ctx.tools.schemas(lease.key)) names.add(row.name);
            const service = presets.serviceFor({ ctx: cold.ctx }, 'skills') ?? ctx.get('skills');
            if (service) {
              try {
                const observed = await service.snapshot({ scope: lease.key, cwd: ctx.get('workingDirectory')?.defaultDirectory });
                skillCatalogComplete &&= observed.complete;
                for (const row of observed.skills) skills.set(row.name, { id: row.name, label: row.name, description: row.description });
              } catch { skillCatalogComplete = false; }
            }
          } finally { await cold.dispose(); await lease[Symbol.asyncDispose](); }
        }
        toolCatalog = [...names].sort();
        skillCatalog = [...skills.values()].sort((a, b) => a.id.localeCompare(b.id));
        pluginCatalog = [...plugins.values()].map(row => ({ ...row, tools: [...row.tools].sort(), memberIsolated: memberSourceIsolated({ plugin: row.id }) })).sort((a, b) => a.id.localeCompare(b.id));
        mcpCatalog = [...servers].sort().map(id => ({ id, label: id, memberIsolated: false }));
        unAttributedTools = [...unknown].sort();
      }
      // Slow read-only observations never carry an old login or grant across a
      // revoke/change. Filter host metadata against the latest authorized view.
      if (revalidate) snapshot = await revalidate();
      const personalCatalog = withCatalog && snapshot.preferences ? Object.fromEntries([
        ['skills', skillCatalog], ['agentPresets', agentPresetCatalog], ['permissionPresets', permissionPresetCatalog], ['plugins', pluginCatalog], ['mcpServers', mcpCatalog],
      ].map(([field, rows]) => [field, (rows ?? []).filter(row => !['plugins', 'mcpServers'].includes(field) || row.memberIsolated).filter(row => snapshot.preferences.granted[field] === null || snapshot.preferences.granted[field].includes(row.id)).map(row => ({ id: row.id, label: row.label ?? row.name ?? row.id, ...(row.description ? { description: row.description } : {}) }))])) : null;
      return { ...snapshot, memberUrl: setup.state.memberOrigin + '/lan/', ...(personalCatalog ? { preferences: { ...snapshot.preferences, catalog: personalCatalog, skillCatalogComplete, directoryBoundary: executionBoundary.snapshot() } } : {}), branding: branding.snapshot(), usage: withUsage ? usageBoard : snapshot.usage, limits: limits.snapshot(snapshot.user.id), capabilities: { ...snapshot.capabilities, ...projects.capabilities(), directoryBoundary: executionBoundary.snapshot() }, home: publicHome(await homes.own(snapshot.user.id)),
        ...(snapshot.admin ? { admin: { ...snapshot.admin, users: snapshot.admin.users.map(user => ({ ...user, limits: limits.snapshot(user.id) })), ...(withCatalog ? { toolCatalog, skillCatalog, skillCatalogComplete, agentPresetCatalog, permissionPresetCatalog, pluginCatalog, mcpCatalog, unAttributedTools } : {}), homeDirectory: await homes.policy(), setup: setup.snapshot(), isolationCheck: isolation.snapshot() } } : {}) };
    };
    async function accountChanged(args, result) {
      if (['bootstrap', 'redeem', 'admin.createUser'].includes(args.action)) await synchronizeHomes();
      if (args.action === 'admin.batchUpdateAccess') {
        const affected = new Set(result.updatedUserIds);
        await Promise.all(projects.state.projects.filter(entry => affected.has(entry.userId)).map(entry => projects.stop(entry.projectId)));
        ctx.remoteAccess.invalidate();
        ctx.get('permissionPresets')?.emitCatalogChanged();
      }
      if (args.action === 'password.change') {
        await auth.revokeUser(result.userId);
        await Promise.all(projects.state.projects.filter(entry => entry.userId === result.userId).map(entry => projects.stop(entry.projectId)));
        ctx.remoteAccess.invalidate();
      }
      if (['admin.resetPassword', 'admin.updateUser', 'owner.recoverAdministrator', 'admin.archiveUser', 'admin.restoreUser', 'admin.deleteUser'].includes(args.action)) {
        const userId = args.userId ?? result.userId;
        if (args.action !== 'admin.updateUser' || args.disabled === true || result.roleChanged === true) await auth.revokeUser(userId);
        const affected = projects.state.projects.filter(entry => entry.userId === userId);
        await Promise.all(affected.map(entry => projects.stop(entry.projectId)));
        ctx.remoteAccess.invalidate();
        ctx.get('permissionPresets')?.emitCatalogChanged();
      }
      if (args.action === 'preferences.update') {
        const userId = result.user.id;
        if (!result.preferences.effective.files) await administration.cancelUserUploads(userId);
        await Promise.all(projects.state.projects.filter(entry => entry.userId === userId).map(entry => projects.stop(entry.projectId)));
        ctx.remoteAccess.invalidate();
        ctx.get('permissionPresets')?.emitCatalogChanged();
      }
    }
    async function execute(request, caller) {
      request = setup.defaults(request);
      await updateProviders({ background: !requiresModelCatalog(request.action) });
      if (request.action === 'admin.completeSetup') return setup.complete(request, caller);
      if (request.action === 'admin.updateBranding') return branding.update(request, caller);
      if (request.action === 'admin.updateLimits') return limits.update(request, caller);
      if (['admin.content', 'member.content'].includes(request.action)) return administration.execute(request, caller);
      if (request.action === 'admin.updateHomeDirectory') return updateHomeDirectory(request, caller);
      if (request.action === 'admin.checkIsolation') return isolation.check(request, caller);
      await validateAccess(request, caller);
      const result = await core.execute(request, caller);
      if (request.action === 'usage.list') { await usage.refresh(); return core.execute(request, caller); }
      if (request.action === 'admin.getUser') return { ...result, user: { ...result.user, limits: limits.snapshot(result.user.id) } };
      if (request.action === 'admin.listUsers' && request.summary !== true) return { ...result, items: result.items.map(user => ({ ...user, limits: limits.snapshot(user.id) })) };
      if (request.action === 'status') return { ...result, branding: branding.snapshot() };
      await accountChanged(request, result);
      if (request.action !== 'snapshot') return result;
      const snapshot = await homeSnapshot(result, request, () => core.execute(request, caller));
      return { ...snapshot, ...(snapshot.admin ? { admin: { ...snapshot.admin, ...(catalog ? { catalogStatus: catalog.status() } : {}) } } : {}) };
    }
    const ownerBridge = { current: null };
    const frontendDist = config.frontendDist || resolve(dirname(resolveHostPackage('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
    const desktop = installAdministratorDesktop(ctx.get('webServer'), ctx.get('connection'));
    cleanup.push(() => desktop.dispose());
    removeCarrier = await mountMemberCarrier(ctx, {
      auth, memberOrigin, frontendDist, ownership, attachmentAccess, models, capabilities, previews, brandingSnapshot: () => branding.snapshot(),
      onDesktop: (request, user) => desktop.serve(request, user),
      memberRoot: async userId => (await homes.own(userId)).path,
      streams: ctx.typertGateway.wireStream,
      onAction: async ({ request, auth: current }) => {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) reject('INVALID_INPUT', 'JSON content type required.', 415);
        let fields;
        try { fields = await request.json(); } catch { reject('INVALID_INPUT', 'Invalid JSON request.'); }
        const response = json(await execute(fields, current.caller));
        if (fields.action === 'password.change') response.headers.set('set-cookie', auth.cookie('', true));
        return response;
      },
      onOwnerAction: request => typeof ownerBridge.current === 'function' ? ownerBridge.current(request) : new Response(null, { status: 503 }),
    });
    timer = setInterval(() => { void auth.sweep(); }, 5000); timer.unref?.();
    return { get memberOrigin() { return setup.state.memberOrigin; }, projects, auth, runtime, homes, ownership, homeSnapshot, validateAccess, updateHomeDirectory,
      setupSnapshot: () => setup.snapshot(), completeSetup: (request, caller) => setup.complete(request, caller), prepareRequest: request => setup.defaults(request),
      brandingSnapshot: () => branding.snapshot(), updateBranding: (request, caller) => branding.update(request, caller),
      updateLimits: (request, caller) => limits.update(request, caller),
      userDetails: result => ({ ...result, user: { ...result.user, limits: limits.snapshot(result.user.id) } }),
      userPage: result => ({ ...result, items: result.items.map(user => ({ ...user, limits: limits.snapshot(user.id) })) }),
      usagePage: async (request, caller) => { await usage.refresh(); return core.execute(request, caller); },
      administerContent: (request, caller) => administration.execute(request, caller),
      checkIsolation: isolation.check, accountChanged, setOwnerAction(handler) { ownerBridge.current = handler; }, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Member initialization and cleanup failed'); }
    throw error;
  }
}
