import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, MemoryStore } from '../core/service.js';
import { createIsolationCheck } from '../runtime/isolation-check.mjs';

const request = { action: 'admin.checkIsolation' };
async function fixture(t) {
  const core = new LanService({ store: new MemoryStore() }); await core.start(); t.after(() => core.close());
  const admin = await core.execute({ action: 'bootstrap', username: 'isolation-admin', displayName: 'Admin', password: 'synthetic-isolation-only' }, { ownerBootstrap: true });
  const caller = { token: admin.token, csrf: admin.csrf };
  await core.execute({ action: 'admin.createUser', username: 'isolation-member', displayName: 'Member', password: 'synthetic-isolation-only', routeIds: [] }, caller);
  const login = await core.execute({ action: 'login', username: 'isolation-member', password: 'synthetic-isolation-only' });
  let calls = 0;
  const runtime = { ready: false, async start() { calls++; this.ready = true; this.capabilities = { ready: true, backend: 'dsh-native', checks: ['native-sandbox', 'foreign-private-detail'] }; return this.capabilities; } };
  const isolation = createIsolationCheck({ core, runtime, now: () => 42 });
  return { core, caller, admin, member: { token: login.token, csrf: login.csrf }, runtime, isolation, calls: () => calls };
}

test('isolation initialization requires live admin and CSRF, never runs from a snapshot', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.isolation.snapshot(), { status: 'unchecked', checkedAt: null, checks: [], restartRequired: false }); assert.equal(f.calls(), 0);
  await assert.rejects(f.isolation.check(request, f.member), { code: 'FORBIDDEN' });
  await assert.rejects(f.isolation.check(request, { token: f.caller.token }), { code: 'CSRF_INVALID' });
  await assert.rejects(f.isolation.check({ ...request, root: '/etc' }, f.caller), { code: 'INVALID_INPUT' }); assert.equal(f.calls(), 0);
  const result = await f.isolation.check(request, f.caller);
  assert.deepEqual(result, { status: 'ready', checkedAt: 42, checks: ['native-sandbox'], restartRequired: false });
  result.checks.push('mutated'); assert.equal(f.isolation.snapshot().checks.length, 1);
  const snapshot = await f.core.execute({ action: 'snapshot' }, f.caller); assert.equal(snapshot.projects.length, 0); assert.deepEqual(snapshot.user.routeIds, []);
  await f.core.execute({ action: 'logout' }, f.caller); await assert.rejects(f.isolation.check(request, f.caller), { code: 'UNAUTHENTICATED' }); assert.equal(f.calls(), 1);
});

test('failed enforcement and lost readiness never report successful checks or leak runtime errors', async t => {
  const f = await fixture(t);
  f.runtime.start = async () => { f.runtime.closed = true; throw Object.assign(new Error('SECRET host diagnostic'), { code: 'SECRET_CODE' }); };
  assert.deepEqual(await f.isolation.check(request, f.caller), { status: 'failed', checkedAt: 42, checks: [], code: 'ISOLATION_UNAVAILABLE', restartRequired: true });
  assert.doesNotMatch(JSON.stringify(f.isolation.snapshot()), /SECRET/);
  f.runtime.closed = false; f.runtime.start = async () => ({ ready: true, backend: 'dsh-native' });
  assert.equal((await f.isolation.check(request, f.caller)).status, 'failed');
  f.runtime.start = async () => { f.runtime.ready = true; return { ready: true, backend: 'host-shell' }; };
  assert.equal((await f.isolation.check(request, f.caller)).status, 'failed', 'wrong backend cannot manufacture a passed report');
});

test('authority queue remains held through the bounded initialization so password reset cannot race it', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.runtime.start = async () => { enter(); await gate; f.runtime.ready = true; return { ready: true, backend: 'dsh-native' }; };
  const checking = f.isolation.check(request, f.caller); await entered;
  let changed = false;
  const reset = f.core.execute({ action: 'admin.resetPassword', userId: f.admin.user.id, password: 'new-synthetic-password' }, f.caller).finally(() => { changed = true; }).catch(() => {});
  assert.equal(changed, false); release(); assert.equal((await checking).status, 'ready'); await reset;
});
