import test from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle, LanError } from '../core/service.js';

const PROJECT = `prj_${'a'.repeat(32)}`;
const OTHER = `prj_${'b'.repeat(32)}`;
const MINUTE = 60 * 1000;
const rejected = (promise, code) => assert.rejects(promise, (error) => error instanceof LanError && error.code === code);

async function fixture(t, options = {}) {
  const clock = { value: 0 };
  const stopped = [];
  const lifecycle = new Lifecycle({ now: () => clock.value,
    stopProject: async (projectId) => { stopped.push(projectId); return { stopped: true }; }, ...options });
  await lifecycle.attach(PROJECT, { confirmedRunning: true });
  t.after(() => lifecycle.close());
  return { clock, stopped, lifecycle };
}

test('default 15-minute effective inactivity stops exactly at the deadline', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t);
  clock.value = 15 * MINUTE - 1;
  assert.equal((await lifecycle.tick())[0].state, 'running'); assert.equal(stopped.length, 0);
  clock.value += 1;
  const [view] = await lifecycle.tick();
  assert.equal(view.state, 'stopped'); assert.equal(view.stopAttempts, 1); assert.deepEqual(stopped, [PROJECT]);
  clock.value += 100 * MINUTE;
  await lifecycle.tick(); assert.equal(stopped.length, 1);
});

test('heartbeat, background, output and poll never renew effective activity', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t);
  for (const [index, event] of ['heartbeat', 'background', 'output', 'poll'].entries()) {
    clock.value = (index + 1) * 3 * MINUTE;
    const view = await lifecycle.activity(PROJECT, event);
    assert.equal(view.lastActivityAt, 0); assert.equal(view.idleDeadline, 15 * MINUTE);
  }
  clock.value = 15 * MINUTE;
  assert.equal((await lifecycle.tick())[0].state, 'stopped'); assert.equal(stopped.length, 1);
});

test('only supported effective inputs reset idle time using the server clock', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t);
  for (const event of ['user-input', 'terminal-input', 'preview-input']) {
    clock.value += 10 * MINUTE;
    const view = await lifecycle.activity(PROJECT, event);
    assert.equal(view.lastActivityAt, clock.value);
    assert.equal((await lifecycle.tick())[0].state, 'running');
  }
  await rejected(lifecycle.activity(PROJECT, 'made-up'), 'INVALID_INPUT');
  clock.value += 15 * MINUTE;
  await lifecycle.tick(); assert.equal(stopped.length, 1);
});

test('managed foreground leases hold execution; final release restarts the entire idle clock', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t, { foregroundLeaseMs: 15 * MINUTE });
  clock.value = 14 * MINUTE;
  const first = await lifecycle.acquireForeground(PROJECT);
  clock.value += MINUTE;
  const second = await lifecycle.acquireForeground(PROJECT);
  clock.value = 25 * MINUTE;
  assert.equal((await lifecycle.tick())[0].activeForeground, 2); assert.equal(stopped.length, 0);
  await lifecycle.releaseForeground(PROJECT, first.leaseId);
  assert.equal((await lifecycle.snapshot())[0].activeForeground, 1);
  clock.value = 26 * MINUTE;
  const released = await lifecycle.releaseForeground(PROJECT, second.leaseId);
  assert.equal(released.lastActivityAt, clock.value); assert.equal(released.idleDeadline, 41 * MINUTE);
  clock.value = 41 * MINUTE - 1; await lifecycle.tick(); assert.equal(stopped.length, 0);
  clock.value += 1; await lifecycle.tick(); assert.equal(stopped.length, 1);
});

test('trusted ongoing operations may renew leases; passive output cannot renew them', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t, { foregroundLeaseMs: 5 * MINUTE });
  const lease = await lifecycle.acquireForeground(PROJECT);
  for (let index = 1; index <= 10; index += 1) {
    clock.value = index * 4 * MINUTE;
    const renewed = await lifecycle.renewForeground(PROJECT, lease.leaseId);
    assert.equal(renewed.expiresAt, clock.value + 5 * MINUTE);
    await lifecycle.activity(PROJECT, 'output');
    assert.equal((await lifecycle.tick())[0].activeForeground, 1);
  }
  assert.equal(stopped.length, 0);
  clock.value += MINUTE;
  const released = await lifecycle.releaseForeground(PROJECT, lease.leaseId);
  assert.equal(released.lastActivityAt, 41 * MINUTE);
  clock.value += 15 * MINUTE;
  await lifecycle.tick(); assert.equal(stopped.length, 1);
});

