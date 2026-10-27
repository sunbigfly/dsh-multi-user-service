import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';
import { installMemberTerminals } from '../carrier/execution.mjs';
import { nativeMemberSessions } from '../carrier/native-sessions.mjs';
import { MemberCapabilities } from '../carrier/capabilities.mjs';
import { accountAccess } from '../core/validation.js';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const hostPrivateHome = join(homedir(), '.dsh');

test('native DSH can select its bundled Landlock backend when bwrap is unavailable', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() });
  t.after(() => f.close());
  const sandbox = f.services.get('sandbox');
  const native = sandbox[Symbol.for('cordis.original')] ?? sandbox;
  native.internals = { ...native.internals, probeBwrap: () => false };
  const wrapped = await sandbox.confine([process.execPath, '--version'], { mode: 'workspace-write', workspaceRoot: f.cwd });
  assert.equal(native.selectedRunner.runner, 'landlock');
  assert.doesNotMatch(wrapped.argv[0], /bwrap|python/);
  const result = await f.run('bash', { description: 'Native bundled runner', command: 'printf NATIVE_DSH_ONLY > native.txt; cat native.txt' });
  assert.equal(result.value?.exitCode, 0, JSON.stringify(result));
  assert.equal(await readFile(join(f.cwd, 'native.txt'), 'utf8'), 'NATIVE_DSH_ONLY');
});

test('native persistent PTC survives calls and member disposal releases only its retained kernel', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd(), ptc: true, ptcConfig: { executionMode: 'persistent-in-memory' } });
  t.after(() => f.close());
  const { createScope, scopeParentOf } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-scope/lib/index.js')).href);
  const b = { id: 'persistent-other', session: { id: 'persistent-other', header: { cwd: f.cwd } } };
  const scope = createScope(f.services, b, { parent: scopeParentOf(f.agent) }); b.ctx = scope.ctx; b.scope = scope;
  t.after(() => scope.dispose());
  f.agent.ctx.tools.presentAs('ptc');
  b.ctx.tools.presentAs('ptc');
  const run = (agent, code) => f.services.tools.execute({ agent, name: 'run_code', arguments: { code, description: 'Retained kernel isolation fixture' }, callId: 'persistent-' + Date.now(), signal: AbortSignal.timeout(10000) });
  const aFirst = await run(f.agent, 'var retainedValue = "A_ONLY"; retainedValue');
  assert.equal(aFirst.isError, false, JSON.stringify(aFirst));
  assert.match(JSON.stringify(await run(f.agent, 'retainedValue')), /A_ONLY/);
  assert.match(JSON.stringify(await run(b, 'typeof retainedValue')), /undefined/);
  assert.equal((await run(b, 'var retainedValue = "B_ONLY"; retainedValue')).isError, false);
  const agents = new Map();
  const registry = { list: () => [...agents.values()], get: id => agents.get(id), async create({ agent }) {
    agents.set(agent.id, agent); return { agent, async dispose() { await agent.scope.dispose(); agents.delete(agent.id); } };
  }, async resume(options) { return this.create(options); } };
  const sessions = nativeMemberSessions({ ctx: { agents: registry }, ownership: { isMemberCwd: cwd => cwd === f.cwd, bindingForCwd: () => ({ userId: 'synthetic' }) }, runtime: { ready: true } });
  t.after(() => sessions.close());
  await registry.create({ agent: f.agent }); await registry.create({ agent: b });
  const runtime = f.services.get('ptcRuntime')[Symbol.for('cordis.original')] ?? f.services.get('ptcRuntime');
  assert.equal(runtime.inMemory.kernels.size, 2, 'two real retained Node processes');
  await sessions.stop(f.agent.id);
  assert.equal(runtime.inMemory.kernels.size, 1, 'native ToolRuntime disposal released A kernel');
  assert.match(JSON.stringify(await run(b, 'retainedValue')), /B_ONLY/);
  await sessions.stop(b.id);
  assert.equal(runtime.inMemory.kernels.size, 0);
});

test('member revocation disposes the real native terminal scope and leaves owner scope untouched', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() });
  t.after(() => f.close());
  const restore = installMemberTerminals(f.services.terminalController, { isMember: agent => agent === f.agent, modeOf: () => 'workspace-write' });
  t.after(restore);
  const owner = { id: 'owner', session: { header: { cwd: '/owner/private' } }, scope: { dispose() { throw new Error('Owner scope was touched'); } } };
  const agents = [owner];
  const registry = { list: () => agents, get: id => agents.find(agent => agent.id === id), async create() {
    agents.push(f.agent);
    return { agent: f.agent, async dispose() { await f.agent.scope.dispose(); agents.splice(agents.indexOf(f.agent), 1); } };
  }, async resume(options) { return this.create(options); } };
  const sessions = nativeMemberSessions({ ctx: { agents: registry, get: name => name === 'terminalController' ? f.services.terminalController : undefined },
    ownership: { isMemberCwd: cwd => cwd === f.cwd, bindingForCwd: () => ({ userId: 'member' }) }, runtime: { ready: true } });
  await registry.create({ sessionId: f.agent.id, meta: { cwd: f.cwd } });
  await f.services.terminalController.create(f.agent, { id: 'scope-stop-check', cols: 80, rows: 24 }, AbortSignal.timeout(10000));
  assert.equal(f.services.terminalController.list(f.agent.id).length, 1);
  assert.deepEqual(sessions.state.projects, [{ projectId: f.agent.id, userId: 'member' }]);
  assert.deepEqual(await sessions.stop(f.agent.id), { stopped: true });
  assert.equal(f.services.terminalController.list(f.agent.id).length, 0);
  assert.equal(registry.get(f.agent.id), undefined, 'revoked native Agent is detached, not left with disposed guards');
  await sessions.close();
});

