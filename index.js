import { API_PATH, createRequestHandler } from './http.js';
import { mountMemberHost } from './member-host.mjs';
import Schema from '@deepseek-ai/schemastery';
import { ModelCatalog, requiresModelCatalog } from './runtime/model-catalog.mjs';
import { openLanAccountRuntime, inspectLanAccountRuntime, closeLanAccountRuntime } from './runtime/lan-account-runtime.mjs';

export const name = 'multi-user-service';
export const Config = Schema.object({
  memberOrigin: Schema.string().description('Member HTTP(S) origin for this deployment, with a hostname different from the owner. Omit to detect this host\'s private LAN IPv4 address and DSH port.'),
  memberAliases: Schema.array(Schema.string()).default([]).description('Explicit same-protocol member origins, for a stable hostname alongside the current IP. Never include the owner hostname.'),
  backupControlPath: Schema.string().description('Private local Unix socket for idle-only backups; never expose it through a shared directory.'),
  projectRoot: Schema.string().description('Initial canonical server root for automatically assigned user homes. Administrator UI policy applies to future allocations; existing homes/projects retain their saved roots.'),
}).default({});
export const inject = ['connection', 'webServer', 'storageDomain', 'tools', 'lanToolOrigins', 'llm', 'agents', 'remoteAccess', 'clientModules', 'typertGateway', 'sessionPersistence', 'sessions', 'skills', 'agentPresets', 'configEditor', 'workingDirectory', 'pluginManager'];

/** Status only: no account/project list and no management authority. */
export function createStatusTool(service) {
  return {
    name: 'lan_workspace_status',
    deferLoading: true,
    description: 'Report DSH Multi-User Service plugin capability status and native DSH execution availability. Does not log in, manage accounts, change permissions, or start project resources.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new Error('No parameters expected');
      const { branding: _branding, ...status } = await service.execute({ action: 'status' }, {});
      return status;
    },
  };
}

/** Additive owner administration plus a distinct non-owner member carrier on
 * the existing listener. No profile rewriting, raw host PTY, adoption of private
 * owner sessions, or import of model credentials into project execution. */
