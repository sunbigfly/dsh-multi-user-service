/** Retain the native factory handles. A scope disposer alone does not unregister
 * an Agent or release its Session writer; only the original handle owns that
 * complete lifecycle. Durable history remains available for native resume.
 */
export function nativeMemberSessions({ ctx, ownership, runtime }) {
  const registry = ctx.agents[Symbol.for('cordis.original')] ?? ctx.agents;
  const handles = new Map(), pending = new Set(), restores = [];
  let closing = false;
  if (['create', 'resume'].some(method => typeof registry[method] !== 'function')) throw new Error('Native Agent lifecycle handles are unavailable');
  for (const method of ['create', 'resume']) {
    const original = registry[method], descriptor = Object.getOwnPropertyDescriptor(registry, method);
    const wrapper = function(options) {
      const userId = ownership.ownerOf?.(options?.resumeSessionId ?? options?.sessionId)
        ?? ownership.bindingForCwd(options?.meta?.cwd)?.userId
        ?? ownership.ownerOf?.(options?.parentAgent?.id);
      if (closing && userId) return Promise.reject(new Error('Member Agent service is closing'));
      const entry = { userId };
      entry.promise = (async () => {
        const handle = await original.call(this, options);
        const agent = handle.agent;
        if (ownership.isMemberCwd(agent.session?.header?.cwd)) {
          if (typeof handle.dispose !== 'function') throw new Error('Native Agent handle cannot be disposed');
          if (closing) { await handle.dispose(); throw new Error('Member Agent service is closing'); }
          handles.set(agent.id, handle);
        }
        return handle;
      })().finally(() => pending.delete(entry));
      pending.add(entry);
      return entry.promise;
    };
    registry[method] = wrapper;
    restores.push(() => {
      if (registry[method] !== wrapper) return;
      if (descriptor) Object.defineProperty(registry, method, descriptor); else delete registry[method];
    });
  }
  const removeDisposed = ctx.on?.('agent/disposed', ({ agent }) => {
    if (handles.get(agent.id)?.agent === agent) handles.delete(agent.id);
  }, { global: true });
  const members = () => ctx.agents.list().filter(agent => ownership.isMemberCwd(agent.session?.header?.cwd));
  return {
    publishing: false,
    get state() { return { projects: members().map(agent => ({ projectId: agent.id, userId: ownership.bindingForCwd(agent.session.header.cwd)?.userId })) }; },
    capabilities() { return { mode: 'member-native', sharedAccess: true, isolatedExecution: false, nativeExecution: true, executionBoundary: 'dsh-native', terminal: true, modelInvocation: true, network: 'dsh-native' }; },
    async stop(sessionId) {
      const agent = ctx.agents.get(sessionId);
      if (agent && ownership.isMemberCwd(agent.session?.header?.cwd)) {
        const userId = ownership.bindingForCwd(agent.session.header.cwd)?.userId;
        await Promise.allSettled([...pending].filter(entry => entry.userId === userId).map(entry => entry.promise));
        if (ctx.agents.get(sessionId) !== agent) return { stopped: true };
        const handle = handles.get(sessionId);
        if (handle?.agent !== agent) throw new Error('Native member Agent lifecycle handle is unavailable; guards retained');
        agent.cancel?.({ kind: 'user' });
        await agent.whenIdle?.();
        const terminals = ctx.get?.('terminalController');
        for (const terminal of terminals?.list(sessionId) ?? []) await terminals.close(agent, terminal.id);
        await handle.dispose();
        if (ctx.agents.get(sessionId) === agent) throw new Error('Native member Agent remained registered after disposal');
        if (handles.get(sessionId) === handle) handles.delete(sessionId);
      }
      return { stopped: true };
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending].filter(entry => entry.userId).map(entry => entry.promise));
      const results = await Promise.allSettled(members().map(agent => this.stop(agent.id)));
      if (results.some(result => result.status === 'rejected')) throw new AggregateError(results.filter(result => result.status === 'rejected').map(result => result.reason), 'Native member scopes did not all stop');
      removeDisposed?.();
      for (const restore of restores.reverse()) restore();
    },
  };
}