test('terminal account authorization applies at the native controller and still permits revocation cleanup', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() }); t.after(() => f.close());
  let enabled = true;
  const restore = installMemberTerminals(f.services.terminalController, { isMember: agent => agent === f.agent, modeOf: () => 'workspace-write', authorize() { if (!enabled) throw new Error('synthetic terminal disabled'); } });
  t.after(restore);
  await f.services.terminalController.create(f.agent, { id: 'capability-check', cols: 80, rows: 24 }, AbortSignal.timeout(10000));
  enabled = false;
  assert.throws(() => f.services.terminalController.create(f.agent, { id: 'denied', cols: 80, rows: 24 }, AbortSignal.timeout(10000)), /terminal disabled/);
  await f.services.terminalController.close(f.agent, 'capability-check');
  assert.equal(f.services.terminalController.list(f.agent.id).length, 0);
});
test('native Bash owns command confinement while plugin file-tool paths remain account-scoped', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  // A parent outside /tmp ensures the outer DSH tmpfs cannot accidentally hide
  // the sibling canary and make a missing isolation layer appear to pass.
  const f = await memberExecutionFixture({ modules, parent: process.cwd() });
  t.after(() => f.close());
  const run = command => f.run('bash', { description: 'Member execution contract', command });
  const own = await run("printf hi > hello.txt; cat hello.txt");
  assert.equal(own.value?.exitCode, 0, JSON.stringify(own));
  assert.equal(own.value.stdout.text, 'hi');
  assert.equal(await readFile(join(f.cwd, 'hello.txt'), 'utf8'), 'hi');
  const denied = await run('cat ' + f.canary);
  assert.equal(denied.value?.exitCode, 0);
  assert.equal(denied.value.stdout.text, 'synthetic-only');
  await symlink(f.canary, join(f.cwd, 'outside-link'));
  assert.equal((await run('cat outside-link')).value?.stdout?.text, 'synthetic-only');
  assert.equal((await f.run('bash', { description: 'Invalid workdir', command: 'pwd', workdir: f.directory })).isError, true);
  f.setMode('read-only');
  assert.notEqual((await run('printf changed > hello.txt')).value?.exitCode, 0);
  assert.equal(await readFile(join(f.cwd, 'hello.txt'), 'utf8'), 'hi');
});

test('native full-access policy is preserved while managed file APIs retain member authorization', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd(), ptc: true }); t.after(() => f.close());
  f.setMode('danger-full-access');
  const full = { mode: 'danger-full-access', workspaceRoot: f.cwd, sessionId: f.agent.id };
  assert.equal(f.services.sandboxPolicy.resolve({ session: f.agent.session }).mode, 'danger-full-access');
  const wrote = await f.run('write', { file_path: 'full-own.txt', content: 'full-own' });
  assert.equal(wrote.isError, false, JSON.stringify(wrote));
  const shell = f.services.shell;
  const resolved = shell.resolve({ command: `cat full-own.txt; cat '${f.canary}'`, workdir: f.cwd, sandboxPolicy: full });
  assert.equal(resolved.sandboxPolicy.mode, 'danger-full-access');
  const bash = await shell.execute({ ...resolved, sandboxPolicy: full });
  await bash.done;
  assert.equal(bash.exitCode, 0, JSON.stringify(bash));
  const runtime = f.services.get('ptcRuntime');
  const spec = runtime.resolve({ program: `const fs=await import('node:fs/promises');await fs.writeFile('full-ptc.txt','PTC_FULL');return {own:await fs.readFile('full-ptc.txt','utf8'),outside:await fs.access(${JSON.stringify(f.canary)}).then(()=>true,()=>false)};`, bindings: [], cwd: f.cwd, sandboxPolicy: full, signal: AbortSignal.timeout(10000) });
  assert.equal(spec.sandboxPolicy.mode, 'danger-full-access');
  assert.deepEqual((await runtime.run({ ...spec, sandboxPolicy: full })).value, { own: 'PTC_FULL', outside: true });
  const target = await f.services.fs.resolve(join(f.cwd, 'direct.txt'));
  await f.services.fs.writeText(target, 'DIRECT', undefined, AbortSignal.timeout(1000), full);
  const outside = await f.services.fs.resolve(f.canary);
  await assert.rejects(f.services.fs.writeText(outside, 'bad', undefined, AbortSignal.timeout(1000), full), { code: 'FS_SANDBOX_DENIED' });
  assert.equal(await readFile(f.canary, 'utf8'), 'synthetic-only');
  assert.equal(shell.resolve({ command: 'true', workdir: f.directory, sandboxPolicy: { ...full, workspaceRoot: f.directory, sessionId: 'owner' } }).sandboxPolicy.mode, 'danger-full-access', 'owner policy unchanged');
});

