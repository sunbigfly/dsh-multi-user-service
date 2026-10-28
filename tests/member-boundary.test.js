import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMemberBoundary, installMemberBoundary, memberHome, memberSourceIsolated } from '../carrier/member-boundary.mjs';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';
import { memberPathDenial } from '../carrier/access.mjs';
import { MemberCapabilities } from '../carrier/capabilities.mjs';
import { realpath } from 'node:fs/promises';

const userId = 'usr_' + 'a'.repeat(32);
const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const nativeTest = { skip: process.platform !== 'linux' || !modules, timeout: 10000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-strict-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, userId), other = join(root, 'usr_' + 'b'.repeat(32)), shared = join(root, 'shared'), writable = join(root, 'writable');
  for (const path of [home, other, shared, writable]) await mkdir(path, { mode: 0o700 });
  const cwd = join(home, 'workspace'); await mkdir(cwd);
  const secret = join(other, 'private.txt'); await writeFile(secret, 'SYNTHETIC_OTHER');
  await writeFile(join(shared, 'reference.txt'), 'SHARED_REFERENCE');
  await writeFile(join(home, 'own.txt'), 'OWN');
  const native = await import(pathToFileURL(join(modules, '@deepseek-ai/node-addon-system/lib/index.js')).href);
  const boundary = await createMemberBoundary({ native });
  assert.equal(boundary.snapshot().available, true, 'Native Landlock is required for this contract');
  const binding = { userId, home, cwd, sharedDirectories: [{ path: shared, mode: 'read-only' }, { path: writable, mode: 'read-write' }] };
  return { root, home, cwd, other, shared, writable, secret, boundary, binding };
}

test('missing, partial and unsupported native enforcement fail closed before any spawn', async () => {
  for (const [platform, verdict] of [['linux', 'unusable'], ['linux', 'partial'], ['win32', 'full']]) {
    const boundary = await createMemberBoundary({ platform, native: { launcherPath: () => 'unused', probe: () => verdict } });
    assert.throws(() => boundary.assertAvailable(), { code: 'MEMBER_BOUNDARY_UNAVAILABLE' });
    assert.equal(boundary.snapshot().available, false);
  }
  assert.equal(memberHome({ userId, cwd: '/srv/members/' + userId + '/workspace/session' }), '/srv/members/' + userId);
  assert.throws(() => memberHome({ userId, cwd: '/srv/owner' }), { code: 'MEMBER_BOUNDARY_DENIED' });
});

test('shared MCP and arbitrary plugin code are not mistaken for a member-scoped capability', () => {
  assert.equal(memberSourceIsolated(undefined), false);
  assert.equal(memberSourceIsolated({ plugin: 'third-party' }), false);
  assert.equal(memberSourceIsolated({ plugin: '@deepseek-ai/dsh-mcp-client', mcpServer: 'filesystem' }), false);
  assert.equal(memberSourceIsolated({ plugin: '@deepseek-ai/dsh-tool-cordis' }), false);
  assert.equal(memberSourceIsolated({ plugin: '@deepseek-ai/dsh-tool-bash' }), true);
  assert.equal(memberSourceIsolated({ plugin: '@deepseek-ai/dsh-ptc-runtime-node' }), true);
  assert.equal(memberSourceIsolated({ plugin: 'dsh-browser' }), true);
  const access = new MemberCapabilities({}), inherited = { plugins: null, mcpServers: null };
  assert.equal(access.sourceAllowed({ ...inherited, files: false }, { plugin: '@deepseek-ai/dsh-tool-bash' }), false);
  assert.equal(access.sourceAllowed({ ...inherited, files: true }, { plugin: '@deepseek-ai/dsh-tool-fs' }), true);
  assert.equal(access.sourceAllowed({ ...inherited, subagents: false }, { plugin: '@deepseek-ai/dsh-tool-subagent' }), false);
});

test('CLI runtime grants cannot overlap protected server or other-member state', nativeTest, async t => {
  const f = await fixture(t);
  assert.throws(() => f.boundary.confine([process.execPath, '--version'], { ...f.binding, protectedRoots: [f.secret], cli: { readOnlyPaths: [f.secret] } }), { code: 'MEMBER_BOUNDARY_DENIED' });
});

