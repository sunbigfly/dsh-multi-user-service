import { memberPathDenial } from './access.mjs';
import { realpath } from 'node:fs/promises';

export function toolOrigin(origins, definition, context) {
  return definition.name === 'run_code' ? origins.service(context.get('ptcRuntime')) : origins.get(definition);
}

/** Native MCP clients publish their instructions under the documented mcp:
 * section name. Filter before evaluation so denied servers do not enter model
 * context even when another server keeps the shared resource tools visible. */
export function installMemberMcpContext(receiver, { models, ownership, capabilities }) {
  const service = receiver[Symbol.for('cordis.original')] ?? receiver, layers = service.layers;
  const original = layers.merge, descriptor = Object.getOwnPropertyDescriptor(layers, 'merge');
  const wrapper = function(scope, select) {
    const value = original.call(this, scope, select);
    const userId = models.userOf(scope?.id) ?? ownership.bindingForCwd(scope?.session?.header?.cwd)?.userId;
    if (!userId) return value;
    const policy = capabilities.policy(userId);
    return new Map([...value].filter(([name]) => !name.startsWith('mcp:') || capabilities.sourceAllowed(policy, { plugin: '@deepseek-ai/dsh-mcp-client', mcpServer: name.slice(4) })));
  };
  layers.merge = wrapper;
  return () => { if (layers.merge === wrapper) { if (descriptor) Object.defineProperty(layers, 'merge', descriptor); else delete layers.merge; } };
}

/** Apply resource grants to the native view used by schemas, SDK generation and
 * execution. Scope-local registrations receive the same check as inherited ones. */
export function installMemberResourceTools(receiver, { models, ownership, capabilities, origins }) {
  const runtime = receiver[Symbol.for('cordis.original')] ?? receiver;
  const original = runtime.view, descriptor = Object.getOwnPropertyDescriptor(runtime, 'view');
  const wrappers = new Map();
  if (typeof original !== 'function') throw new Error('Native tool view is unavailable');
  const wrapper = function(scope) {
    const view = original.call(this, scope);
    const userId = models.userOf(scope?.id) ?? ownership.bindingForCwd(scope?.session?.header?.cwd)?.userId;
    const policy = userId ? capabilities.policy(userId) : null;
    const context = scope?.ctx ?? this.ctx;
    const visible = new Map();
    for (const [name, definition] of view.visible) {
      const source = toolOrigin(origins, definition, context);
      if (!wrappers.has(definition)) {
        const execute = definition.execute, executeDescriptor = Object.getOwnPropertyDescriptor(definition, 'execute');
        const guarded = async function(args, exec) {
          const actor = exec.agent;
          const actorUserId = models.userOf(actor?.id) ?? ownership.bindingForCwd(actor?.session?.header?.cwd)?.userId;
          if (!actorUserId) return execute.call(this, args, exec);
          const current = capabilities.policy(actorUserId);
          const currentSource = toolOrigin(origins, definition, actor?.ctx ?? runtime.ctx);
          if (!capabilities.sourceAllowed(current, currentSource) || !capabilities.toolAllowed(current, name, actor)) throw Object.assign(new Error('This tool plugin or MCP server is not authorized.'), { code: 'MEMBER_RESOURCE_DENIED', status: 403 });
          // Native file-tool aliases must not evade a guard keyed by their
          // default names. Their parameter contract remains the native one.
          const pathTool = { '@deepseek-ai/dsh-tool-fs': 'read', '@deepseek-ai/dsh-tool-fs-search': 'read', '@deepseek-ai/dsh-tool-bash': 'bash', '@deepseek-ai/dsh-tool-pwsh': 'pwsh', '@deepseek-ai/dsh-tool-working-directory': 'working_directory', '@deepseek-ai/dsh-tool-subagent': 'subagent' }[currentSource.plugin];
          if (pathTool) {
            const reason = await memberPathDenial({ ...exec, name: pathTool, arguments: args }, actor.session.header.cwd, { realpath, sharedDirectories: capabilities.directories(actorUserId) });
            if (reason) throw Object.assign(new Error(reason), { code: 'MEMBER_RESOURCE_DENIED', status: 403 });
          }
          const cut = models.capture(actorUserId);
          const previousSignal = exec.signal;
          try {
            const signal = exec.signal ? AbortSignal.any([exec.signal, cut.signal]) : cut.signal;
            exec.signal = signal;
            const result = await models.forTool(actor, () => execute.call(this, args, exec));
            cut.assertCurrent(); signal.throwIfAborted();
            return result;
          } finally { exec.signal = previousSignal; cut.close(); }
        };
        // Native delegation compares definitions by identity and stores private
        // symbol markers on them. Preserve the object and guard execution only.
        definition.execute = guarded;
        wrappers.set(definition, () => {
          if (definition.execute !== guarded) return;
          if (executeDescriptor) Object.defineProperty(definition, 'execute', executeDescriptor);
          else delete definition.execute;
        });
      }
      if (!userId || capabilities.sourceAllowed(policy, source)) visible.set(name, definition);
    }
    return { ...view, visible };
  };
  runtime.view = wrapper;
  return () => {
    if (runtime.view === wrapper) { if (descriptor) Object.defineProperty(runtime, 'view', descriptor); else delete runtime.view; }
    for (const restore of wrappers.values()) restore();
    wrappers.clear();
  };
}

export function installMemberMcpResources(receiver, { models, capabilities, ownership }) {
  const runtime = receiver[Symbol.for('cordis.original')] ?? receiver;
  const original = runtime.request, descriptor = Object.getOwnPropertyDescriptor(runtime, 'request');
  const layers = runtime.layers, merge = layers.merge;
  const filtered = function(scope, select) {
    const value = merge.call(this, scope, select);
    const userId = models.userOf(scope?.id) ?? ownership.bindingForCwd(scope?.session?.header?.cwd)?.userId;
    if (!userId) return value;
    const policy = capabilities.policy(userId);
    return new Map([...value].filter(([server]) => capabilities.sourceAllowed(policy, { plugin: '@deepseek-ai/dsh-mcp-resources', mcpServer: server })));
  };
  layers.merge = filtered;
  if (typeof original !== 'function') throw new Error('Native MCP resource service is unavailable');
  const wrapper = async function(server, request, exec) {
    const userId = models.requestUser({ sessionId: exec?.agent?.id }) ?? ownership.bindingForCwd(exec?.agent?.session?.header?.cwd)?.userId;
    if (!userId) return original.call(this, server, request, exec);
    const policy = capabilities.policy(userId);
    if (!capabilities.sourceAllowed(policy, { plugin: '@deepseek-ai/dsh-mcp-resources', mcpServer: server })) throw Object.assign(new Error('This MCP server is not authorized for this account.'), { code: 'MEMBER_MCP_DENIED', status: 403 });
    const cut = models.capture(userId);
    try {
      const signal = exec.signal ? AbortSignal.any([exec.signal, cut.signal]) : cut.signal;
      const result = await original.call(this, server, request, { ...exec, signal });
      cut.assertCurrent(); signal.throwIfAborted();
      return result;
    } finally { cut.close(); }
  };
  runtime.request = wrapper;
  return () => {
    if (layers.merge === filtered) layers.merge = merge;
    if (runtime.request === wrapper) { if (descriptor) Object.defineProperty(runtime, 'request', descriptor); else delete runtime.request; }
  };
}
