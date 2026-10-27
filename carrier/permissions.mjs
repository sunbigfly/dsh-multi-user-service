const originalOf = receiver => receiver[Symbol.for('cordis.original')] ?? receiver;
const denied = () => { throw Object.assign(new Error('This permission or command is not authorized for this account.'), { code: 'MEMBER_CAPABILITY_DENIED', status: 403 }); };

export function installMemberPermissions(receiver, { models, capabilities, ownership }) {
  const service = originalOf(receiver), restores = [];
  const userOf = session => {
    const userId = models.userOf(session.id) ?? ownership.bindingForCwd(session.header?.cwd)?.userId;
    if (userId) {
      const caller = models.requestUser({ sessionId: session.id });
      if (caller && caller !== userId) denied();
    }
    return userId;
  };
  for (const name of ['apply', 'pinInitialPermission']) {
    const original = service[name], descriptor = Object.getOwnPropertyDescriptor(service, name);
    if (typeof original !== 'function') throw new Error('Native permission preset integration is unavailable');
    const wrapper = function(session, ...args) {
      const userId = userOf(session);
      if (userId && name === 'apply') capabilities.assertPermissionPreset(userId, args[0]);
      if (userId && name === 'pinInitialPermission') {
        const allowed = capabilities.policy(userId).permissionPresets;
        if (allowed !== null) {
          const current = this.current(session);
          const chosen = [current, this.defaultPreset, ...this.names].find(value => allowed.includes(value) && this.names.includes(value));
          if (chosen === undefined) denied();
          if (current !== chosen) this.set(session, chosen);
        }
      }
      return original.call(this, session, ...args);
    };
    service[name] = wrapper;
    restores.push(() => { if (service[name] === wrapper) { if (descriptor) Object.defineProperty(service, name, descriptor); else delete service[name]; } });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}

/** Preserve native command handlers and logging. The account cut propagates
 * through commands that call LLM services without supplying a Session id. */
export function installMemberCommands(receiver, { models, capabilities }) {
  const service = originalOf(receiver), restores = [];
  for (const method of ['list', 'execute']) {
    const original = service[method], descriptor = Object.getOwnPropertyDescriptor(service, method);
    if (typeof original !== 'function') throw new Error('Native command integration is unavailable');
    const wrapper = method === 'list' ? function(agent) {
      const rows = original.call(this, agent), userId = capabilities.userOf(agent);
      return userId ? rows.filter(row => capabilities.commandAllowed(userId, row.name)) : rows;
    } : async function(agent, line, attachments, signal) {
      const userId = capabilities.userOf(agent);
      if (!userId) return original.call(this, agent, line, attachments, signal);
      const name = typeof line === 'string' ? /^\s*\/([^\s]+)/.exec(line)?.[1] : undefined;
      if (!capabilities.commandAllowed(userId, name)) denied();
      if (attachments.length && !capabilities.policy(userId).attachments) denied();
      const cut = models.capture(userId);
      try {
        const value = await models.forTool(agent, () => original.call(this, agent, line, attachments, signal ? AbortSignal.any([signal, cut.signal]) : cut.signal));
        cut.assertCurrent();
        return value;
      } finally { cut.close(); }
    };
    service[method] = wrapper;
    restores.push(() => { if (service[method] === wrapper) { if (descriptor) Object.defineProperty(service, method, descriptor); else delete service[method]; } });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
