import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { accountAccess, sharedDirectories } from '../core/validation.js';
import { memberPathDenial } from '../carrier/access.mjs';
import { resolveSharedDirectories } from '../carrier/file-ranges.mjs';
import { memberExecutionFixture } from '../verification/member-execution-fixture.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('shared directory declarations are explicit, bounded and canonical', () => {
  assert.deepEqual(accountAccess().sharedDirectories, []);
  for (const rows of [null, [{ path: '/', mode: 'read-write' }], [{ path: 'relative', mode: 'read-only' }], [{ path: '/srv/a/../b', mode: 'read-only' }], [{ path: '/srv/a', mode: 'all' }], [{ path: '/srv/usr_' + 'a'.repeat(32), mode: 'read-only' }], [{ path: '/srv/a', mode: 'read-only' }, { path: '/srv/a', mode: 'read-write' }]]) assert.throws(() => sharedDirectories(rows), { code: 'INVALID_INPUT' });
  assert.deepEqual(sharedDirectories([{ path: '/srv/share', mode: 'read-only' }]), [{ path: '/srv/share', mode: 'read-only' }]);
});

test('managed shared file grants preserve authorization while Bash keeps its native workspace policy', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() }); t.after(() => f.close());
  const ro = join(f.directory, 'shared-ro'), rw = join(f.directory, 'shared-rw');
  await mkdir(ro); await mkdir(rw); await writeFile(join(ro, 'read.txt'), 'SHARED_RO');
  const grants = [{ path: ro, mode: 'read-only' }, { path: rw, mode: 'read-write' }];
  f.setDirectories(grants);
  const read = await f.run('read', { file_path: join(ro, 'read.txt') });
  assert.equal(read.isError, false, JSON.stringify(read)); assert.match(JSON.stringify(read), /SHARED_RO/);
  const blocked = await f.run('write', { file_path: join(ro, 'read.txt'), content: 'forbidden' });
  assert.equal(blocked.isError, true); assert.equal(await readFile(join(ro, 'read.txt'), 'utf8'), 'SHARED_RO');
  const written = await f.run('write', { file_path: join(rw, 'written.txt'), content: 'SHARED_WRITE' });
  assert.equal(written.isError, false, JSON.stringify(written));
  assert.equal(await readFile(join(rw, 'written.txt'), 'utf8'), 'SHARED_WRITE');
  await symlink(f.canary, join(rw, 'outside-link'));
  assert.equal((await f.run('read', { file_path: join(rw, 'outside-link') })).isError, true);
  const shell = await f.run('bash', { description: 'Shared directory modes', command: `cat ${quote(join(ro, 'read.txt'))}; if printf BASH_WRITE > ${quote(join(rw, 'bash.txt'))}; then exit 8; fi; if printf bad > ${quote(join(ro, 'read.txt'))}; then exit 9; fi` });
  assert.equal(shell.value?.exitCode, 0, JSON.stringify(shell));
  await assert.rejects(readFile(join(rw, 'bash.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(ro, 'read.txt'), 'utf8'), 'SHARED_RO');
  f.setDirectories([]);
  assert.equal((await f.run('read', { file_path: join(ro, 'read.txt') })).isError, true);
  assert.equal((await f.run('bash', { description: 'Revoked shared path', command: `test -e ${quote(ro)}` })).value?.exitCode, 0);
});

test('native PTC and PTY keep their original DSH policies independently of managed file grants', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd(), ptc: true }); t.after(() => f.close());
  const ro = join(f.directory, 'ro'), rw = join(f.directory, 'rw'); await mkdir(ro); await mkdir(rw);
  await writeFile(join(ro, 'input.txt'), 'PTC_RO');
  const grants = [{ path: ro, mode: 'read-only' }, { path: rw, mode: 'read-write' }]; f.setDirectories(grants);
  const runtime = f.services.get('ptcRuntime');
  const run = (program, mode = 'workspace-write') => runtime.run(runtime.resolve({ program, bindings: [], cwd: f.cwd, sandboxPolicy: { mode, workspaceRoot: f.cwd, sessionId: f.agent.id }, signal: AbortSignal.timeout(10000) }));
  const code = `const fs=await import('node:fs/promises');let rwDenied=false;try{await fs.writeFile(${JSON.stringify(join(rw, 'ptc.txt'))},'PTC_WRITE')}catch{rwDenied=true}let roDenied=false;try{await fs.writeFile(${JSON.stringify(join(ro, 'input.txt'))},'bad')}catch{roDenied=true}return {read:await fs.readFile(${JSON.stringify(join(ro, 'input.txt'))},'utf8'),roDenied,rwDenied};`;
  assert.deepEqual((await run(code)).value, { read: 'PTC_RO', roDenied: true, rwDenied: true });
  await assert.rejects(readFile(join(rw, 'ptc.txt')), { code: 'ENOENT' });
  assert.equal((await run(`const fs=await import('node:fs/promises');try{await fs.writeFile(${JSON.stringify(join(rw, 'ptc.txt'))},'bad');return false}catch{return true}`, 'read-only')).value, true);
  const subprocess = f.services.subprocess;
  const handle = await subprocess.spawnTerminal({ argv: ['/usr/bin/bash', '-c', `cat ${quote(join(ro, 'input.txt'))}; printf PTY_WRITE > ${quote(join(rw, 'pty.txt'))}`], cwd: f.cwd, cols: 80, rows: 24, terminalType: 'xterm-256color', env: {}, graceMs: 1000, signal: AbortSignal.timeout(10000) });
  t.after(() => handle.terminate());
  let output = ''; const read = (async () => { for await (const chunk of handle.output) output += chunk; })();
  const result = await handle.done; await read;
  assert.equal(result.exitCode, 0, output); assert.match(output, /PTC_RO/);
  assert.equal(await readFile(join(rw, 'pty.txt'), 'utf8'), 'PTY_WRITE');
});

test('shared roots cannot cover private homes, change into symlinks, or bypass a nested read-only grant', { skip: !modules || process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await memberExecutionFixture({ modules, parent: process.cwd() }); t.after(() => f.close());
  assert.throws(() => resolveSharedDirectories([{ path: f.directory, mode: 'read-only' }], { protectedRoots: [f.cwd], strict: true }), { code: 'SHARED_DIRECTORY_INVALID' });
  const rw = join(f.directory, 'shared'), ro = join(rw, 'locked'); await mkdir(rw); await mkdir(ro); await writeFile(join(ro, 'value'), 'locked');
  await symlink(ro, join(rw, 'alias'));
  const grants = [{ path: rw, mode: 'read-write' }, { path: ro, mode: 'read-only' }];
  assert.match(await memberPathDenial({ name: 'write', arguments: { file_path: join(rw, 'alias/value') } }, f.cwd, { realpath, sharedDirectories: grants }), /limited/);
  assert.deepEqual(resolveSharedDirectories([{ path: join(rw, 'alias'), mode: 'read-only' }]), []);
  assert.throws(() => resolveSharedDirectories([{ path: '/proc', mode: 'read-only' }], { strict: true }), { code: 'SHARED_DIRECTORY_INVALID' });
});
