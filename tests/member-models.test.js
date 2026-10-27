import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { LanService, MemoryStore } from '../core/service.js';
import { ModelCatalog, modelVariantId } from '../runtime/model-catalog.mjs';
import { MemberOwnership } from '../carrier/access.mjs';
import { MemberModels, installMemberModelStream, installMemberModelSelection } from '../carrier/models.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const variants = [['think', 'low'], ['think', 'high'], ['plain', null]].map(([model, reasoningEffort]) => ({
  id: modelVariantId('fixture', model, reasoningEffort), provider: 'fixture', providerName: 'Synthetic', model, modelName: model,
  reasoningEffort, effortName: reasoningEffort, label: model + ' ' + reasoningEffort,
}));
const password = 'synthetic-member-model-contract';
const collect = async source => { const chunks = []; for await (const chunk of source) chunks.push(chunk); return chunks; };

async function accounts() {
  const cap = {}, store = new MemoryStore(), core = new LanService({ store, hostCapability: cap });
  await core.start(); await core.setProviderKeys(['fixture']); await core.setModelCatalog(variants);
  const owner = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true, audience: 'owner' });
  const admin = { token: owner.token, csrf: owner.csrf, audience: 'owner' }, users = {};
  for (const [name, route] of [['alice', variants[0]], ['bob', variants[1]]]) {
    const result = await core.execute({ action: 'admin.createUser', username: name, displayName: name, password, routeIds: [route.id], defaultRouteId: route.id }, admin);
    users[name] = result.user.id;
  }
  return { core, cap, store, admin, users, update: (name, routeIds) => updateAccount(core, { action: 'admin.updateUser', userId: users[name], routeIds }, admin) };
}

test('unconfigured accounts inherit host models; explicit custom empty grants deny and survive restart', async t => {
  const f = await accounts(); t.after(() => f.core.close());
  const { user } = await f.core.execute({ action: 'admin.createUser', username: 'inherited', displayName: 'Inherited', password }, f.admin);
  assert.equal(user.modelAccess, 'inherit');
  let cut = f.core.memberModels(user.id, f.cap);
  assert.equal(cut.routes.length, variants.length); assert.equal(cut.defaultRouteId, null);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: user.id, disabled: false }, f.admin);
  cut.assertCurrent();
  await updateAccount(f.core, { action: 'admin.updateUser', userId: user.id, modelAccess: 'custom', routeIds: [] }, f.admin);
  assert.equal(cut.signal.aborted, true); cut.close();
  cut = f.core.memberModels(user.id, f.cap); assert.deepEqual(cut.routes, []); cut.close();
  const state = await f.store.load();
  // Simulate the real old state: an unconfigured user and explicit nonempty grants.
  const legacy = state.users.find(row => row.id === user.id); delete legacy.modelAccess;
  delete state.users.find(row => row.id === f.users.alice).modelAccess;
  const cap = {}, core = new LanService({ store: new MemoryStore(state), hostCapability: cap });
  t.after(() => core.close()); await core.start(); await core.setProviderKeys(['fixture']); await core.setModelCatalog(variants);
  const inherited = core.memberModels(user.id, cap), custom = core.memberModels(f.users.alice, cap);
  assert.equal(inherited.modelAccess, 'inherit'); assert.equal(inherited.routes.length, variants.length);
  assert.equal(custom.modelAccess, 'custom'); assert.equal(custom.routes.length, 1);
  const added = { ...variants[2], id: modelVariantId('fixture', 'new', null), model: 'new' };
  await core.setModelCatalog([...variants, added]);
  assert.equal(inherited.signal.aborted, true); custom.assertCurrent();
  const fresh = core.memberModels(user.id, cap); assert.equal(fresh.routes.length, 4);
  inherited.close(); custom.close(); fresh.close();
  const explicitStore = new MemoryStore(state); state.users.find(row => row.id === user.id).modelAccess = 'custom'; await explicitStore.save(state);
  const denied = new LanService({ store: explicitStore, hostCapability: cap }); t.after(() => denied.close());
  await denied.start(); await denied.setProviderKeys(['fixture']); await denied.setModelCatalog(variants);
  cut = denied.memberModels(user.id, cap); assert.equal(cut.routes.length, 0); cut.close();
});

