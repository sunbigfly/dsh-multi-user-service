import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordToolOrigins } from '../carrier/tool-origins.mjs';
import { installMemberResourceTools, installMemberMcpResources, installMemberMcpContext } from '../carrier/resources.mjs';
import { MemberCapabilities } from '../carrier/capabilities.mjs';
import { MemberModels } from '../carrier/models.mjs';
import { MemberOwnership } from '../carrier/access.mjs';
import { LanService, MemoryStore } from '../core/service.js';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('native Loader preserves owner tools but shared MCP and unisolated plugins stay closed to members', { skip: !modules, timeout: 30000 }, async t => {
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { default: Loader }, { ToolRuntime }, { createScope }] = await Promise.all(['cordis', 'cordis-plugin-loader', 'dsh-tools', 'dsh-scope'].map(load));
  const root = new Context(), directory = await mkdtemp(join(tmpdir(), 'dsh-resource-access-')), log = join(directory, 'calls.jsonl');
  const promptFiber = root.plugin((await load('dsh-system-prompt')).default, { includeHarnessIdentity: false, includeRuntimeContext: false }); await promptFiber.await();
  const loaderFiber = root.plugin(Loader, { baseUrl: pathToFileURL(join(modules, '@deepseek-ai/dsh/lib/index.js')).href }); await loaderFiber.await();
  let loader, origins, tools, resources;
  const setup = root.plugin({ inject: ['loader'], async apply(ctx) {
    loader = ctx.loader;
    loader.builtins['lan-origins'] = { apply(child) { origins = recordToolOrigins(ToolRuntime); child.effect(() => () => origins.dispose()); child.provide('lanToolOrigins', origins); } };
    loader.builtins.alpha = { inject: ['tools'], apply(child) { child.tools.register({ name: 'alpha', description: 'Synthetic plugin', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] }, execute(_args, exec) { exec.concludeTurn(); return 'ALPHA'; } }); } };
    const serverConfig = serverName => ({ transport: 'stdio', serverName, command: process.execPath, args: [resolve('verification/mcp-test-server.mjs'), serverName, log], failOnStartupError: true, reconnect: { enabled: false } });
    await loader.root.update([
      { id: 'alpha', name: 'cordis:alpha' },
      { id: 'red', name: '@deepseek-ai/dsh-mcp-client', config: serverConfig('red__team') },
      { id: 'blue', name: '@deepseek-ai/dsh-mcp-client', config: serverConfig('blue') },
      { id: 'resources', name: '@deepseek-ai/dsh-mcp-resources' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools', inject: ['lanToolOrigins'] },
      { id: 'origins', name: 'cordis:lan-origins' },
    ]);
    await Promise.all([...loader.entries()].map(entry => entry.fiber.await()));
    tools = ctx.get('tools'); resources = ctx.get('mcpResources');
  } }); await setup.await();
  const scopes = [], restores = [];
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose(); for (const restore of restores.reverse()) restore(); for (const entry of [...loader.entries()].reverse()) await entry.fiber?.dispose(); await setup.dispose(); await loaderFiber.dispose(); await promptFiber.dispose(); await rm(directory, { recursive: true }); });
  assert.equal(origins.get(tools.view().visible.get('alpha')).plugin, 'cordis:alpha');
  assert.equal(origins.get(tools.view().visible.get('mcp__red__team__echo')).mcpServer, 'red__team');
  assert.equal(origins.get(tools.view().visible.get('mcp__blue__echo')).plugin, '@deepseek-ai/dsh-mcp-client');
  const store = new MemoryStore(), cap = {}, core = new LanService({ store, hostCapability: cap }); await core.start(); await core.setModelCatalog([]); t.after(() => core.close());
  const password = 'synthetic-resource-password', login = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true, audience: 'owner' });
  const admin = { token: login.token, csrf: login.csrf, audience: 'owner' }, users = {}, agents = new Map(), ownership = await new MemberOwnership({ store: new MemoryStore() }).start();
  for (const name of ['alice', 'bob']) {
    users[name] = (await core.execute({ action: 'admin.createUser', username: name, displayName: name, password }, admin)).user.id;
    const agent = { id: 'session-' + name, session: { header: { cwd: join(directory, name) } } };
    const scope = createScope(root, agent); agent.ctx = scope.ctx; scopes.push(scope); agents.set(agent.id, agent);
    await ownership.record({ userId: users[name], sessionId: agent.id, projectId: 'workspace', cwd: agent.session.header.cwd });
  }
  const ctx = { agents: { get: id => agents.get(id), currentInitiator: () => undefined }, get: name => root.get(name) };
  const models = new MemberModels({ core, hostCapability: cap, ownership, ctx }), capabilities = new MemberCapabilities({ core, hostCapability: cap, ownership, ctx, origins });
  restores.push(installMemberResourceTools(tools, { models, capabilities, ownership, origins }), installMemberMcpResources(resources, { models, capabilities, ownership }), installMemberMcpContext(root.get('systemPrompt'), { models, capabilities, ownership }));
  const agent = name => agents.get('session-' + name);
  const originalAlpha = tools.get('alpha');
  const marker = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool');
  Object.defineProperty(originalAlpha, marker, { value: true });
  const update = (name, access) => updateAccount(core, { action: 'admin.updateUser', userId: users[name], access }, admin);
  const run = (name, tool, args = {}) => tools.execute({ agent: agent(name), name: tool, arguments: args, callId: 'resource-' + Date.now(), signal: AbortSignal.timeout(5000) });
  await update('alice', { plugins: ['cordis:alpha', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-mcp-resources'], mcpServers: ['red__team'] });
  await update('bob', { plugins: ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-mcp-resources'], mcpServers: ['blue'] });
  assert.equal(tools.view(agent('alice')).visible.has('alpha'), false, 'an administrator grant cannot turn unisolated host code into a member boundary');
  assert.equal(tools.get('alpha'), originalAlpha, 'native definition identity is retained for the trusted owner');
  assert.equal(originalAlpha[marker], true, 'non-enumerable native messaging marker survives');
  assert.equal(tools.schemas(agent('alice')).some(x => x.name === 'mcp__blue__echo'), false);
  assert.equal(tools.schemas(agent('bob')).some(x => x.name === 'alpha'), false);
  assert.equal((await run('alice', 'alpha')).isError, true);
  assert.equal((await run('bob', 'alpha')).isError, true);
  await assert.rejects(originalAlpha.execute({}, { agent: agent('bob') }), { code: 'MEMBER_RESOURCE_DENIED' }, 'cached definition uses executing account');
  let ownerConcluded = false;
  assert.equal(await originalAlpha.execute({}, { agent: { id: 'owner' }, concludeTurn() { ownerConcluded = true; } }), 'ALPHA');
  assert.equal(ownerConcluded, true, 'owner execution remains native after member view');
  await assert.rejects(originalAlpha.execute({}, { agent: agent('alice') }), { code: 'MEMBER_RESOURCE_DENIED' }, 'cached unisolated code stays denied for an authorized account');
  assert.equal((await run('alice', 'mcp__red__team__echo', { value: 'allowed' })).isError, true);
  assert.equal((await run('alice', 'mcp__blue__echo', { value: 'blocked' })).isError, true);
  await assert.rejects(resources.request('red__team', { method: 'resources/read', uri: 'test://red__team' }, { agent: agent('alice'), signal: AbortSignal.timeout(5000) }), { code: 'MEMBER_MCP_DENIED' });
  await assert.rejects(resources.request('blue', { method: 'resources/list' }, { agent: agent('alice') }), { code: 'MEMBER_MCP_DENIED' });
  const assembled = await root.get('systemPrompt').assemble({ scope: agent('alice') });
  assert.doesNotMatch(JSON.stringify(assembled.sections), /SYNTHETIC_red__team|SYNTHETIC_blue/);
  await update('alice', { mcpServers: [] });
  assert.equal((await run('bob', 'mcp__blue__echo', { value: 'unaffected' })).isError, true);
  assert.equal((await run('alice', 'mcp__red__team__echo', { value: 'revoked' })).isError, true);
  const ownerResource = await resources.request('red__team', { method: 'resources/read', uri: 'test://red__team' }, { agent: { id: 'owner' }, signal: AbortSignal.timeout(5000) });
  assert.match(JSON.stringify(ownerResource), /red__team:resource/);
  const traffic = await readFile(log, 'utf8'); assert.doesNotMatch(traffic, /"value":"blocked"|"value":"revoked"|"value":"allowed"|"value":"unaffected"/);
  await update('alice', { terminal: false });
  const restarted = new LanService({ store, hostCapability: cap }); await restarted.start(); t.after(() => restarted.close());
  assert.deepEqual(restarted.memberAccess(users.alice, cap).mcpServers, []);
  assert.deepEqual(restarted.memberAccess(users.alice, cap).plugins, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-mcp-resources', 'cordis:alpha']);
  assert.equal(tools.schemas().some(x => x.name === 'mcp__blue__echo'), true, 'owner registry unchanged');
});
