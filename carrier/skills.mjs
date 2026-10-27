const denied = () => { throw Object.assign(new Error('This skill is not authorized for this account.'), { name: 'MemberCarrierError', code: 'MEMBER_SKILL_DENIED', status: 403 }); };

/** Filter the original registry at its public scoped read boundary. Host catalog
 * discovery remains unscoped; model and explicit user invocations both use the
 * Agent scope that the native skill consumer supplies.
 */
export function installMemberSkills(receiver, { models, capabilities, ownership }) {
  const registry = receiver[Symbol.for('cordis.original')] ?? receiver;
  const restores = [];
  if (['snapshot', 'get'].some(method => typeof registry[method] !== 'function')) throw new Error('Native skill registry is unavailable');
  const userOf = options => {
    const scopeUser = models.userOf(options.scope?.id);
    const directoryUser = ownership.bindingForCwd(options.cwd)?.userId;
    const userId = scopeUser ?? directoryUser;
    if (!userId) return undefined;
    const caller = models.requestUser({ sessionId: options.scope?.id });
    if (caller && caller !== userId || scopeUser && directoryUser && scopeUser !== directoryUser) denied();
    if (options.cwd !== undefined && directoryUser !== userId) denied();
    return userId;
  };
  for (const method of ['snapshot', 'get']) {
    const original = registry[method], descriptor = Object.getOwnPropertyDescriptor(registry, method);
    const wrapper = async function(...args) {
      const options = (method === 'get' ? args[1] : args[0]) ?? {};
      const userId = userOf(options);
      if (!userId) return original.apply(this, args);
      const cut = models.capture(userId);
      try {
        const allowed = capabilities.policy(userId).skills;
        if (method === 'get' && allowed !== null && !allowed.includes(args[0])) denied();
        const scoped = { ...options, signal: options.signal ? AbortSignal.any([options.signal, cut.signal]) : cut.signal };
        const value = await original.call(this, ...(method === 'get' ? [args[0], scoped] : [scoped]));
        cut.assertCurrent();
        scoped.signal.throwIfAborted();
        if (method === 'snapshot') {
          const skills = allowed === null ? value.skills : value.skills.filter(skill => allowed.includes(skill.name));
          return { ...value, skills: capabilities.rememberSkillResources(registry, userId, skills, value.complete) };
        }
        return value && capabilities.rememberSkillResources(registry, userId, [value], false)[0];
      } finally { cut.close(); }
    };
    registry[method] = wrapper;
    restores.push(() => {
      if (registry[method] !== wrapper) return;
      if (descriptor) Object.defineProperty(registry, method, descriptor); else delete registry[method];
    });
  }
  return () => { for (const restore of restores.reverse()) restore(); capabilities.skillResources.delete(registry); };
}

/** Preset changes can replace a scoped skill service without creating a new
 * Agent. Install the same guard before the newly mounted service is consumed.
 */
export function installMemberSkillScopes(receiver, { scopeOf, isMember, install, installContext = () => {} }) {
  const presets = receiver[Symbol.for('cordis.original')] ?? receiver;
  const original = presets.mount, descriptor = Object.getOwnPropertyDescriptor(presets, 'mount');
  if (typeof original !== 'function') throw new Error('Native preset mount integration is unavailable');
  const wrapper = async function(agentCtx, ...args) {
    const value = await original.call(this, agentCtx, ...args);
    const agent = scopeOf(agentCtx);
    if (agent?.session && isMember(agent)) {
      install(this.serviceFor(agent, 'skills') ?? agentCtx.get('skills'));
      installContext(agentCtx);
    }
    return value;
  };
  presets.mount = wrapper;
  return () => {
    if (presets.mount !== wrapper) return;
    if (descriptor) Object.defineProperty(presets, 'mount', descriptor); else delete presets.mount;
  };
}
