import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { BackupControl, installBackupAgent, installBackupModelGuard } from '../carrier/backup.mjs';

test('backup socket is private, refuses busy work, freezes admission and expires safely', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backup-control-')); t.after(() => rm(directory, { recursive: true, force: true }));
  class RemoteError extends Error { constructor(code, message) { super(message); this.code = code; } }
  let busy = true;
  const control = await new BackupControl({ path: join(directory, 'control.sock'), busy: async () => busy, plan: async () => [{ key: 'synthetic', path: directory }], RemoteError, leaseMs: 50 }).start();
  t.after(() => control.close());
  assert.equal((await stat(control.path)).mode & 0o777, 0o600);
  const request = action => new Promise((resolve, reject) => {
    const socket = net.connect(control.path); let text = '';
    socket.on('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', data => text += data); socket.on('error', reject); socket.on('end', () => resolve(JSON.parse(text)));
  });
  assert.equal((await request('prepare')).ready, false); control.assertAvailable();
  busy = false;
  const prepared = await request('prepare'); assert.equal(prepared.ready, true);
  assert.throws(() => control.assertAvailable(), { code: 'lan/backup-maintenance' });
  await assert.rejects(control.command({ action: 'release', token: 'wrong' }));
  await control.command({ action: 'release', token: prepared.token }); control.assertAvailable();
  const replies = await Promise.all([control.command({ action: 'prepare' }), control.command({ action: 'prepare' })]);
  assert.equal(replies.filter(row => row.ready).length, 1);
  await new Promise(resolve => setTimeout(resolve, 80)); control.assertAvailable();
  assert.equal((await request('unrecognized')).ok, false);
});

test('backup guards retain current owner/model work and reject new native entry calls', async t => {
  class RemoteError extends Error {}
  const control = new BackupControl({ busy: async () => false, plan: async () => [], RemoteError });
  const held = Promise.withResolvers(), runtime = { async *streamWithRegistration() { yield 'first'; await held.promise; yield 'last'; } };
  const restoreModel = installBackupModelGuard(runtime, control); t.after(restoreModel);
  const stream = runtime.streamWithRegistration()[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value, 'first');
  assert.equal((await control.command({ action: 'prepare' })).ready, false);
  held.resolve(); assert.equal((await stream.next()).value, 'last'); await stream.next();
  const gate = await control.command({ action: 'prepare' }); assert.equal(gate.ready, true);
  const agent = { messages: [], send(value) { this.messages.push(value); }, wakeDriver() {}, runMaintenance(job) { return job(); } };
  const restoreAgent = installBackupAgent(agent, control); t.after(restoreAgent);
  assert.throws(() => agent.send('new', 'next-turn', true)); assert.equal(agent.messages.length, 0);
  await assert.rejects(runtime.streamWithRegistration().next());
  control.release(); agent.send('accepted', 'next-turn', true); assert.equal(agent.messages.length, 1);
});

test('backup control never removes an occupied ordinary file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backup-collision-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'keep'); await writeFile(path, 'preserved');
  await assert.rejects(new BackupControl({ path }).start());
  assert.equal(await readFile(path, 'utf8'), 'preserved');
});

test('backup archives actually restore bytes, permissions and links; reject tampering and preserve retention bounds', () => {
  const result = spawnSync('/usr/bin/python3', ['tests/backup_cases.py'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /restored-and-verified/);
});