export async function createHostIntegration(ctx, { mountMembers = mountMemberHost, config = {}, accountRuntime } = {}) {
  let ownedRuntime, members, disposeRoute, disposeTool, disposeModels;
  let disposed = false, closing;
  // Startup rollback and the registered disposer join this exact receipt. Do
  // not reverse mutable resource lists or wait on facade work that teardown
  // itself may need to finish. Every independent release is still attempted.
  const cleanup = () => {
    if (closing) return closing;
    disposed = true;
    return closing = Promise.resolve().then(async () => {
      const failures = [];
      for (const close of [
        () => disposeRoute?.(),
        () => disposeTool?.(),
        () => disposeModels?.(),
        () => members?.close(),
        // Member teardown may still use the core/store. Borrowed account
        // infrastructure belongs to its early owner and must never close here.
        () => ownedRuntime === undefined ? undefined : closeLanAccountRuntime(ownedRuntime),
      ]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'LAN Host integration cleanup failed');
    });
  };
  try {
    const fromProvider = accountRuntime === undefined;
    const suppliedRuntime = fromProvider ? ctx.get?.('lanAccountRuntime') : accountRuntime;
    const accountImpl = fromProvider && suppliedRuntime !== undefined && typeof ctx.reflect?._getImpl === 'function' ? ctx.reflect._getImpl('lanAccountRuntime') : undefined;
    const accountValue = accountImpl?.value;
    let selectedRuntime = suppliedRuntime;
    if (selectedRuntime === undefined) {
      // Cordis exposes exact implementation identity separately from its
      // traceable service proxy. Plain test contexts need neither reflection nor
      // a fiber, but a real provider replacement/unload invalidates this owner.
      const hasStorageImpl = typeof ctx.reflect?._getImpl === 'function';
      const storageImpl = hasStorageImpl ? ctx.reflect._getImpl('storageDomain') : undefined;
      const storageDomain = hasStorageImpl ? storageImpl?.value : ctx.storageDomain;
      const fiber = ctx.fiber;
      const assertOwnerCurrent = () => {
        if (ctx.fiber !== fiber) throw new Error('LAN account runtime owner unavailable.');
        fiber?.assertActive?.();
        if (fiber && 'state' in fiber && ![1, 2].includes(fiber.state)) throw new Error('LAN account runtime owner unavailable.');
        if (hasStorageImpl) {
          if (!storageImpl || ctx.reflect?._getImpl?.('storageDomain') !== storageImpl || storageImpl.value !== storageDomain) throw new Error('LAN account storage provider unavailable.');
        } else if (ctx.storageDomain !== storageDomain) {
          throw new Error('LAN account storage provider unavailable.');
        }
      };
      ownedRuntime = await openLanAccountRuntime({ storageDomain, assertCurrent: assertOwnerCurrent });
      selectedRuntime = ownedRuntime;
    }
    // A defined but unbranded/stale handle is an error, never a request to open
    // another account/session domain or create a different capability family.
    const { core: service, coreStore: store, runtimeIdentity, hostCapability, assertCurrent: assertRuntimeCurrent } = inspectLanAccountRuntime(selectedRuntime);
    let invalid = false;
    const consumerFiber = ctx.fiber;
    const assertCurrent = () => {
      if (disposed) throw new Error('Plugin disposed');
      if (invalid) throw new Error('LAN account runtime provider unavailable.');
      try {
        if (ctx.fiber !== consumerFiber) throw new Error('LAN Host consumer unavailable.');
        consumerFiber?.assertActive?.();
        if (consumerFiber && 'state' in consumerFiber && ![1, 2].includes(consumerFiber.state)) throw new Error('LAN Host consumer unavailable.');
        if (fromProvider && suppliedRuntime !== undefined) {
          if (ctx.get?.('lanAccountRuntime') !== suppliedRuntime || accountImpl && (ctx.reflect._getImpl('lanAccountRuntime') !== accountImpl || accountImpl.value !== accountValue)) throw new Error('LAN account runtime provider unavailable.');
        }
        assertRuntimeCurrent();
      } catch (error) { invalid = true; throw error; }
    };
    const awaitCurrent = async operation => {
      assertCurrent();
      const result = await operation();
      assertCurrent();
      return result;
    };
    const catalog = new ModelCatalog({ llm: ctx.llm });
    let providerRefresh, nextProviderRefresh = 0;
    const updateProviders = ({ background = false } = {}) => {
      assertCurrent();
      if (background && Date.now() < nextProviderRefresh) return Promise.resolve();
      const pending = providerRefresh ??= Promise.resolve().then(async () => {
        const providerKeys = ctx.llm.listProviders().map(provider => provider.id);
        await awaitCurrent(() => service.setProviderKeys(providerKeys));
        const models = await awaitCurrent(() => catalog.refresh());
        await awaitCurrent(() => service.setModelCatalog(models));
        nextProviderRefresh = Date.now() + 30000;
        assertCurrent();
      }).finally(() => { providerRefresh = undefined; });
      if (!background) return pending;
      void pending.catch(() => { if (!disposed) ctx.logger?.warn('lan-workspace: model metadata refresh failed; sensitive details withheld'); });
      return Promise.resolve();
    };
    await awaitCurrent(updateProviders);
    disposeModels = ctx.on?.('llm/adapters-updated', () => {
      nextProviderRefresh = 0;
      return updateProviders({ background: true });
    });
    members = await mountMembers(ctx, { core: service, coreStore: store, runtimeIdentity, hostCapability, updateProviders, catalog, config });
    assertCurrent();
    const facade = {
      restoreLogin: (token, audience) => awaitCurrent(() => service.restoreLogin(token, audience)),
      async execute(args, caller) {
        if (args.action === 'admin.cliTools') return awaitCurrent(() => members.manageCliTools(args, caller));
        if (['browser.available', 'browser.operate'].includes(args.action)) return awaitCurrent(() => members.operateBrowser(args, caller));
        args = members.prepareRequest?.(args) ?? args;
        await awaitCurrent(() => updateProviders({ background: !requiresModelCatalog(args.action) }));
        if (args.action === 'admin.completeSetup') return awaitCurrent(() => members.completeSetup(args, caller));
        if (args.action === 'admin.updateBranding') return awaitCurrent(() => members.updateBranding(args, caller));
        if (args.action === 'admin.updateLimits') return awaitCurrent(() => members.updateLimits(args, caller));
        if (['admin.content', 'member.content'].includes(args.action)) return awaitCurrent(() => members.administerContent(args, caller));
        if (args.action === 'admin.updateHomeDirectory') return awaitCurrent(() => members.updateHomeDirectory(args, caller));
        if (args.action === 'admin.checkIsolation') return awaitCurrent(() => members.checkIsolation(args, caller));
        await awaitCurrent(() => members.validateAccess?.(args, caller));
        const result = await awaitCurrent(() => service.execute(args, caller));
        if (args.action === 'usage.list') return members.usagePage ? await awaitCurrent(() => members.usagePage(args, caller)) : result;
        if (args.action === 'admin.getUser') return members.userDetails ? await awaitCurrent(() => members.userDetails(result)) : result;
        if (args.action === 'admin.listUsers' && args.summary !== true) return members.userPage ? await awaitCurrent(() => members.userPage(result)) : result;
        await awaitCurrent(() => members.accountChanged?.(args, result));
        if (args.action === 'status') {
          assertCurrent();
          return { ...result, branding: members.brandingSnapshot?.(), memberUrl: members.memberOrigin + '/lan/', capabilities: { ...result.capabilities, ...members.projects.capabilities() }, configuredModelVariants: catalog?.status().available ?? 0 };
        }
        if (args.action === 'snapshot') {
          const snapshot = members.homeSnapshot ? await awaitCurrent(() => members.homeSnapshot(result, args, () => awaitCurrent(() => service.execute(args, caller)))) : result;
          const admin = snapshot.admin ? { ...snapshot.admin, catalogStatus: catalog.status() } : undefined;
          assertCurrent();
          return { ...snapshot, ...(admin ? { admin } : {}) };
        }
        assertCurrent();
        return result;
      },
    };
    const handler = createRequestHandler(facade, {
      origin: ctx.webServer.getOrigin(),
      // Never log request bodies, passwords, invite tokens, bearer credentials,
      // or arbitrary backend exception messages that may contain sensitive data.
      onUnexpectedError: () => ctx.logger?.warn('lan-workspace: operation failed; sensitive details withheld'),
    });
    disposeRoute = ctx.connection.fetch.register({
      path: API_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: createRequestHandler(facade, {
        origin: ctx.webServer.getOrigin(), allowOwnerRecovery: true,
        onUnexpectedError: () => ctx.logger?.warn('lan-workspace: operation failed; sensitive details withheld'),
      }),
    });
    // The Desktop window's `dsh-app://` origin cannot use the route above, so the
    // same authenticated facade also answers on the plugin's own ingress.
    members?.setOwnerAction?.(handler);
    assertCurrent();
    disposeTool = ctx.tools.register(createStatusTool(facade));
    assertCurrent();
    ctx.effect(() => cleanup);
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'LAN Host integration startup and cleanup failed', { cause: error });
    }
    throw error;
  }
}

export async function apply(ctx, config = {}) {
  // Early account ownership is optional for the legacy default. When present,
  // install a REAL Cordis dependency so provider removal joins member/carrier
  // teardown before its Core closes. Do not return the thenable inject Fiber.
  if (ctx.get?.('lanAccountRuntime') !== undefined) {
    ctx.inject(['lanAccountRuntime'], child => createHostIntegration(child, { config }));
    return;
  }
  return createHostIntegration(ctx, { config });
}