test('invitations default to inheritance and retain an explicit model disable', async t => {
  const f = await accounts(); t.after(() => f.core.close());
  for (const [name, policy, expected] of [['inv-inherit', {}, 'inherit'], ['inv-disabled', { modelAccess: 'custom', routeIds: [] }, 'custom']]) {
    const invitation = await f.core.execute({ action: 'admin.createInvite', ...policy }, f.admin);
    const login = await f.core.execute({ action: 'redeem', inviteToken: invitation.inviteToken, username: name, displayName: name, password }, { audience: 'member' });
    assert.equal(login.user.modelAccess, expected);
    const cut = f.core.memberModels(login.user.id, f.cap);
    assert.equal(cut.routes.length, expected === 'inherit' ? variants.length : 0); cut.close();
  }
  await assert.rejects(updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'all' }, f.admin), { code: 'INVALID_INPUT' });
});

test('registered and configurable provider directories use their actual distinct identity fields', async t => {
  const f = await accounts(); t.after(() => f.core.close());
  const models = new MemberModels({ core: f.core, hostCapability: f.cap, ownership: {}, ctx: {} });
  assert.deepEqual(models.providers(f.users.alice, [{ id: 'fixture' }, { id: 'denied' }]), [{ id: 'fixture' }]);
  assert.deepEqual(models.providers(f.users.alice, [{ provider: 'fixture', settingsNs: 'synthetic' }, { provider: 'denied' }]), [{ provider: 'fixture', settingsNs: 'synthetic' }]);
});

async function nativeFixture(t, { thinkingDefault = 'high' } = {}) {
  const f = await accounts();
  t.after(() => f.core.close());
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, brands] = await Promise.all([load('cordis'), load('dsh-llm')]);
  const root = new Context(), llmFiber = root.plugin(brands.default);
  await llmFiber.await();
  t.after(() => llmFiber.dispose());
  const agents = new Map(), ownership = await new MemberOwnership({ store: new MemoryStore() }).start();
  for (const name of ['alice', 'bob']) {
    const id = 'session-' + name, cwd = '/synthetic/' + name;
    agents.set(id, { id, session: { header: { cwd } } });
    await ownership.record({ userId: f.users[name], sessionId: id, projectId: 'workspace', cwd });
  }
  let llm, restore, hold = false;
  const calls = [], pending = new Map();
  class Adapter extends brands.LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, ...(id === 'think' ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], ...(thinkingDefault === null ? {} : { defaultEffort: thinkingDefault }) } } : {}) };
    }
    async *stream(options) {
      calls.push({ sessionId: options.sessionId, reasoningEffort: options.reasoningEffort, signal: options.signal, branded: brands.isAgentLoopRequest(options) });
      yield { type: 'text', text: 'synthetic-start' };
      if (hold) await new Promise((resolve, reject) => {
        const aborted = () => reject(options.signal.reason);
        const release = () => { options.signal.removeEventListener('abort', aborted); resolve(); };
        pending.set(options.sessionId, release);
        options.signal.addEventListener('abort', aborted, { once: true });
        if (options.signal.aborted) aborted();
      });
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const fiber = root.plugin({ inject: ['llm'], apply(ctx) {
    llm = ctx.llm;
    ctx.llm.registerAdapter(['fixture'], new Adapter());
  } });
  await fiber.await(); t.after(() => fiber.dispose());
  const agentsFiber = root.plugin((await load('dsh-agent')).default); await agentsFiber.await();
  t.after(() => agentsFiber.dispose());
  const ctx = { llm, agents: root.get('agents'), get: () => undefined };
  const models = new MemberModels({ core: f.core, hostCapability: f.cap, ownership, ctx });
  restore = installMemberModelStream(llm, { models, ...brands });
  t.after(restore);
  return { ...f, ctx, llm, brands, models, agents, ownership, calls, pending,
    hold() { hold = true; },
    request(sessionId, reasoningEffort) { return { provider: 'fixture', model: 'think', ...(reasoningEffort ? { reasoningEffort } : {}), sessionId, messages: [], signal: AbortSignal.timeout(10000) }; },
  };
}