test('native launcher confines absolute paths, traversal, symlinks, hard links and proc access', nativeTest, async t => {
  const f = await fixture(t);
  await symlink(f.secret, join(f.home, 'foreign-link'));
  const program = `const fs=require('node:fs'),p=${JSON.stringify({ home: f.home, secret: f.secret, shared: f.shared, writable: f.writable, parent: process.pid })};
    const canRead=p=>{try{fs.readFileSync(p);return true}catch{return false}};
    const canWrite=p=>{try{fs.writeFileSync(p,'written');return true}catch{return false}};
    let link=false;try{fs.linkSync(p.secret,p.home+'/foreign-hardlink');link=true}catch{}
    console.log(JSON.stringify({own:canRead(p.home+'/own.txt'),other:canRead(p.secret),symlink:canRead(p.home+'/foreign-link'),proc:canRead('/proc/'+p.parent+'/environ'),procRoot:canRead('/proc/self/root'+p.secret),shared:canRead(p.shared+'/reference.txt'),writeOwn:canWrite(p.home+'/output.txt'),writeShared:canWrite(p.shared+'/changed.txt'),writeAuthorized:canWrite(p.writable+'/output.txt'),hardlink:link}));`;
  const confined = f.boundary.confine([process.execPath, '-e', program], f.binding);
  const result = spawnSync(confined.argv[0], confined.argv.slice(1), { cwd: f.cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { own: true, other: false, symlink: false, proc: false, procRoot: false, shared: true, writeOwn: true, writeShared: false, writeAuthorized: true, hardlink: false });
});

test('the lowest native spawn boundary strips host secrets and also confines a full-access caller', nativeTest, async t => {
  const f = await fixture(t); const key = 'DSH_BOUNDARY_SYNTHETIC_SECRET'; const before = process.env[key]; process.env[key] = 'SYNTHETIC_ONLY';
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const program = `const fs=require('node:fs');let other=false;try{fs.readFileSync(${JSON.stringify(f.secret)});other=true}catch{}console.log(JSON.stringify({other,secret:process.env.${key}!==undefined,home:process.env.HOME,temp:process.env.TMPDIR}));`;
  const spec = { argv: [process.execPath, '-e', program], cwd: f.cwd, env: { [key]: process.env[key], NODE_OPTIONS: '--require=/server/private.js' }, signal: AbortSignal.timeout(5000) };
  let received;
  const service = { spawn(value) { received = value; return spawnSync(value.argv[0], value.argv.slice(1), { cwd: value.cwd, env: Object.fromEntries(Object.entries({ ...process.env, ...value.env }).filter(([, v]) => v !== undefined)), encoding: 'utf8' }); }, async spawnTerminal(value) { received = value; return value; } };
  const restore = installMemberBoundary(service, { boundary: f.boundary, bindingForExecution: value => value.cwd === f.cwd ? f.binding : undefined, kind: 'subprocess' });t.after(restore);
  const result = service.spawn(spec); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { other: false, secret: false, home: f.home, temp: join(f.home, '.tmp') });
  assert.equal(received.signal, spec.signal);
  const owner = { argv: ['owner'], cwd: f.root, env: { [key]: 'OWNER_ONLY' } };
  await service.spawnTerminal(owner); assert.equal(received, owner, 'owner launch identity is unchanged');
  const terminal = await service.spawnTerminal(spec); assert.equal(terminal.shellActivity, false); assert.notEqual(terminal.argv, spec.argv);
});

test('read-only execution, stale shared paths and conflicting nested grants cannot widen access', nativeTest, async t => {
  const f = await fixture(t);
  const ro = f.boundary.confine([process.execPath, '-e', `try{require('node:fs').writeFileSync(${JSON.stringify(join(f.home, 'denied.txt'))},'bad');process.exit(1)}catch{}`], f.binding, 'read-only');
  assert.equal(spawnSync(ro.argv[0], ro.argv.slice(1)).status, 0);
  assert.throws(() => f.boundary.prepare({ argv: ['unused'], cwd: f.other }, f.binding), { code: 'MEMBER_BOUNDARY_DENIED' });
  const child = join(f.writable, 'readonly'); await mkdir(child);
  assert.throws(() => f.boundary.confine(['unused'], { ...f.binding, sharedDirectories: [...f.binding.sharedDirectories, { path: child, mode: 'read-only' }] }), { code: 'MEMBER_BOUNDARY_DENIED' });
  await rm(f.shared, { recursive: true }); await symlink(f.other, f.shared);
  assert.throws(() => f.boundary.confine(['unused'], f.binding), { code: 'SHARED_DIRECTORY_INVALID' });
});

test('subagent cwd cannot move execution to another account or follow a foreign symlink', nativeTest, async t => {
  const f = await fixture(t);
  for (const name of ['subagent', 'subagent_fork']) {
    assert.equal(await memberPathDenial({ name, arguments: { cwd: f.cwd } }, f.cwd, { realpath }), undefined);
    assert.equal(typeof await memberPathDenial({ name, arguments: { cwd: f.other } }, f.cwd, { realpath }), 'string');
    await symlink(f.other, join(f.cwd, name + '-link'));
    assert.equal(typeof await memberPathDenial({ name, arguments: { cwd: name + '-link' } }, f.cwd, { realpath }), 'string');
  }
});

