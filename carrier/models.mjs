import { AsyncLocalStorage } from 'node:async_hooks';

const denied = () => { throw Object.assign(new Error('This account is not authorized to use the selected model and reasoning level.'), { name: 'MemberCarrierError', code: 'MEMBER_MODEL_DENIED', status: 403 }); };
const selectionOf = route => ({ provider: route.provider, model: route.model, ...(route.reasoningEffort == null ? {} : { reasoningEffort: route.reasoningEffort }) });
const same = (a, b) => a?.provider === b?.provider && a?.model === b?.model && (a?.reasoningEffort ?? null) === (b?.reasoningEffort ?? null);
const originalOf = receiver => receiver[Symbol.for('cordis.original')] ?? receiver;

/** Account authorization for the actual native Session ids. The trusted Core
 * supplies credential-free, revocable model grants, including background work.
 */
export class MemberModels {
  #core; #cap; #ownership; #ctx; #context = new AsyncLocalStorage();
  constructor({ core, hostCapability, ownership, ctx }) {
    this.#core = core; this.#cap = hostCapability; this.#ownership = ownership; this.#ctx = ctx;
  }
  userOf(sessionId) {
    return this.#ownership.ownerOf(sessionId) ?? this.#ownership.bindingForCwd(this.#ctx.agents.get(sessionId)?.session?.header?.cwd)?.userId;
  }
  forTool(agent, operation) {
    // Shared native schedulers explicitly clear this boundary. A separate ALS
    // would survive that clearing and attribute another user's timer to the
    // account that happened to create the scheduler's last wakeup.
    if (this.#ctx.agents.withInitiator) return this.#ctx.agents.withInitiator(agent, operation);
    const userId = this.userOf(agent.id);
    return userId ? this.#context.run(userId, operation) : operation();
  }
  capture(userId) { return this.#core.memberModels(userId, this.#cap); }
  assertAvailable(userId) {
    const cut = this.capture(userId);
    try { if (!cut.routes.length) denied(); }
    finally { cut.close(); }
  }
  providers(userId, source) {
    const cut = this.capture(userId);
    try { return source.filter(provider => cut.routes.some(route => route.provider === (provider.id ?? provider.provider))); }
    finally { cut.close(); }
  }
  requestUser(options) {
    const explicit = this.userOf(options.sessionId);
    const initiator = this.#ctx.agents.currentInitiator?.();
    const causal = this.#context.getStore() ?? (initiator ? this.userOf(initiator.id) : undefined);
    if (causal && explicit && causal !== explicit) denied();
    return causal ?? explicit;
  }
  async authorize(userId, requested, prepared) {
    const cut = this.capture(userId);
    try {
      const { provider, model, reasoningEffort } = requested;
      if (!cut.routes.some(route => route.provider === provider && route.model === model && (reasoningEffort === undefined || route.reasoningEffort === reasoningEffort))) denied();
      const resolved = prepared ?? await this.#ctx.llm.resolveCallConfig({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
      cut.assertCurrent();
      if (!cut.routes.some(route => same(route, resolved))) denied();
      return cut;
    } catch (error) { cut.close(); throw error; }
  }
  async auxiliaryOptions(userId, options) {
    // Native compaction supplies the conversation's route but omits effort.
    // Keep its Host default when authorized; otherwise use an authorized effort
    // on that same route instead of making a valid member session uncompactable.
    if (options.purpose !== 'compaction' || options.reasoningEffort !== undefined) return options;
    const cut = this.capture(userId);
    try {
      const resolved = await this.#ctx.llm.resolveCallConfig(options);
      cut.assertCurrent();
      if (cut.routes.some(route => same(route, resolved))) return options;
      const matching = cut.routes.filter(route => route.provider === options.provider && route.model === options.model);
      const selected = matching.find(route => route.id === cut.defaultRouteId) ?? matching[0];
      if (!selected) denied();
      return { ...options, ...selectionOf(selected) };
    } finally { cut.close(); }
  }
  async selection(sessionId, requested, operation) {
    const userId = this.userOf(sessionId);
    if (!userId) return operation();
    const cut = await this.authorize(userId, requested);
    try { const result = await operation(); cut.assertCurrent(); return result; }
    finally { cut.close(); }
  }
  async initialize(agent, controller) {
    const userId = this.userOf(agent.id);
    if (!userId) return;
    const cut = this.capture(userId);
    try {
      const current = this.#ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.next;
      if (cut.routes.some(route => same(route, current))) return;
      const requested = current ?? this.#ctx.get('agentDefaultModel')?.currentSelection();
      const resolved = requested ? await this.#ctx.llm.resolveCallConfig(requested).catch(() => null) : null;
      cut.assertCurrent();
      const preferred = cut.routes.find(route => route.id === cut.defaultRouteId) ?? cut.routes.find(route => same(route, resolved)) ?? cut.routes[0];
      if (preferred) originalOf(controller).agents.selectForNextRequest(agent, selectionOf(preferred));
    } finally { cut.close(); }
  }
  catalog(userId, source) {
    const cut = this.capture(userId);
    try {
      const groups = source.groups.flatMap(group => {
        const models = group.models.flatMap(model => {
          const allowed = cut.routes.filter(route => route.provider === group.id && route.model === model.id);
          if (!allowed.length) return [];
          if (!model.reasoning) return [model];
          const efforts = model.reasoning.efforts.filter(effort => allowed.some(route => route.reasoningEffort === effort.id));
          const providerDefault = model.reasoning.defaultEffort === undefined && allowed.some(route => route.reasoningEffort === null);
          if (!efforts.length) {
            if (!providerDefault) return [];
            const { reasoning, ...defaultOnly } = model;
            return [defaultOnly];
          }
          const reasoning = { ...model.reasoning, efforts };
          if (providerDefault) delete reasoning.defaultEffort;
          else reasoning.defaultEffort = efforts.some(effort => effort.id === model.reasoning.defaultEffort) ? model.reasoning.defaultEffort : efforts[0].id;
          return [{ ...model, reasoning }];
        });
        return models.length ? [{ ...group, models }] : [];
      });
      const defaultModel = source.groups.find(group => group.id === source.default?.provider)?.models.find(model => model.id === source.default?.model);
      const hostDefault = source.default ? { ...source.default, reasoningEffort: source.default.reasoningEffort ?? defaultModel?.reasoning?.defaultEffort ?? null } : null;
      const preferred = cut.routes.find(route => route.id === cut.defaultRouteId) ?? cut.routes.find(route => same(route, hostDefault)) ?? cut.routes[0];
      cut.assertCurrent();
      return { ...source, groups, routableProviders: groups.map(group => group.id), default: preferred ? selectionOf(preferred) : { provider: '', model: '' }, failures: [] };
    } finally { cut.close(); }
  }
}

/** The native prepared-call seam owns both prepared and ordinary requests.
 * Keep its adapter registration, middleware, events and request brand intact;
 * change only the AbortSignal and enforce the effective model grant.
 */
export function installMemberModelStream(receiver, { models, limits, isAgentLoopRequest, markAgentLoopRequest }) {
  const runtime = originalOf(receiver), original = runtime.streamWithRegistration;
  if (typeof original !== 'function') throw new Error('Native model stream integration is unavailable');
  const wrapper = function(options, prepared) {
    const userId = models.requestUser(options);
    if (!userId) return original.call(this, options, prepared);
    const self = this;
    return (async function* () {
      if (!prepared) options = await models.auxiliaryOptions(userId, options);
      const cut = await models.authorize(userId, options, prepared?.config);
      let lease;
      try {
        lease = await limits?.stream(userId, options.sessionId);
        const request = { ...options, signal: options.signal ? AbortSignal.any([options.signal, cut.signal]) : cut.signal };
        if (isAgentLoopRequest(options)) markAgentLoopRequest(request);
        if (Object.isFrozen(options)) Object.freeze(request);
        cut.assertCurrent();
        for await (const chunk of original.call(self, request, prepared)) { cut.assertCurrent(); yield chunk; }
      } finally { lease?.close(); cut.close(); }
    })();
  };
  runtime.streamWithRegistration = wrapper;
  return () => { if (runtime.streamWithRegistration === wrapper) runtime.streamWithRegistration = original; };
}

/** Native selectModel also writes the deployment default. Member selections
 * use the SAME command and persistence for their Session, with that global save
 * suppressed. Owner selections retain the original behavior.
 */
export function installMemberModelSelection(receiver, { models }) {
  const controller = originalOf(receiver), original = controller.selectModel;
  if (typeof original !== 'function' || !controller.commands?.ctx) throw new Error('Native model selection integration is unavailable');
  const commands = controller.commands, context = commands.ctx;
  const defaults = new Proxy(context.agentDefaultModel, { get(target, key) { return key === 'saveSelection' ? async () => {} : Reflect.get(target, key, target); } });
  const viewContext = new Proxy(context, { get(target, key) { return key === 'agentDefaultModel' ? defaults : Reflect.get(target, key, target); } });
  const view = new Proxy(commands, { get(target, key) { return key === 'ctx' ? viewContext : Reflect.get(target, key, target); } });
  const wrapper = function(request) {
    if (!models.userOf(request.sessionId)) return original.call(this, request);
    return models.selection(request.sessionId, request, () => commands.selectModel.call(view, request));
  };
  controller.selectModel = wrapper;
  return () => { if (controller.selectModel === wrapper) controller.selectModel = original; };
}