test('abandoned operation lease is bounded; sparse polls cannot extend its expiry', async (t) => {
  const { lifecycle, clock, stopped } = await fixture(t);
  const lease = await lifecycle.acquireForeground(PROJECT);
  assert.equal(lease.expiresAt, 5 * MINUTE);
  clock.value = 4 * MINUTE;
  await lifecycle.activity(PROJECT, 'output');
  clock.value = 20 * MINUTE;
  assert.equal((await lifecycle.tick())[0].state, 'stopped'); assert.equal(stopped.length, 1);
  await rejected(lifecycle.renewForeground(PROJECT, lease.leaseId), 'LEASE_EXPIRED');
});

test('failed or unconfirmed stop remains stop-failed and retries after a bounded delay', async (t) => {
  let attempts = 0;
  const { lifecycle, clock } = await fixture(t, { stopProject: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('adapter failure');
    if (attempts === 2) return { stopped: false };
    return { stopped: true };
  } });
  clock.value = 15 * MINUTE;
  let [view] = await lifecycle.tick();
  assert.equal(view.state, 'stop-failed'); assert.equal(view.retryAt, clock.value + 30000);
  clock.value += 29999; await lifecycle.tick(); assert.equal(attempts, 1);
  clock.value += 1; [view] = await lifecycle.tick(); assert.equal(view.state, 'stop-failed');
  clock.value += 30000; [view] = await lifecycle.tick(); assert.equal(view.state, 'stopped');
  assert.equal(attempts, 3);
});

test('a runtime restart invalidates old stopped/running state and leases', async (t) => {
  const { lifecycle, clock } = await fixture(t);
  await lifecycle.attach(OTHER); // Recovered attachment is unknown, never presumed stopped.
  assert.equal((await lifecycle.snapshot())[1].state, 'unknown');
  await rejected(lifecycle.acquireForeground(OTHER), 'RUNTIME_UNCONFIRMED');
  clock.value = 15 * MINUTE;
  await lifecycle.tick();
  assert.ok((await lifecycle.snapshot()).every((view) => view.state === 'stopped'));
  clock.value += MINUTE;
  const views = await lifecycle.runtimeRestarted();
  assert.ok(views.every((view) => view.state === 'unknown' && view.lastActivityAt === clock.value));
  assert.equal((await lifecycle.tick())[0].state, 'unknown');
  await rejected(lifecycle.acquireForeground(PROJECT), 'RUNTIME_UNCONFIRMED');
});

test('restart cancels a hung stop and ignores its late stopped acknowledgement', async (t) => {
  let acknowledge;
  let signal;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const { lifecycle, clock } = await fixture(t, { stopProject: async (_projectId, options) => {
    signal = options.signal;
    started();
    return new Promise((resolve) => { acknowledge = resolve; });
  } });
  clock.value = 15 * MINUTE;
  const ticking = lifecycle.tick();
  await entered;
  const restarting = lifecycle.runtimeRestarted();
  await ticking;
  const [view] = await restarting;
  assert.equal(signal.aborted, true); assert.equal(view.state, 'unknown');
  acknowledge({ stopped: true });
  await Promise.resolve();
  assert.equal((await lifecycle.snapshot())[0].state, 'unknown');
});

test('hung adapter stop has a deadline and cannot permanently block snapshot', async (t) => {
  let signal;
  const { lifecycle, clock } = await fixture(t, { stopTimeoutMs: 5, stopProject: (_projectId, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  clock.value = 15 * MINUTE;
  assert.equal((await lifecycle.tick())[0].state, 'stop-failed');
  assert.equal(signal.aborted, true);
  assert.equal((await lifecycle.snapshot())[0].state, 'stop-failed');
});

test('policy never treats missing stop confirmation as success or accepts invalid leases', async (t) => {
  const { lifecycle, clock } = await fixture(t, { stopProject: async () => undefined });
  await rejected(lifecycle.releaseForeground(PROJECT, '../escape'), 'INVALID_INPUT');
  await rejected(lifecycle.activity('invalid', 'user-input'), 'INVALID_INPUT');
  clock.value = 15 * MINUTE;
  assert.equal((await lifecycle.tick())[0].state, 'stop-failed');
});
