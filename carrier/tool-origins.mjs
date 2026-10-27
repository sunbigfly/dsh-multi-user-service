import { pathToFileURL } from 'node:url';
import { resolveHostPackage } from './host-package.mjs';

/** Read only Loader identity, never provider configuration or credentials. */
export function pluginOrigin(context) {
  const seen = new Set();
  for (let fiber = context?.fiber; fiber && !seen.has(fiber); fiber = fiber.parent?.fiber) {
    seen.add(fiber);
    const entry = fiber.entry;
    if (!entry?.options?.name || entry.options.group) continue;
    const plugin = entry.options.name;
    const server = plugin === '@deepseek-ai/dsh-mcp-client' ? entry.fiber?.config?.serverName : undefined;
    return { plugin, ...(typeof server === 'string' ? { mcpServer: server } : {}) };
  }
  return undefined;
}

export function recordToolOrigins(ToolRuntime) {
  const origins = new WeakMap(), original = ToolRuntime.prototype.register;
  const wrapper = function(definition) {
    const origin = pluginOrigin(this.ctx), dispose = original.call(this, definition);
    if (origin) origins.set(definition, Object.freeze(origin));
    return dispose;
  };
  ToolRuntime.prototype.register = wrapper;
  return {
    get: definition => origins.get(definition),
    service: receiver => pluginOrigin((receiver?.[Symbol.for('cordis.original')] ?? receiver)?.ctx),
    dispose() { if (ToolRuntime.prototype.register === wrapper) ToolRuntime.prototype.register = original; },
  };
}

// The tools entry requires this service. Registration provenance is therefore
// installed before the native ToolRuntime and its contributing plugins start.
export const name = 'multi-user-tool-origins';
export async function apply(ctx) {
  const { ToolRuntime } = await import(pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-tools')).href);
  const origins = recordToolOrigins(ToolRuntime);
  ctx.effect(() => () => origins.dispose());
  ctx.provide('lanToolOrigins', origins);
}