test('account model grants retire only affected users, including failed writes and grant ABA', async t => {
  const f = await accounts(); t.after(() => f.core.close());
  assert.throws(() => f.core.memberModels(f.users.alice, {}), { code: 'FORBIDDEN' });
  const a = f.core.memberModels(f.users.alice, f.cap), b = f.core.memberModels(f.users.bob, f.cap);
  assert.deepEqual(a.routes.map(row => row.reasoningEffort), ['low']);
  assert.deepEqual(b.routes.map(row => row.reasoningEffort), ['high']);
  const save = f.store.save.bind(f.store);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.store.save = async () => { entered(); await gate; throw new Error('synthetic persistence failure'); };
  const updating = f.update('alice', []), failed = assert.rejects(updating, { code: 'STORAGE_FAILURE' });
  await ready;
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, false);
  assert.throws(() => f.core.memberModels(f.users.alice, f.cap), { code: 'MODEL_DENIED' });
  b.assertCurrent();
  release(); await failed; f.store.save = save;
  assert.throws(a.assertCurrent, { code: 'MODEL_DENIED' });
  const fresh = f.core.memberModels(f.users.alice, f.cap);
  await f.core.setProviderKeys(['fixture']); await f.core.setModelCatalog(variants);
  fresh.assertCurrent(); b.assertCurrent();
  await f.update('alice', []); await f.update('alice', [variants[0].id]);
  assert.throws(fresh.assertCurrent, { code: 'MODEL_DENIED' }); b.assertCurrent();
  a.close(); b.close(); fresh.close();
});

test('account grants restore for native background Sessions without browser credentials', async t => {
  const f = await accounts(), id = f.users.alice;
  const cut = f.core.memberModels(id, f.cap); await f.core.close();
  assert.equal(cut.signal.aborted, true);
  const cap = {}, restarted = new LanService({ store: f.store, hostCapability: cap });
  t.after(() => restarted.close());
  await restarted.start(); await restarted.setProviderKeys(['fixture']); await restarted.setModelCatalog(variants);
  const restored = restarted.memberModels(id, cap);
  assert.deepEqual(restored.routes.map(row => row.reasoningEffort), ['low']);
  restored.close();
});

test('real native LLM prepared and direct streams enforce exact model variants and retain request branding', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t);
  const prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'think', reasoningEffort: 'low' });
  const request = Object.freeze(f.brands.markAgentLoopRequest({ ...prepared.config, sessionId: 'session-alice', messages: [], signal: AbortSignal.timeout(10000) }));
  assert.equal((await collect(prepared.stream(request))).at(-1).reason.kind, 'stop');
  assert.equal(f.calls[0].branded, true);
  await assert.rejects(collect(f.llm.stream(f.request('session-alice', 'high'))), { code: 'MEMBER_MODEL_DENIED' });
  await assert.rejects(collect(f.llm.stream(f.request('session-alice'))), { code: 'MEMBER_MODEL_DENIED' });
  assert.equal(f.calls.length, 1, 'forbidden model never dispatches to the native adapter');
  await collect(f.llm.stream(f.request('session-bob', 'high')));
  await collect(f.llm.stream(f.request('owner-session', 'high')));
  assert.equal(f.calls.length, 3, 'Bob and owner retain their normal native path');
  assert.throws(() => f.models.forTool(f.agents.get('session-alice'), () => f.llm.stream(f.request('session-bob', 'high'))), { code: 'MEMBER_MODEL_DENIED' });
  await f.models.forTool(f.agents.get('session-alice'), () => f.ctx.agents.withoutInitiator(async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    await collect(f.llm.stream(f.request('session-bob', 'high')));
  }));
  assert.equal(f.calls.at(-1).sessionId, 'session-bob', 'native shared timer clearing must also clear member tool attribution');
  await collect(f.llm.stream({ ...f.request('session-alice'), purpose: 'compaction' }));
  assert.equal(f.calls.at(-1).reasoningEffort, 'low', 'native compaction may use an authorized effort on its existing route');
  await assert.rejects(collect(f.llm.stream({ ...f.request('session-alice', 'high'), purpose: 'compaction' })), { code: 'MEMBER_MODEL_DENIED' }, 'explicit unauthorized effort stays denied');
});

