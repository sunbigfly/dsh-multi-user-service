import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MemberCliRegistry } from '../carrier/cli-tools.mjs';
import { createMemberBoundary, installMemberBoundary } from '../carrier/member-boundary.mjs';
import { accountAccess, effectiveAccess } from '../core/validation.js';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const userId = 'usr_' + 'a'.repeat(32), otherId = 'usr_' + 'b'.repeat(32);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'program.js');
  await writeFile(program, 'console.log(JSON.stringify({args:process.argv.slice(2),key:process.env.SYNTHETIC_CLI_KEY,home:process.env.HOME}));');
  const registry = new MemberCliRegistry({ root: join(root, 'managed'), credentials: () => ({ resolve: async () => ({ value: 'synthetic-key' }) }),
    tools: [{ id: 'research-cli', command: process.execPath, args: [program], readOnlyPaths: [program], credentials: { SYNTHETIC_CLI_KEY: 'RESEARCH_KEY' } },
      { id: 'another-cli', command: '/usr/bin/printf', args: ['another:%s'], environment: {} }] });
  return { root, registry, program };
}

test('CLI permissions inherit, persist explicit denial and intersect personal choices', () => {
  assert.equal(accountAccess().cliTools, null);
  assert.deepEqual(accountAccess({ cliTools: [] }).cliTools, []);
  assert.deepEqual(effectiveAccess({ access: { cliTools: ['research-cli'] }, preferences: { cliTools: ['another-cli', 'research-cli'] } }).cliTools, ['research-cli']);
  assert.throws(() => accountAccess({ cliTools: ['bad name'] }), { code: 'INVALID_INPUT' });
});

