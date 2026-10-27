import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LanService, MemoryStore } from '../core/service.js';
import { MemberLimits, installMemberLimitAdmission, installMemberLimitPrompt } from '../carrier/limits.mjs';
import { foldNativePeriods } from '../carrier/usage.mjs';
import { installMemberModelStream } from '../carrier/models.mjs';
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
const at = Date.parse('2026-10-24T08:00:00Z');
function sample(time, inputTokens = 10, turn = 1) {
  return { type: 'assistant/attempt', time, data: { turn, step: 1, ...(inputTokens === null ? {} : { usage: { inputTokens, outputTokens: 2 } }) } };
}
async function fixture(t) {
  const coreStore = new MemoryStore(), cap = {}, store = new MemoryStore();
  const core = new LanService({ store: coreStore, hostCapability: cap }); await core.start(); t.after(() => core.close());
  const password = 'synthetic-quota-only-password';
  const admin = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true });
  const caller = { token: admin.token, csrf: admin.csrf }, users = {}, events = new Map();
  for (const username of ['alice', 'bob']) users[username] = (await core.execute({ action: 'admin.createUser', username, displayName: username, password }, caller)).user.id;
  let now = at;
  const usage = { ready: true, periods: new Map(), async refresh() { this.periods = new Map(Object.entries(users).map(([, id]) => [id, foldNativePeriods(events.get(id) ?? [], undefined, now)])); } };
  const options = { core, coreStore, hostCapability: cap, store, usage, now: () => now };
  const limits = await new MemberLimits(options).start();
  const update = (id, value) => limits.update({ action: 'admin.updateLimits', userId: id, expectedRevision: limits.policy(id).revision, ...value }, caller);
  return { ...options, limits, caller, users, events, update, setNow: value => { now = value; }, password };
}

test('limits default to unlimited; only administrators with CSRF can persist them', async t => {
  const f = await fixture(t), id = f.users.alice;
  assert.deepEqual(f.limits.policy(id), { revision: 0, maxConcurrent: null, dailyTokens: null, monthlyTokens: null });
  await f.update(id, { maxConcurrent: 2, dailyTokens: 100, monthlyTokens: 500 });
  const resumed = await new MemberLimits(f).start();
  assert.equal(resumed.policy(id).monthlyTokens, 500);
  const member = await f.core.execute({ action: 'login', username: 'alice', password: f.password });
  const request = { action: 'admin.updateLimits', userId: id, expectedRevision: 1, maxConcurrent: 1 };
  await assert.rejects(f.limits.update(request, { token: member.token, csrf: member.csrf }), { code: 'FORBIDDEN' });
  await assert.rejects(f.limits.update(request, { token: f.caller.token, csrf: 'invalid' }), { code: 'CSRF_INVALID' });
  await assert.rejects(f.update(id, { dailyTokens: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.limits.update({ ...request, expectedRevision: 0 }, f.caller), { code: 'LIMITS_CONFLICT' });
});

test('concurrent admissions reserve atomically per account and release exactly once', async t => {
  const f = await fixture(t), a = f.users.alice, b = f.users.bob;
  await f.update(a, { maxConcurrent: 3 }); await f.update(b, { maxConcurrent: 1 });
  const result = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => f.limits.stream(a, 'a-' + i)));
  const leases = result.filter(x => x.status === 'fulfilled').map(x => x.value);
  assert.equal(leases.length, 3);
  assert.ok(result.filter(x => x.status === 'rejected').every(x => x.reason.code === 'MEMBER_CONCURRENCY_LIMIT'));
  const other = await f.limits.stream(b, 'b'); other.close();
  leases[0].close(); leases[0].close();
  const next = await f.limits.stream(a, 'a-next'); assert.equal(f.limits.snapshot(a).active, 3);
  for (const lease of [...leases, next]) lease.close();
  assert.equal(f.limits.snapshot(a).active, 0);
});

test('calendar budgets count retries once, separate days and months, and roll over in Asia/Shanghai', async t => {
  const f = await fixture(t), id = f.users.alice;
  const events = [sample(at - 86400000, 20, 1), sample(at, 10, 2)];
  f.events.set(id, events);
  await f.update(id, { dailyTokens: 12, monthlyTokens: 100 });
  await assert.rejects(f.limits.prepare(id), { code: 'MEMBER_DAILY_TOKEN_LIMIT' });
  await f.update(id, { dailyTokens: 50, monthlyTokens: 34 });
  await assert.rejects(f.limits.prepare(id), { code: 'MEMBER_MONTHLY_TOKEN_LIMIT' });
  f.setNow(Date.parse('2026-11-01T00:00:00+08:00'));
  await f.limits.prepare(id);
  assert.equal(f.limits.snapshot(id).usage.daily.totalTokens, 0);
  assert.equal(f.limits.snapshot(id).usage.monthly.totalTokens, 0);
});

test('unknown or unavailable usage blocks only configured token budgets, never becomes zero', async t => {
  const f = await fixture(t), id = f.users.alice;
  f.events.set(id, [sample(at, null)]);
  await f.limits.prepare(id);
  await f.update(id, { dailyTokens: 100 });
  await assert.rejects(f.limits.prepare(id), { code: 'MEMBER_USAGE_UNAVAILABLE' });
  assert.equal(f.limits.snapshot(id).usage.daily.unknownCalls, 1);
  f.events.set(id, [sample(at - 86400000, null)]);
  await f.limits.prepare(id);
  await f.update(id, { monthlyTokens: 100 });
  await assert.rejects(f.limits.prepare(id), { code: 'MEMBER_USAGE_UNAVAILABLE' });
  await f.update(id, { dailyTokens: null, monthlyTokens: null });
  f.usage.refresh = async () => { throw new Error('ledger unavailable'); };
  await f.limits.prepare(id);
});