test('real native in-flight revocation aborts Alice adapter while Bob remains active', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t); f.hold();
  const alice = f.llm.stream(f.request('session-alice', 'low'))[Symbol.asyncIterator]();
  const bob = f.llm.stream(f.request('session-bob', 'high'))[Symbol.asyncIterator]();
  assert.equal((await alice.next()).value.text, 'synthetic-start');
  assert.equal((await bob.next()).value.text, 'synthetic-start');
  const a = alice.next(), b = bob.next(), rejected = assert.rejects(a, { code: 'MODEL_DENIED' });
  await f.update('alice', []); await rejected;
  assert.equal(f.calls.find(row => row.sessionId === 'session-alice').signal.aborted, true);
  assert.equal(f.calls.find(row => row.sessionId === 'session-bob').signal.aborted, false);
  f.pending.get('session-bob')();
  assert.equal((await b).value.reason.kind, 'stop');
  await bob.return();
});

test('native catalogs expose only each account model and reasoning grants', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t);
  const source = { default: { provider: 'fixture', model: 'think', reasoningEffort: 'high' }, routableProviders: ['fixture'], failures: [], groups: [
    { id: 'fixture', name: 'Synthetic', models: [{ id: 'think', name: 'Thinking', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }, { id: 'plain', name: 'Plain' }] },
  ] };
  const original = structuredClone(source), a = f.models.catalog(f.users.alice, source), b = f.models.catalog(f.users.bob, source);
  assert.deepEqual(a.groups[0].models[0].reasoning.efforts.map(row => row.id), ['low']);
  assert.equal(a.default.reasoningEffort, 'low');
  assert.deepEqual(b.groups[0].models[0].reasoning.efforts.map(row => row.id), ['high']);
  assert.deepEqual(source, original);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'inherit' }, f.admin);
  delete source.default.reasoningEffort;
  const inherited = f.models.catalog(f.users.alice, source);
  assert.equal(inherited.default.reasoningEffort, 'high');
  assert.equal(inherited.groups[0].models.length, 2);
});

test('new native Sessions inherit the resolved host default and retain an allowed existing choice', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t), selections = [];
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'inherit' }, f.admin);
  let next;
  f.ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fixture', model: 'think' }) } : name === 'sessionProjections' ? { stateOf: () => ({ next }) } : undefined;
  const controller = { agents: { selectForNextRequest: (_, choice) => selections.push(choice) } }, agent = f.agents.get('session-alice');
  await f.models.initialize(agent, controller);
  assert.deepEqual(selections, [{ provider: 'fixture', model: 'think', reasoningEffort: 'high' }]);
  next = { provider: 'fixture', model: 'think', reasoningEffort: 'low' };
  await f.models.initialize(agent, controller); assert.equal(selections.length, 1);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'custom', routeIds: [] }, f.admin);
  await f.models.initialize(agent, controller); assert.equal(selections.length, 1);
  assert.throws(() => f.models.assertAvailable(f.users.alice), { code: 'MEMBER_MODEL_DENIED' });
  f.models.assertAvailable(f.users.bob);
  await assert.rejects(collect(f.llm.stream(f.request('session-alice', 'high'))), { code: 'MEMBER_MODEL_DENIED' });
  assert.equal(f.calls.length, 0);
});

