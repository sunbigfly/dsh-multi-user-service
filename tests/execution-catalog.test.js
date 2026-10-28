import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ExecutionCatalog, executionConfiguration } from '../carrier/execution-catalog.mjs';
import { executionToolsDefinition, runNativeExecutionTool } from '../carrier/execution-tools.mjs';
import { createMemberBoundary, installMemberBoundary } from '../carrier/member-boundary.mjs';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';

const uid = 'usr_' + 'e'.repeat(32);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-execution-catalog-'));t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['bin', 'tools/example-cli', 'plugins/synthetic']) await mkdir(join(root, path), { recursive: true });
  const command = join(root, 'bin/runner');
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let denied=false;try{fs.readFileSync(args[args.indexOf('--query')+1]);}catch{denied=true;}console.log(JSON.stringify({status:'ok',args,denied,cwd:process.cwd(),home:process.env.HOME,tmp:process.env.TMPDIR,config:process.env.XDG_CONFIG_HOME,cache:process.env.XDG_CACHE_HOME,hostCredential:process.env.DSH_EXECUTION_HOST_CANARY??null}));\n`, { mode: 0o755 });
  const toolPath = join(root, 'tools/example-cli/tool.toml');
  const manifest = '[tool]\nenabled=true\nplugin="synthetic"\ndescription="Synthetic local routing tool"\nskill="own-search-skill"\n[operations.route]\nenabled=true\ndescription="Route locally without a network call"\n[operations.route.parameters.scope]\ntype="path"\nrequired=true\n[operations.route.parameters.query]\ntype="string"\nrequired=true\n[operations.search]\nenabled=false\ndescription="Disabled operation"\n';
  await writeFile(toolPath, manifest);
  const pluginPath = join(root, 'plugins/synthetic/plugin.json');
  await writeFile(pluginPath, JSON.stringify({ lifecycle: 'one-shot', plugin_binary: process.execPath, upstream_executable: process.execPath, timeout_seconds: 5 }));
  const source = { id: 'fixture', kind: 'tool-runner', root, command };
  const initial = new ExecutionCatalog({ sources: [source] }), inventory = await initial.scan(), tool = inventory.tools[0];
  assert.equal(inventory.errors.length, 0);assert.ok(tool);
  const grant = { id: tool.id, fingerprint: tool.fingerprint, operations: ['route'], harness: true, shared: true };
  return { root, command, toolPath, pluginPath, source, tool, manifest, grant, catalog: new ExecutionCatalog({ sources: [source], grants: [grant] }) };
}
test('discovery reads complete local usage without running programs or changing user Skills', async t => {
  const f = await fixture(t), skill = join(f.root, 'SKILL.md');await writeFile(skill, 'User-owned skill.');
  // An unusable program still has a readable catalog; scanning never runs it.
  await writeFile(f.command, '#!/missing/interpreter\nthrow new Error("must not execute");\n', { mode: 0o755 });
  const inventory = await f.catalog.scan();assert.equal(inventory.tools.length, 1);
  const tool = inventory.tools[0];assert.equal(tool.skill, 'own-search-skill');
  assert.deepEqual(tool.operations.map(row => row.id), ['route', 'search']);assert.equal(tool.operations[0].parameters.scope.required, true);
  assert.equal(tool.operations[1].enabled, false);assert.equal(await readFile(skill, 'utf8'), 'User-owned skill.');
  const publicTool = f.catalog.publicInventory(inventory).tools[0];assert.ok(publicTool.readOnlyPaths.length);assert.equal('runtime' in publicTool, false);
});
test('whitelist separates Harness use, member sharing, member selection and permitted operations', async t => {
  const f = await fixture(t);await f.catalog.validateGrants();
  assert.equal((await f.catalog.allowed()).length, 1);
  assert.equal((await f.catalog.allowed({ member: true, policy: { cliTools: null } })).length, 1);
  assert.equal((await f.catalog.allowed({ member: true, policy: { cliTools: [] } })).length, 0);
  assert.equal((await f.catalog.allowed({ member: true, policy: { cliTools: [f.tool.id], files: false } })).length, 0);
  assert.deepEqual(f.catalog.describe((await f.catalog.allowed())[0]).operations.map(row => row.id), ['route']);
  const privateCatalog = new ExecutionCatalog({ sources: [f.source], grants: [{ ...f.grant, shared: false }] });
  assert.equal((await privateCatalog.allowed({ member: true, policy: { cliTools: null } })).length, 0);
  assert.equal((await privateCatalog.allowed({ member: true, administrator: true, policy: { cliTools: null } })).length, 1);
});
test('changed manifests invalidate authorization; unsupported member sharing and unknown operations fail closed', async t => {
  const f = await fixture(t);await writeFile(f.toolPath, f.manifest.replace('Route locally', 'Updated routing'));
  assert.equal((await f.catalog.allowed()).length, 0);await assert.rejects(f.catalog.validateGrants(), { code: 'EXECUTION_TOOL_CHANGED' });
  const scan = await f.catalog.scan(), current = scan.tools[0];
  const unknown = new ExecutionCatalog({ sources: [f.source], grants: [{ ...f.grant, fingerprint: current.fingerprint, operations: ['unknown'] }] });
  await assert.rejects(unknown.validateGrants(), { code: 'EXECUTION_TOOL_CHANGED' });
  await writeFile(f.pluginPath, JSON.stringify({ lifecycle: 'managed-daemon', plugin_binary: process.execPath, upstream_executable: process.execPath }));
  const daemon = (await f.catalog.scan()).tools[0];assert.ok(daemon.sharingIssue);
  const shared = new ExecutionCatalog({ sources: [f.source], grants: [{ ...f.grant, fingerprint: daemon.fingerprint }] });
  await assert.rejects(shared.validateGrants(), { code: 'EXECUTION_TOOL_NOT_ISOLATED' });
});
test('generic configuration round trips and rejects duplicate identities, unknown fields and unsupported versions', async t => {
  const f = await fixture(t), config = f.catalog.configuration;
  assert.deepEqual(executionConfiguration(JSON.parse(JSON.stringify(config))), config);
  for (const invalid of [{ ...config, version: 2 }, { ...config, sources: [f.source, f.source] }, { ...config, grants: [f.grant, f.grant] }, { ...config, environment: { HOME: '/tmp' } }]) assert.throws(() => executionConfiguration(invalid), { code: 'INVALID_INPUT' });
});
test('partial native confinement never starts a member tool', async () => {
  let spawned = false;
  const context = { get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) };
    if (name === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'partial' }) };
    if (name === 'subprocess') return { spawn() { spawned = true; } };
  } };
  await assert.rejects(runNativeExecutionTool({ argv: ['/usr/bin/true'], cwd: '/tmp', tool: { runtime: { timeoutMs: 1000 } }, exec: { agent: { session: {} } }, context, principal: { member: true } }), { code: 'EXECUTION_TOOL_UNAVAILABLE' });
  assert.equal(spawned, false);
});
test('native tool dispatch rejects unapproved tools and operations before spawning and preserves literal input', async t => {
  const f = await fixture(t);let calls = 0, request;
  const definition = executionToolsDefinition({ catalogOf: () => f.catalog, principalOf: () => ({ member: true, policy: { cliTools: [f.tool.id] } }), workspaceOf: async () => f.root,
    run: async value => { calls++;request = value;return { ok: true }; } });
  const exec = { signal: new AbortController().signal };
  await assert.rejects(definition.execute({ action: 'run', id: 'fixture/other', operation: 'route', query: 'x' }, exec), { code: 'EXECUTION_TOOL_DENIED' });
  await assert.rejects(definition.execute({ action: 'run', id: f.tool.id, operation: 'search', query: 'x' }, exec), { code: 'EXECUTION_OPERATION_DENIED' });
  assert.equal(calls, 0);
  const query = 'spaces; $(literal)\nsecond line';
  await definition.execute({ action: 'run', id: f.tool.id, operation: 'route', query, arguments: { text: 'literal' } }, exec);
  assert.equal(calls, 1);assert.equal(request.argv[request.argv.indexOf('--query') + 1], query);
  assert.deepEqual(request.argv.slice(1, 4), ['run', 'example-cli', 'route']);
  await assert.rejects(readFile(request.argv[request.argv.indexOf('--arguments-file') + 1]), { code: 'ENOENT' });
});
test('revocation while a tool runs suppresses the completed result', async t => {
  const f = await fixture(t);let catalog = f.catalog;
  const definition = executionToolsDefinition({ catalogOf: () => catalog, principalOf: () => ({}), workspaceOf: async () => f.root,
    run: async () => { catalog = new ExecutionCatalog({ sources: [f.source] });return { private: 'must not return' }; } });
  await assert.rejects(definition.execute({ action: 'run', id: f.tool.id, operation: 'route', query: 'x' }, { signal: new AbortController().signal }), { code: 'EXECUTION_TOOL_DENIED' });
});
test('managed runner uses the real native member boundary and cannot read host or other-member files', { skip: !process.env.DSH_LAN_CONTRACT_MODULES }, async t => {
  const f = await fixture(t), home = join(f.root, uid), other = join(f.root, 'usr_' + 'f'.repeat(32));
  await mkdir(home, { mode: 0o700 });await mkdir(other, { mode: 0o700 });const cwd = join(home, 'workspace');await mkdir(cwd);
  const secret = join(f.root, 'host-secret');await writeFile(secret, 'secret');await writeFile(join(other, 'secret'), 'other');
  const require = createRequire(join(process.env.DSH_LAN_CONTRACT_MODULES, '@deepseek-ai/dsh/package.json'));
  const native = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/landlock-run')).href);
  const boundary = await createMemberBoundary({ native });
  const definition = executionToolsDefinition({ catalogOf: () => f.catalog, principalOf: () => ({ member: true, policy: { cliTools: [f.tool.id] } }), workspaceOf: async () => cwd,
    run: async ({ argv, tool }) => {
      const spec = boundary.prepare({ argv, cwd, env: {} }, { userId: uid, home, cwd, sharedDirectories: [], cli: { readOnlyPaths: tool.runtime.paths } });
      const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd, env: { ...process.env, ...spec.env }, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);return JSON.parse(result.stdout);
    } });
  for (const query of [secret, join(other, 'secret')]) assert.equal((await definition.execute({ action: 'run', id: f.tool.id, operation: 'route', query }, { signal: new AbortController().signal })).denied, true);
  // Approval opens no raw runner path in ordinary member execution.
  const plain = boundary.prepare({ argv: [f.command, 'run'], cwd, env: {} }, { userId: uid, home, cwd, sharedDirectories: [] });
  assert.notEqual(spawnSync(plain.argv[0], plain.argv.slice(1), { cwd, env: { ...process.env, ...plain.env } }).status, 0);
});

test('registered native DSH execution tool uses native sandbox, subprocess and output contracts without a model call', { skip: !process.env.DSH_LAN_CONTRACT_MODULES }, async t => {
  const previous = process.env.DSH_EXECUTION_HOST_CANARY;
  process.env.DSH_EXECUTION_HOST_CANARY = 'synthetic-host-only-credential';
  t.after(() => { if (previous === undefined) delete process.env.DSH_EXECUTION_HOST_CANARY; else process.env.DSH_EXECUTION_HOST_CANARY = previous; });
  const f = await fixture(t), native = await memberExecutionFixture({ modules: process.env.DSH_LAN_CONTRACT_MODULES });
  t.after(() => native.close());
  const require = createRequire(join(process.env.DSH_LAN_CONTRACT_MODULES, '@deepseek-ai/dsh/package.json'));
  const sdk = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/landlock-run')).href);
  const boundary = await createMemberBoundary({ native: sdk });
  const binding = { userId: uid, home: native.home, cwd: native.cwd, sharedDirectories: [], cli: { readOnlyPaths: f.tool.runtime.paths } };
  const options = { boundary, bindingForPolicy: () => binding, bindingForExecution: () => binding };
  for (const kind of ['sandbox', 'subprocess']) t.after(installMemberBoundary(native.services.get(kind), { ...options, kind }));
  const definition = executionToolsDefinition({ catalogOf: () => f.catalog, principalOf: () => ({ member: true, policy: { cliTools: [f.tool.id] } }), workspaceOf: async () => native.cwd,
    run: async value => runNativeExecutionTool({ ...value, context: native.agent.ctx }) });
  const unregister = native.agent.ctx.tools.register(definition);t.after(unregister);
  const outside = join(f.root, 'host-private-data');await writeFile(outside, 'private');
  const result = await native.run('execution_tools', { action: 'run', id: f.tool.id, operation: 'route', query: outside });
  assert.equal(result.isError, false, JSON.stringify(result));assert.equal(result.value.exitCode, 0);
  assert.equal(result.value.result.denied, true);assert.equal(result.value.result.cwd, native.cwd);
  assert.equal(result.value.result.home, native.home);
  assert.equal(result.value.result.tmp, join(native.home, '.tmp'));
  assert.equal(result.value.result.config, join(native.home, '.config'));
  assert.equal(result.value.result.cache, join(native.home, '.cache'));
  assert.equal(result.value.result.hostCredential, null);
});