test('configured CLIs forward arguments and supplied credentials; revocation removes only managed commands', async t => {
  const { registry } = await fixture(t);
  assert.deepEqual(registry.catalog().map(x => x.id), ['research-cli', 'another-cli']);
  assert.ok(!JSON.stringify(registry.catalog()).includes('synthetic-key'));
  const allowed = await registry.prepare(userId, accountAccess({ cliTools: ['research-cli'] }));
  const result = spawnSync(join(allowed.bin, 'research-cli'), ['spaces & $(literal)', '--flag'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ['spaces & $(literal)', '--flag']);
  assert.equal(JSON.parse(result.stdout).key, 'synthetic-key');
  await writeFile(join(allowed.bin, 'unmanaged'), 'keep');
  assert.equal(await registry.prepare(userId, accountAccess({ cliTools: [] })), undefined);
  await assert.rejects(readFile(join(allowed.bin, 'research-cli')), { code: 'ENOENT' });
  assert.equal(await readFile(join(allowed.bin, 'unmanaged'), 'utf8'), 'keep');
  const second = await registry.prepare(otherId, accountAccess({ cliTools: ['another-cli'] }));
  assert.equal(spawnSync(join(second.bin, 'another-cli'), ['ok'], { encoding: 'utf8' }).stdout, 'another:ok');
  await assert.rejects(readFile(join(second.bin, 'research-cli')), { code: 'ENOENT' });
});

test('unsafe command roots, reserved environment variables and redirected state are rejected', async t => {
  for (const tool of [
    { id: '../bad', command: process.execPath }, { id: 'bad', command: process.execPath, readOnlyPaths: [homedir()] },
    { id: 'bad', command: process.execPath, environment: { HOME: '/host' } },
  ]) assert.throws(() => new MemberCliRegistry({ tools: [tool] }), { code: 'MEMBER_CLI_CONFIGURATION' });
  const { root, registry } = await fixture(t);
  const outside = join(root, 'outside'); await mkdir(outside);
  await mkdir(registry.root, { mode: 0o700 }); await symlink(outside, join(registry.root, userId));
  await assert.rejects(registry.prepare(userId, accountAccess()), { code: 'MEMBER_CLI_CONFIGURATION' });
});

test('CLI launchers preserve termination signals and do not resolve their interpreter through a command alias', async t => {
  const { root } = await fixture(t);
  const registry = new MemberCliRegistry({ root: join(root, 'signal-managed'), tools: [
    { id: 'node', command: '/usr/bin/bash', args: ['-c', 'kill -TERM $$'] },
  ] });
  const cli = await registry.prepare(userId, accountAccess());
  const result = spawnSync(join(cli.bin, 'node'), [], { env: { ...process.env, PATH: cli.bin + ':/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.error, undefined);
});

test('native member execution can use an authorized CLI while another account and host data remain inaccessible', { skip: !modules }, async t => {
  const { root, registry } = await fixture(t);
  const require = createRequire(join(modules, '@deepseek-ai/dsh/package.json'));
  const native = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/landlock-run')).href);
  const home = join(root, userId), cwd = join(home, 'workspace'); await mkdir(cwd, { recursive: true, mode: 0o700 });
  const secret = join(root, 'host-secret'); await writeFile(secret, 'HOST_SECRET');
  const cli = await registry.prepare(userId, accountAccess({ cliTools: ['research-cli'] }));
  const other = await registry.prepare(otherId, accountAccess({ cliTools: ['another-cli'] }));
  const boundary = await createMemberBoundary({ native });
  const binding = { userId, home, cwd, sharedDirectories: [], cli, protectedRoots: [join(root, 'managed')] };
  const spec = boundary.prepare({ argv: ['/usr/bin/bash', '--noprofile', '--norc', '-c', 'set -e; research-cli "actual member"; if cat "$1" >/dev/null 2>&1; then exit 1; fi; if cat "$2" >/dev/null 2>&1; then exit 1; fi', 'probe', secret, join(other.bin, 'another-cli')], cwd, env: {} }, binding);
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd, env: { ...process.env, ...spec.env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).home, home);
  assert.equal(JSON.parse(result.stdout).key, 'synthetic-key');
  const revoked = boundary.prepare({ argv: ['/usr/bin/bash', '--noprofile', '--norc', '-c', 'command -v research-cli'], cwd, env: {} }, { ...binding, cli: undefined });
  assert.notEqual(spawnSync(revoked.argv[0], revoked.argv.slice(1), { cwd, env: { ...process.env, ...revoked.env } }).status, 0);
});

test('real DSH bash prepares configured CLI credentials and revokes the synchronous launch grant', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const { registry } = await fixture(t);
  let policy = accountAccess({ cliTools: ['research-cli'] });
  const f = await memberExecutionFixture({ modules, strict: true,
    prepareBinding: async binding => ({ ...binding, cli: await registry.prepare(binding.userId, policy) }),
    preparedBinding: binding => ({ ...binding, cli: registry.snapshot(binding.userId, policy) }) });
  t.after(() => f.close());
  const result = await f.run('bash', { description: 'Run authorized CLI', command: 'research-cli --member' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.value.stdout.text), { args: ['--member'], key: 'synthetic-key', home: f.home });
  policy = accountAccess({ cliTools: [] });
  assert.equal(registry.snapshot(userId, policy), undefined);
  const revoked = await f.run('bash', { description: 'Verify revoked CLI', command: 'command -v research-cli' });
  assert.equal(revoked.isError, false, JSON.stringify(revoked));
  assert.equal(revoked.value.exitCode, 1, JSON.stringify(revoked));
});

test('native subprocess handles stay synchronous while terminal allocation awaits CLI preparation', async () => {
  let prepared = false;
  const service = { spawn: spec => ({ prepared, spec }), spawnTerminal: spec => ({ prepared, spec }) };
  const boundary = { prepare: (spec, binding) => ({ ...spec, cli: binding.cli }) };
  const restore = installMemberBoundary(service, { kind: 'subprocess', boundary,
    bindingForExecution: spec => spec.member ? { userId } : undefined,
    preparedBinding: binding => ({ ...binding, cli: 'configured' }),
    prepareBinding: async binding => { await Promise.resolve(); prepared = true; return { ...binding, cli: 'configured' }; } });
  try {
    assert.equal(service.spawn({}).prepared, false);
    const result = service.spawn({ member: true });
    assert.equal(typeof result.then, 'undefined');
    assert.equal(result.prepared, false); assert.equal(result.spec.cli, 'configured');
    const terminal = await service.spawnTerminal({ member: true });
    assert.equal(terminal.prepared, true); assert.equal(terminal.spec.cli, 'configured');
  } finally { restore(); }
});

test('synchronous CLI snapshots are account-specific and disappear immediately on permission changes', async t => {
  const { registry } = await fixture(t);
  const policy = accountAccess({ cliTools: ['research-cli'] });
  assert.equal(registry.snapshot(userId, policy), undefined);
  const ready = await registry.prepare(userId, policy);
  assert.equal(registry.snapshot(userId, policy), ready);
  assert.equal(registry.snapshot(otherId, policy), undefined);
  assert.equal(registry.snapshot(userId, accountAccess({ cliTools: [] })), undefined);
  await registry.prepare(userId, accountAccess({ cliTools: [] }));
  assert.equal(registry.snapshot(userId, policy), undefined);
});
