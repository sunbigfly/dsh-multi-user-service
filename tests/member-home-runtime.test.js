import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberHomeRuntime } from '../carrier/home-runtime.mjs';

test('native home allocation preserves canonical private roots without allocating a worker', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'member-home-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'homes'), runtime = new MemberHomeRuntime({ projectRoot: root });
  assert.deepEqual(await runtime.directoryInfo(), { root });
  for (const userId of ['usr_' + 'a'.repeat(32), 'usr_' + 'b'.repeat(32)]) {
    assert.deepEqual(await runtime.ensureHome({ userId }), { root, userId, relativePath: userId });
    assert.equal((await stat(join(root, userId))).mode & 0o777, 0o700);
  }
  await mkdir(join(parent, 'public'), { mode: 0o755 });
  await assert.rejects(runtime.directoryInfo({ root: join(parent, 'public') }), { code: 'UNSAFE_PROJECT_ROOT' });
  await symlink(root, join(parent, 'alias'));
  await assert.rejects(runtime.directoryInfo({ root: join(parent, 'alias', 'child') }), { code: 'UNSAFE_PROJECT_ROOT' });
  for (const path of ['/etc/member', '/', '/home', parent + '/../escape']) await assert.rejects(runtime.directoryInfo({ root: path }), { code: 'INVALID_PROJECT_ROOT' });
  await runtime.close();
  await assert.rejects(runtime.ensureHome({ userId: 'usr_' + 'a'.repeat(32) }), { code: 'RUNTIME_UNAVAILABLE' });
});

test('execution check delegates to the native DSH provider and retains its reported enforcement', async () => {
  let calls = 0;
  const runtime = new MemberHomeRuntime({ checkExecution: async root => { calls++; assert.ok(root); return { argv: ['native-runner', 'node'], enforcement: 'partial' }; } });
  const result = await runtime.start();
  assert.equal(calls, 1);
  assert.equal(result.backend, 'dsh-native');
  assert.equal(result.enforcement, 'partial');
  assert.deepEqual(result.checks, ['native-sandbox']);
  await runtime.close();
  await assert.rejects(runtime.start(), { code: 'RUNTIME_UNAVAILABLE' });
});

test('unavailable native execution is reported without a plugin shell fallback', async () => {
  for (const checkExecution of [undefined, async () => ({ argv: ['node'], enforcement: 'none' }), async () => { throw new Error('native provider unavailable'); }]) {
    const runtime = new MemberHomeRuntime({ checkExecution });
    await assert.rejects(runtime.start());
    assert.equal(runtime.ready, false);
    await runtime.close();
  }
});