test('native Node PTC retains its protocol and the documented native read boundary', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd(), ptc: true }); t.after(() => f.close());
  await symlink(f.canary, join(f.cwd, 'outside-link'));
  const runtime = f.services.get('ptcRuntime');
  const spec = runtime.resolve({ program: `const fs=await import('node:fs/promises'); await fs.writeFile('ptc-own.txt','ptc-ok'); let outside=false,link=false; try{await fs.readFile(${JSON.stringify(f.canary)});outside=true;}catch{} try{await fs.readFile('outside-link');link=true;}catch{} return {own:await fs.readFile('ptc-own.txt','utf8'),outside,link};`, bindings: [], cwd: f.cwd, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: f.cwd, sessionId: f.agent.id }, signal: AbortSignal.timeout(20000) });
  const result = await runtime.run(spec);
  assert.deepEqual(result.value, { own: 'ptc-ok', outside: true, link: true }, JSON.stringify(result));
  assert.equal(await readFile(join(f.cwd, 'ptc-own.txt'), 'utf8'), 'ptc-ok');
  const { mkdir } = await import('node:fs/promises');
  const child = join(f.cwd, 'nested'); await mkdir(child);
  const nested = await runtime.run(runtime.resolve({ ...spec, program: 'return process.cwd();', cwd: child }));
  assert.equal(nested.value, child, JSON.stringify(nested));
  const bash = await f.run('bash', { description: 'Native sandbox plus Bash view', command: 'printf double-guard' });
  assert.equal(bash.value?.stdout?.text, 'double-guard', JSON.stringify(bash));
});

test('custom tool grants deny native run_code before direct Node file effects', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd(), ptc: true }); t.after(() => f.close());
  const capabilities = new MemberCapabilities({ core: { memberAccess: () => accountAccess({ tools: ['read'] }) }, hostCapability: {}, ownership: { ownerOf: () => 'member' } });
  f.agent.ctx.tools.presentAs('ptc');
  f.agent.ctx.tools.guard(exec => capabilities.toolDenial(exec, 'workspace-write'));
  const result = await f.run('run_code', { code: "const fs = await import('node:fs/promises'); await fs.writeFile('bypass.txt', 'unexpected');" });
  assert.equal(result.isError, true, JSON.stringify(result));
  await assert.rejects(access(join(f.cwd, 'bypass.txt')), { code: 'ENOENT' });
});

test('native PTY provider and argv are passed through without a plugin execution wrapper', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() });
  t.after(() => f.close());
  const provider = f.services.subprocess;
  const handle = await provider.spawnTerminal({ argv: ['/usr/bin/bash', '-c', `printf tty-ok > tty.txt; cat tty.txt; cat ${f.canary}`], cwd: f.cwd, cols: 80, rows: 24, terminalType: 'xterm-256color', env: {}, graceMs: 1000, signal: AbortSignal.timeout(15000) });
  t.after(() => handle.terminate());
  let output = '';
  const reading = (async () => { for await (const chunk of handle.output) output += chunk.toString(); })();
  const result = await handle.done; await reading;
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /tty-ok/); assert.match(output, /synthetic-only/);
  assert.equal(await readFile(join(f.cwd, 'tty.txt'), 'utf8'), 'tty-ok');
});

test('native controller member adaptation preserves owner calls and restores the public methods', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() });
  t.after(() => f.close());
  const controller = f.services.terminalController;
  const raw = controller[Symbol.for('cordis.original')] ?? controller;
  const original = raw.create;
  const restore = installMemberTerminals(controller, { isMember: agent => agent === f.agent, modeOf: () => 'workspace-write' });
  t.after(restore);
  const environment = controller.environment(f.agent, AbortSignal.timeout(5000));
  assert.equal(environment.cwd, f.cwd);
  const terminal = await controller.create(f.agent, { id: 'member-terminal-check', cols: 80, rows: 24 }, AbortSignal.timeout(10000));
  assert.equal(terminal.cwd, f.cwd);
  assert.equal(controller.list(f.agent.id).length, 1);
  await controller.close(f.agent, terminal.id);
  assert.equal(controller.list(f.agent.id).length, 0);
  restore();
  assert.equal(raw.create, original);
});
