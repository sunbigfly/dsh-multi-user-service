import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanService, MemoryStore } from '../core/service.js';
import { MemberOwnership } from '../carrier/access.mjs';
import { MemberModels } from '../carrier/models.mjs';
import { MemberCapabilities } from '../carrier/capabilities.mjs';
import { installMemberAgentPresets } from '../carrier/presets.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
async function fixture(t) {
  const cap = {}, store = new MemoryStore(), core = new LanService({ store, hostCapability: cap });
  await core.start(); await core.setModelCatalog([]); t.after(() => core.close());
  const password = 'synthetic-agent-preset-password';
  const login = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true, audience: 'owner' });
  const admin = { token: login.token, csrf: login.csrf, audience: 'owner' }, users = {}, agents = new Map();
  const ownership = await new MemberOwnership({ store: new MemoryStore() }).start();
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { createScope, scopeOf }, { default: Loader }, { default: Presets }] = await Promise.all(['cordis', 'dsh-scope', 'cordis-plugin-loader', 'dsh-agent-preset-registry'].map(load));
  const root = new Context(), fibers = [], scopes = [], disposers = [];
  root.provide('sessionProjections', { register() {}, stateOf(session, key) { return key === 'turnBoundary' ? { openTurnStartSeq: null, lastTurn: 0 } : key === 'agentPreset' ? session.preset : undefined; } });
  for (const [plugin, config] of [[Loader, {}], [Presets, { default: 'standard' }]]) { const fiber = root.plugin(plugin, config); await fiber.await(); fibers.push(fiber); }
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose(); for (const dispose of disposers.reverse()) await dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); });
  let registry;
  const harness = root.plugin({ inject: ['agentPresets'], async apply(ctx) {
    registry = ctx.agentPresets;
    for (const id of ['standard', 'ptc']) disposers.push(await registry.register({ id, name: id, plugins: [] }));
    for (const name of ['alice', 'bob', 'owner']) {
      if (name !== 'owner') users[name] = (await core.execute({ action: 'admin.createUser', username: name, displayName: name, password }, admin)).user.id;
      const agent = { id: 'session-' + name, session: { id: 'session-' + name, header: { cwd: '/synthetic/' + name }, append(type, data) { if (type === 'agent-preset/selected') this.preset = data.agentPreset; } } };
      const scope = createScope(ctx, agent); agent.ctx = scope.ctx; scopes.push(scope); agents.set(agent.id, agent);
      if (users[name]) await ownership.record({ userId: users[name], sessionId: agent.id, projectId: 'workspace', cwd: agent.session.header.cwd });
    }
  } }); await harness.await(); fibers.push(harness);
  const ctx = { agents: { get: id => agents.get(id), currentInitiator: () => undefined }, get: name => name === 'agentPresets' ? registry : undefined };
  const models = new MemberModels({ core, hostCapability: cap, ownership, ctx }), capabilities = new MemberCapabilities({ core, hostCapability: cap, ownership, ctx });
  const restore = installMemberAgentPresets(registry, { scopeOf, models, capabilities, ownership }); disposers.push(restore);
  return { core, cap, store, users, registry, models, capabilities, agent: name => agents.get('session-' + name), updateAccess: (name, access) => updateAccount(core, { action: 'admin.updateUser', userId: users[name], access }, admin), update: (name, agentPresets) => updateAccount(core, { action: 'admin.updateUser', userId: users[name], access: { agentPresets } }, admin) };
}

test('native Agent presets enforce per-account creation, direct selection, default choice and revocation', { skip: !modules }, async t => {
  const f = await fixture(t); await f.update('alice', ['ptc']);
  const catalog = await f.registry.remoteExportList(); assert.equal(catalog.presets.some(row => row.broken), false, JSON.stringify(catalog));
  assert.deepEqual(f.capabilities.agentPresetCatalog(f.users.alice, catalog).presets.map(row => [row.id, row.isDefault]), [['ptc', true]]);
  assert.equal(await f.capabilities.chooseAgentPreset(f.users.alice), 'ptc'); assert.equal(f.registry.defaultId, 'standard');
  await assert.rejects(f.registry.mount(f.agent('alice').ctx, 'standard'), { code: 'MEMBER_CAPABILITY_DENIED' });
  assert.equal((await f.registry.mount(f.agent('alice').ctx, 'ptc')).id, 'ptc');
  await assert.rejects(f.registry.select(f.agent('alice'), 'standard'), { code: 'MEMBER_CAPABILITY_DENIED' });
  assert.equal((await f.registry.mount(f.agent('bob').ctx, 'standard')).id, 'standard');
  assert.equal(await f.registry.select(f.agent('bob'), 'ptc'), 'ptc');
  assert.equal((await f.registry.mount(f.agent('owner').ctx, 'standard')).id, 'standard');
  await f.update('alice', []);
  await assert.rejects(f.registry.select(f.agent('alice'), 'ptc'), { code: 'MEMBER_CAPABILITY_DENIED' });
  await assert.rejects(f.capabilities.chooseAgentPreset(f.users.alice), { code: 'MEMBER_CAPABILITY_DENIED' });
  assert.throws(() => f.registry.composeFrom(f.agent('alice').ctx, f.agent('bob').ctx), { code: 'MEMBER_CAPABILITY_DENIED' });
  assert.equal(await f.registry.select(f.agent('bob'), 'standard'), 'standard');
  await f.updateAccess('alice', { terminal: false });
  assert.deepEqual(f.capabilities.policy(f.users.alice).agentPresets, []);
  const restarted = new LanService({ store: f.store, hostCapability: f.cap }); await restarted.start(); t.after(() => restarted.close());
  assert.deepEqual(restarted.memberAccess(f.users.alice, f.cap).agentPresets, []);
});
