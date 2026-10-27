import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanService, MemoryStore } from '../core/service.js';
import { accountAccess } from '../core/validation.js';
import { MemberCapabilities, installMemberScheduleAdmission } from '../carrier/capabilities.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('reminder admission reads current account grants before native inbox insertion', () => {
  const grants = new Map([['a', true], ['b', true]]), calls = [];
  const capabilities = { userOf: agent => grants.has(agent.id) ? agent.id : undefined, policy: id => ({ tasks: grants.get(id) }) };
  const a = { id: 'a', followup(input) { calls.push([this.id, input]); return input; } };
  const b = { ...a, id: 'b' }, owner = { ...a, id: 'owner' };
  const originals = [a.followup, b.followup, owner.followup];
  const restores = [a, b, owner].map(agent => installMemberScheduleAdmission(agent, capabilities));
  const reminder = { source: { kind: 'schedule' }, content: [] };
  assert.equal(a.followup(reminder), reminder);
  grants.set('a', false);
  assert.throws(() => a.followup(reminder), { code: 'MEMBER_CAPABILITY_DENIED' });
  b.followup(reminder); owner.followup(reminder);
  a.followup({ source: { kind: 'user' }, content: [] });
  assert.deepEqual(calls.map(x => x[0]), ['a', 'b', 'owner', 'a']);
  restores.forEach(restore => restore());
  assert.deepEqual([a.followup, b.followup, owner.followup], originals);
});
async function accounts(t) {
  const store = new MemoryStore(), cap = {}, core = new LanService({ store, hostCapability: cap });
  await core.start(); t.after(() => core.close());
  const password = 'synthetic-capability-contract';
  const login = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true, audience: 'owner' });
  const admin = { token: login.token, csrf: login.csrf, audience: 'owner' };
  const users = {};
  for (const username of ['alice', 'bob']) users[username] = (await core.execute({ action: 'admin.createUser', username, displayName: username, password }, admin)).user.id;
  return { store, core, cap, users, admin, update: access => updateAccount(core, { action: 'admin.updateUser', userId: users.alice, access }, admin) };
}

test('account capabilities persist explicit disables, default old accounts to inheritance, and reject invalid grants', async t => {
  const f = await accounts(t);
  assert.equal(f.core.memberAccess(f.users.alice, f.cap).tools, null);
  await f.update({ terminal: false, tools: [] });
  assert.equal(f.core.memberAccess(f.users.alice, f.cap).terminal, false);
  assert.equal(f.core.memberAccess(f.users.bob, f.cap).terminal, true);
  const restored = new LanService({ store: f.store, hostCapability: f.cap }); await restored.start(); t.after(() => restored.close());
  assert.deepEqual(restored.memberAccess(f.users.alice, f.cap), accountAccess({ terminal: false, tools: [] }));
  assert.throws(() => restored.memberAccess(f.users.alice, {}), { code: 'FORBIDDEN' });
  for (const access of [{ tools: ['read', 'read'] }, { tools: ['bad name'] }, { terminal: 1 }, { arbitrary: true }]) await assert.rejects(f.update(access), { code: 'INVALID_INPUT' });
  const invitation = await f.core.execute({ action: 'admin.createInvite', access: { terminal: false, tools: [] } }, f.admin);
  const invited = await f.core.execute({ action: 'redeem', inviteToken: invitation.inviteToken, username: 'invited', displayName: 'Invited', password: 'synthetic-invite-password' }, { audience: 'member' });
  assert.deepEqual(f.core.memberAccess(invited.user.id, f.cap), accountAccess({ terminal: false, tools: [] }));
  await updateAccount(f.core, { action: 'admin.updateUser', userId: f.users.alice, disabled: true }, f.admin);
  assert.throws(() => f.core.memberAccess(f.users.alice, f.cap), { code: 'FORBIDDEN' });
});

test('pending capability writes close the authorization boundary even without a model catalog', async t => {
  const f = await accounts(t), save = f.store.save.bind(f.store);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.store.save = async state => { entered(); await gate; return save(state); };
  const update = f.update({ terminal: false }); await ready;
  assert.throws(() => f.core.memberAccess(f.users.alice, f.cap), { code: 'FORBIDDEN' });
  assert.equal(f.core.memberAccess(f.users.bob, f.cap).terminal, true);
  release(); await update;
  assert.equal(f.core.memberAccess(f.users.alice, f.cap).terminal, false);
});