test('parent, child and reminder wakeups share slots; rejection leaves native inbox untouched', async t => {
  const f = await fixture(t), id = f.users.alice;
  await f.update(id, { maxConcurrent: 1 });
  function agent(name) {
    const idle = Promise.withResolvers();
    return { id: name, inbox: [], send(input, target, wake) { this.inbox.push(input); if (wake) this.wakeDriver(); }, wakeDriver() {}, runMaintenance(job) { return job(); }, whenIdle() { return idle.promise; }, end: idle.resolve };
  }
  const a = agent('parent'), child = agent('child'), b = agent('other-user');
  const restores = [installMemberLimitAdmission(a, f.limits, id), installMemberLimitAdmission(child, f.limits, id), installMemberLimitAdmission(b, f.limits, f.users.bob)];
  t.after(() => restores.forEach(fn => fn()));
  a.send({ source: { kind: 'user-rpc' } }, 'next-turn', true);
  assert.throws(() => child.send({ source: { kind: 'schedule' } }, 'next-turn', true), { code: 'MEMBER_CONCURRENCY_LIMIT' });
  assert.equal(child.inbox.length, 0);
  b.send({}, 'next-turn', true);
  a.end(); await new Promise(resolve => setImmediate(resolve));
  child.send({ source: { kind: 'schedule' } }, 'next-turn', true);
  assert.equal(child.inbox.length, 1); child.end(); b.end();
});

test('actual native LLM and Agent drivers enforce quotas without cancelling in-flight requests', { skip: !modules, timeout: 25000 }, async t => {
  const f = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'dsh-native-limits-'));
  const native = await publicMemberAccessFixture({ modules, directory });
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
  const brands = await load('dsh-llm'), fibers = [], handles = [], pending = new Map();
  const mount = async (module, config) => { const fiber = native.host.plugin(module, config); fibers.push(fiber); await fiber.await(); };
  t.after(async () => { try { for (const handle of handles) { handle.agent.cancel({ kind: 'user' }); await handle.dispose(); } for (const fiber of fibers.reverse()) await fiber.dispose(); } finally { await native.close(); await rm(directory, { recursive: true }); } });
  class Adapter extends brands.LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id }; }
    async *stream(options) {
      yield { type: 'text-delta', index: 0, text: 'synthetic' };
      await new Promise((resolve, reject) => {
        pending.set(options.sessionId, resolve);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  await mount(ctx => ctx.get('llm').registerAdapter(['offline-member-proof'], new Adapter()));
  await mount((await load('dsh-tools')).default);
  await mount((await load('dsh-system-prompt')).default, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount((await load('dsh-agent-loop')).default, {});
  const ownerOf = sessionId => sessionId === 'limits-bob' ? f.users.bob : f.users.alice;
  const models = { requestUser: options => ownerOf(options.sessionId), auxiliaryOptions: async (_, options) => options,
    async authorize() { return { signal: new AbortController().signal, assertCurrent() {}, close() {} }; } };
  const restore = installMemberModelStream(native.host.get('llm'), { models, limits: f.limits, ...brands }); t.after(restore);
  for (const sessionId of ['limits-alice', 'limits-child', 'limits-bob']) {
    const handle = await native.host.get('agents').create({ sessionId, agentOptions: { provider: 'offline-member-proof', model: 'offline' }, meta: { cwd: directory } });
    handles.push(handle);
    const remove = installMemberLimitAdmission(handle.agent, f.limits, ownerOf(sessionId)); t.after(remove);
  }
  const [a, child, b] = handles.map(h => h.agent);
  await f.update(f.users.alice, { maxConcurrent: 1 });
  const prompt = { content: [{ type: 'text', text: 'synthetic request' }], source: { kind: 'user', rpcId: 'quota-replay-proof' } };
  a.followup(prompt);
  for (let n = 0; !pending.has(a.id); n++) { assert.ok(n < 100, 'native model began: ' + JSON.stringify(a.session.log?.slice(-4))); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.throws(() => child.followup(prompt), { code: 'MEMBER_CONCURRENCY_LIMIT' });
  b.followup(prompt);
  for (let n = 0; !pending.has(b.id); n++) { assert.ok(n < 100); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.update(f.users.alice, { maxConcurrent: 1, dailyTokens: 0 });
  assert.equal(a.status, 'running', 'policy update leaves the current native request running');
  pending.get(a.id)(); pending.get(b.id)();
  await Promise.all([a.whenIdle(), b.whenIdle()]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.limits.snapshot(f.users.alice).active, 0);
  assert.throws(() => child.followup(prompt), { code: 'MEMBER_DAILY_TOKEN_LIMIT' });
  const commands = native.host.get('sessionController').commands;
  const restorePrompt = installMemberLimitPrompt(commands, f.limits, ownerOf); t.after(restorePrompt);
  assert.deepEqual(await commands.prompt({ sessionId: a.id, requestId: 'quota-replay-proof', mode: 'queue', content: prompt.content }, prompt.source), { accepted: true }, 'already accepted native prompts remain idempotent after reaching quota');
  await assert.rejects(commands.prompt({ sessionId: a.id, requestId: 'new-quota-prompt', mode: 'queue', content: prompt.content }, { kind: 'user', rpcId: 'new-quota-prompt' }), { code: 'MEMBER_DAILY_TOKEN_LIMIT' });
});