test('redundant writable child roots and unsafe provider replacements cannot widen a launch', nativeTest, async t => {
  const f = await fixture(t), child = join(f.writable, 'child');await mkdir(child);
  const binding = { ...f.binding, sharedDirectories: [...f.binding.sharedDirectories, { path: child, mode: 'read-write' }] };
  const result = f.boundary.confine(['unused'], binding);
  assert.equal(result.argv.includes(child), false, 'the launcher never opens a redundant replaceable child grant');
  assert.throws(() => f.boundary.confine(['unused'], { ...binding, protectedRoots: ['/usr/lib/synthetic-protected-data'] }), { code: 'MEMBER_BOUNDARY_DENIED' });
  let launched = false;
  const service = { spawn() { launched = true; }, spawnTerminal() { launched = true; } };
  const restore = installMemberBoundary(service, { boundary: f.boundary, kind: 'subprocess', trusted: false, bindingForExecution: () => f.binding });t.after(restore);
  assert.throws(() => service.spawn({ argv: ['unused'], cwd: f.cwd }), { code: 'MEMBER_BOUNDARY_UNAVAILABLE' });assert.equal(launched, false);
  await chmod(f.home, 0o755);
  assert.throws(() => f.boundary.confine(['unused'], f.binding), { code: 'MEMBER_BOUNDARY_DENIED' });
});

test('real native Bash and Node PTC cannot cross the account boundary even in full-access mode', { ...nativeTest, timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, strict: true, ptc: true }); t.after(() => f.close());
  for (const mode of ['workspace-write', 'danger-full-access']) {
    f.setMode(mode);
    const bash = await f.run('bash', { description: 'Synthetic directory boundary', command: `printf own-ok > own.txt; cat own.txt; cat '${f.canary}'` });
    assert.equal(bash.isError, false, JSON.stringify(bash));
    assert.match(bash.value.stdout.text, /own-ok/); assert.doesNotMatch(bash.value.stdout.text, /synthetic-only/);
    assert.notEqual(bash.value.exitCode, 0);
    const runtime = f.services.get('ptcRuntime');
    const policy = { mode, workspaceRoot: f.cwd, sessionId: f.agent.id };
    const spec = runtime.resolve({ program: `const fs=await import('node:fs/promises');await fs.writeFile('ptc-own.txt','PTC_OK');let outside=false;try{await fs.readFile(${JSON.stringify(f.canary)});outside=true}catch{}return {own:await fs.readFile('ptc-own.txt','utf8'),outside};`, bindings: [], cwd: f.cwd, sandboxPolicy: policy, signal: AbortSignal.timeout(10000) });
    const result = await runtime.run({ ...spec, sandboxPolicy: policy });
    assert.deepEqual(result.value, { own: 'PTC_OK', outside: false }, JSON.stringify(result));
  }
});

test('native bash, glob and grep survive asynchronous CLI preparation without widening access', { ...nativeTest, timeout: 30000 }, async t => {
  let preparations = 0;
  const f = await memberExecutionFixture({ modules, strict: true, search: true,
    prepareBinding: async binding => { await Promise.resolve(); preparations++; return binding; } });
  t.after(() => f.close());
  await writeFile(join(f.cwd, 'member-note.txt'), 'MEMBER_SEARCH_OK');
  const bash = await f.run('bash', { description: 'Verify native process handle', command: 'printf HANDLE_OK; if cat ../outside-canary 2>/dev/null; then exit 1; fi' });
  assert.equal(bash.isError, false, JSON.stringify(bash));
  assert.equal(bash.value.exitCode, 0, JSON.stringify(bash));
  assert.match(bash.value.stdout.text, /HANDLE_OK/);
  assert.ok(preparations > 0);
  const glob = await f.run('glob', { pattern: '*.txt' });
  assert.equal(glob.isError, false, JSON.stringify(glob));
  assert.match(JSON.stringify(glob.content), /member-note\.txt/);
  const grep = await f.run('grep', { pattern: 'MEMBER_SEARCH_OK' });
  assert.equal(grep.isError, false, JSON.stringify(grep));
  assert.match(JSON.stringify(grep.content), /MEMBER_SEARCH_OK/);
  const denied = await f.run('grep', { pattern: 'synthetic-only', path: f.canary });
  assert.equal(denied.isError, true, JSON.stringify(denied));
});

test('the real native PTY remains usable but cannot read another account file', { ...nativeTest, timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, strict: true });t.after(() => f.close());
  const handle = await f.services.subprocess.spawnTerminal({ argv: ['/usr/bin/bash', '-c', `printf tty-ok > tty.txt; cat tty.txt; cat '${f.canary}'`], cwd: f.cwd, cols: 80, rows: 24, terminalType: 'xterm-256color', env: {}, graceMs: 1000, signal: AbortSignal.timeout(10000) });
  t.after(() => handle.terminate()); let output = '';
  const reading = (async () => { for await (const chunk of handle.output) output += chunk.toString(); })();
  const result = await handle.done; await reading;
  assert.match(output, /tty-ok/); assert.doesNotMatch(output, /synthetic-only/); assert.notEqual(result.exitCode, 0);
});