test('real native tools inherit newly registered capabilities; current account grants guard scoped tools and PTC dispatch', { skip: !modules, timeout: 30000 }, async t => {
  const f = await accounts(t);
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { ToolRuntime }, { createScope }] = await Promise.all(['cordis', 'dsh-tools', 'dsh-scope'].map(load));
  const root = new Context(); root.provide('systemPrompt', { tools() {}, section() {} });
  const runtime = root.plugin(ToolRuntime); await runtime.await(); t.after(() => runtime.dispose());
  let ctx, agent, bob, memberScope, bobScope, calls = 0;
  const ownership = { ownerOf: id => id === 'alice' ? f.users.alice : id === 'bob' ? f.users.bob : undefined, bindingForCwd: () => undefined };
  const capabilities = new MemberCapabilities({ core: f.core, hostCapability: f.cap, ownership });
  const fiber = root.plugin({ inject: ['tools'], apply(child) {
    ctx = child; agent = { id: 'alice', session: { header: { cwd: '/synthetic/alice' } } }; bob = { id: 'bob', session: { header: { cwd: '/synthetic/bob' } } };
    memberScope = createScope(child, agent); bobScope = createScope(child, bob);
    memberScope.ctx.tools.restrict({ deny: [] });
    memberScope.ctx.tools.guard(exec => capabilities.toolDenial(exec, 'workspace-write'));
    bobScope.ctx.tools.guard(exec => capabilities.toolDenial(exec, 'workspace-write'));
  } });
  await fiber.await(); t.after(async () => { await memberScope.dispose(); await bobScope.dispose(); await fiber.dispose(); });
  const register = (scope, name) => scope.tools.register({ name, description: 'Synthetic shared capability', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] }, execute() { calls++; return 'capability-ok'; } });
  register(ctx, 'new_shared_plugin_tool'); register(memberScope.ctx, 'local_agent_tool');
  assert.ok(ctx.tools.schemas(agent).some(row => row.name === 'new_shared_plugin_tool'));
  const run = (name, caller = agent) => ctx.tools.execute({ callId: 'capability-' + Date.now(), agent: caller, name, arguments: {}, signal: AbortSignal.timeout(5000) });
  await run('new_shared_plugin_tool'); assert.equal(calls, 1);
  await f.update({ tools: [] });
  await run('new_shared_plugin_tool'); await run('local_agent_tool'); assert.equal(calls, 1, 'native scoped registration cannot bypass the account guard');
  await run('new_shared_plugin_tool', bob); assert.equal(calls, 2);
  await f.update({ tools: ['new_shared_plugin_tool'] });
  await run('new_shared_plugin_tool'); assert.equal(calls, 3);
  assert.equal(capabilities.toolAllowed(accountAccess({ tools: [] }), 'run_code'), false, 'custom tool denial also covers direct program execution');
  assert.equal(capabilities.toolAllowed(accountAccess({ tools: ['run_code'] }), 'run_code'), true);
  await f.update({ tools: null });
  assert.match(capabilities.toolDenial({ agent, name: 'plugin_manager', arguments: { action: 'install_bundle' } }, 'workspace-write'), /administrator/);
  assert.equal(capabilities.toolDenial({ agent, name: 'plugin_manager', arguments: { action: 'list_plugins' } }, 'workspace-write'), undefined);
});

test('feature switches reject corresponding native API and stream endpoints', async t => {
  const f = await accounts(t), capabilities = new MemberCapabilities({ core: f.core, hostCapability: f.cap });
  await f.update({ terminal: false, files: false, attachments: false, tasks: false, subagents: false, interactions: false });
  for (const endpoint of ['terminal/create', 'terminal/attach', 'workspaceFiles/changes', 'workspaceFiles/read', 'session/uploadFileBinary', 'schedule/catalog', 'session/fork', 'userQuestions/answer']) {
    assert.throws(() => capabilities.assertEndpoint(f.users.alice, endpoint), { code: 'MEMBER_CAPABILITY_DENIED' });
    capabilities.assertEndpoint(f.users.bob, endpoint);
  }
  for (const name of ['bash', 'read', 'run_code', 'subagent', 'list_agents', 'send_message', 'interrupt_agent', 'schedule_create', 'job_output', 'ask_user_question']) assert.equal(capabilities.toolAllowed(f.core.memberAccess(f.users.alice, f.cap), name), false, name);
});
