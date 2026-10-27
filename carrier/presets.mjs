/** Enforce grants at native composition and selection, including model-created
 * children and callers that do not pass through the LAN HTTP facade. */
export function installMemberAgentPresets(receiver, { scopeOf, models, capabilities, ownership }) {
  const registry = receiver[Symbol.for('cordis.original')] ?? receiver, restores = [];
  const userOf = agent => {
    const userId = agent && (models.userOf(agent.id) ?? ownership.bindingForCwd(agent.session?.header?.cwd)?.userId);
    if (!userId) return undefined;
    const caller = models.requestUser({ sessionId: agent.id });
    if (caller && caller !== userId) throw Object.assign(new Error('Agent preset belongs to another account.'), { code: 'MEMBER_CAPABILITY_DENIED' });
    return userId;
  };
  for (const method of ['mount', 'select', 'composeFrom']) {
    const original = registry[method], descriptor = Object.getOwnPropertyDescriptor(registry, method);
    if (typeof original !== 'function') throw new Error('Native Agent preset integration is unavailable');
    const wrapper = method === 'composeFrom' ? function(ctx, parent) {
      const userId = userOf(scopeOf(ctx));
      if (userId) capabilities.assertAgentPreset(userId, this.composedPreset(parent));
      return original.call(this, ctx, parent);
    } : async function(target, id, ...args) {
      const userId = userOf(method === 'mount' ? scopeOf(target) : target);
      if (!userId) return original.call(this, target, id, ...args);
      const cut = models.capture(userId);
      try {
        capabilities.assertAgentPreset(userId, id ?? this.defaultId);
        const value = await original.call(this, target, id, ...args);
        cut.assertCurrent();
        return value;
      } finally { cut.close(); }
    };
    registry[method] = wrapper;
    restores.push(() => {
      if (registry[method] !== wrapper) return;
      if (descriptor) Object.defineProperty(registry, method, descriptor); else delete registry[method];
    });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