test('selection adapter keeps native member Session changes and owner deployment saves separate', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t), saved = [], selected = [];
  const commands = { ctx: { agentDefaultModel: { async saveSelection(request) { saved.push(request); } } },
    async selectModel(request) { selected.push(request); await this.ctx.agentDefaultModel.saveSelection(request); return { selected: request }; } };
  const controller = { commands, selectModel(request) { return this.commands.selectModel(request); } }, original = controller.selectModel;
  const restore = installMemberModelSelection(controller, { models: f.models }); t.after(restore);
  await controller.selectModel({ sessionId: 'session-alice', provider: 'fixture', model: 'think', reasoningEffort: 'low' });
  assert.equal(selected.length, 1); assert.equal(saved.length, 0);
  await assert.rejects(controller.selectModel({ sessionId: 'session-alice', provider: 'fixture', model: 'think', reasoningEffort: 'high' }), { code: 'MEMBER_MODEL_DENIED' });
  assert.equal(selected.length, 1);
  await controller.selectModel({ sessionId: 'owner-session', provider: 'fixture', model: 'think', reasoningEffort: 'high' });
  assert.equal(saved.length, 1);
  restore(); assert.equal(controller.selectModel, original);
});

test('custom reasoning models keep their provider-default choice within exact account grants', { skip: !modules, timeout: 30000 }, async t => {
  const f = await nativeFixture(t, { thinkingDefault: null });
  const metadata = await f.llm.resolveModelInfo('fixture', 'think');
  assert.equal(metadata.reasoning.defaultEffort, undefined);
  const catalog = new ModelCatalog({ llm: {
    listProviders: () => [{ id: 'fixture', name: 'Synthetic' }],
    listModels: () => [{ provider: 'fixture', id: 'think' }],
    resolveModelInfo: () => metadata,
  } });
  const routes = await catalog.refresh();
  assert.deepEqual(routes.map(route => route.reasoningEffort).sort(), [null, 'high', 'low'].sort());
  await f.core.setModelCatalog(routes);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'inherit' }, f.admin);
  const source = { groups: [{ id: 'fixture', name: 'Synthetic', models: [metadata] }], default: { provider: 'fixture', model: 'think' } };
  const inherited = f.models.catalog(f.users.alice, source);
  assert.equal(inherited.groups[0].models[0].reasoning.defaultEffort, undefined);
  const cut = await f.models.authorize(f.users.alice, source.default); cut.close();
  assert.equal(f.calls.length, 0, 'selection authorization does not invoke a provider');

  const fallback = routes.find(route => route.reasoningEffort === null);
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'custom', routeIds: [fallback.id], defaultRouteId: fallback.id }, f.admin);
  const onlyDefault = f.models.catalog(f.users.alice, source);
  assert.equal(onlyDefault.groups[0].models[0].reasoning, undefined);
  const defaultCut = await f.models.authorize(f.users.alice, source.default); defaultCut.close();
  await assert.rejects(f.models.authorize(f.users.alice, { ...source.default, reasoningEffort: 'high' }), { code: 'MEMBER_MODEL_DENIED' });

  const high = routes.find(route => route.reasoningEffort === 'high');
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, modelAccess: 'custom', routeIds: [high.id], defaultRouteId: high.id }, f.admin);
  const restricted = f.models.catalog(f.users.alice, source);
  assert.equal(restricted.groups[0].models[0].reasoning.defaultEffort, 'high');
  await assert.rejects(f.models.authorize(f.users.alice, source.default), { code: 'MEMBER_MODEL_DENIED' });
  const highCut = await f.models.authorize(f.users.alice, { ...source.default, reasoningEffort: 'high' }); highCut.close();
  assert.deepEqual(metadata.reasoning.efforts.map(effort => effort.id), ['low', 'high']);
});
