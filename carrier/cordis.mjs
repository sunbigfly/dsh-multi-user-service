const originalOf = value => value[Symbol.for('cordis.original')] ?? value;

/** Keep the native Cordis schemas, validation and query lifecycle, with a
 * separate Client manifest/pending directory for each member account. */
export function installMemberCordis(runnerReceiver, gatewayReceiver, { models, ownership, capabilities }) {
  const runner = originalOf(runnerReceiver), gateway = originalOf(gatewayReceiver);
  const registry = originalOf(runner.inspectRegistry), members = new Map(), requestOwners = new Map(), restores = [];
  let nextRequest = 1e12;
  const patch = (object, name, make) => {
    const original = object[name], descriptor = Object.getOwnPropertyDescriptor(object, name);
    const wrapper = make(original); object[name] = wrapper;
    restores.push(() => { if (object[name] === wrapper) { if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name]; } });
  };
  const peerUser = context => context?.invocation?.peer?.principal?.kind === 'lan-member' ? context.invocation.peer.principal.userId : undefined;
  const member = userId => {
    capabilities.policy(userId);
    let view = members.get(userId);
    if (view) return view;
    view = Object.create(registry);
    const context = registry.ctx;
    Object.defineProperties(view, {
      pending: { value: new Map() }, clientManifest: { value: undefined, writable: true },
      nextRequest: { get: () => nextRequest, set: value => { nextRequest = value; } },
      ctx: { value: {
        emit: (...args) => context.emit(...args),
        get: name => name === 'typertGateway' ? { hasLiveClient: () => [...gateway.remoteEventClients.values()].some(client => client.principal.kind === 'lan-member' && client.principal.userId === userId && !client.signal.aborted) } : context.get(name),
      } },
    });
    members.set(userId, view); return view;
  };
  patch(runner, 'syncInspectManifest', original => function(providers) {
    const userId = peerUser(this.ctx);
    if (!userId) return original.call(this, providers);
    registry.syncClientManifest.call(member(userId), providers);
    return null;
  });
  patch(runner, 'inventory', original => function() {
    const rows = original.call(this), userId = peerUser(this.ctx);
    return userId ? rows.filter(row => ownership.ownerOf(row.agentId) === userId) : rows;
  });
  patch(runner, 'resolveInspectQuery', original => function(agent, requestId, resolution) {
    const userId = peerUser(this.ctx);
    if (!userId) return original.call(this, agent, requestId, resolution);
    if (ownership.ownerOf(agent.id) !== userId) return { accepted: false };
    return registry.resolveClientQuery.call(member(userId), agent, requestId, resolution);
  });
  patch(registry, 'list', original => function() {
    const userId = models.requestUser({});
    return original.call(userId ? member(userId) : this);
  });
  patch(registry, 'queryClient', original => function(provider, method, input, agent, signal) {
    const userId = models.userOf(agent.id);
    return original.call(userId ? member(userId) : this, provider, method, input, agent, signal);
  });
  patch(gateway, 'broadcastRemoteEvent', original => function(frame) {
    original.call(this, frame);
    if (frame.event === 'cordis/inspect-query') {
      const request = frame.args?.[0], userId = ownership.ownerOf(request?.agentId);
      if (!userId) return;
      requestOwners.set(request.requestId, userId);
      for (const client of this.remoteEventClients.values()) {
        if (client.principal.kind === 'lan-member' && client.principal.userId === userId && !client.signal.aborted) client.queue.push({ type: 'emit', event: frame.event, args: frame.args });
      }
    } else if (frame.event === 'cordis/inspect-query-resolved') {
      const id = frame.args?.[0]?.requestId, userId = requestOwners.get(id);
      requestOwners.delete(id);
      if (!userId) return;
      for (const client of this.remoteEventClients.values()) if (client.principal.kind === 'lan-member' && client.principal.userId === userId && !client.signal.aborted) client.queue.push({ type: 'emit', event: frame.event, args: frame.args });
    }
  });
  return () => {
    for (const view of members.values()) for (const pending of [...view.pending.values()]) pending.settle({ ok: false, reason: 'cancelled', message: 'Member Cordis integration disposed' });
    for (const restore of restores.reverse()) restore();
    members.clear(); requestOwners.clear();
  };
}
