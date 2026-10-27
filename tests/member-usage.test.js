import { updateAccount } from './helpers/account-update.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanService, MemoryStore } from '../core/service.js';
import { NativeUsage, foldNativeUsage, nativeUsageRevisions } from '../carrier/usage.mjs';

test('first boot accepts an uninitialized account store but missing initialized state never becomes an empty usage report', async () => {
  let initialized = false, writes = 0;
  const usage = new NativeUsage({ coreStore: { async load() { return null; } },
    core: { async execute(args) { assert.equal(args.action, 'status'); return { initialized }; }, async setNativeUsage(rows) { writes++; return rows; } },
    ownership: { entriesOf() { throw new Error('No account should be read before setup'); } } });
  assert.deepEqual(await usage.refresh(), []); assert.equal(writes, 1); assert.equal(usage.ready, true);
  initialized = true;
  await assert.rejects(usage.refresh(), /account state is unavailable/);
  assert.equal(writes, 1, 'missing initialized state does not publish zero usage');
});
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';

test('retained deleted-account owners still contribute native usage without retaining login records', async () => {
  const visited = [];
  const usage = new NativeUsage({ coreStore: { load: async () => ({ users: [], retiredUsers: [{ id: 'historical-owner' }] }) },
    core: { setNativeUsage: async rows => rows }, ownership: { entriesOf(id) { visited.push(id); return [{ sessionId: 'retained-session' }]; } },
    query: { observeSession: async () => ({ events: [], inheritedEventCount: 0, [Symbol.dispose]() {} }) } });
  const rows = await usage.refresh(); assert.deepEqual(visited, ['historical-owner']); assert.equal(rows[0].userId, 'historical-owner');
  assert.equal(usage.periods.has('historical-owner'), true);
});

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('native usage replaces duplicate settlements, counts retries and compaction, and retains unknown calls', () => {
  const sample = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 2 };
  const event = (type, extra = {}) => ({ type, data: { turn: 1, step: 1, ...extra } });
  const result = foldNativeUsage([
    event('assistant/attempt', { usage: sample }), event('assistant/message', { usage: sample }),
    event('llm/retry-started'), event('assistant/message', { usage: sample }),
    event('assistant/attempt', { turn: 2 }),
    event('compaction/summary', { compactionId: 'c', llmStreamCall: true, usage: { inputTokens: 4, outputTokens: 1 } }),
  ]);
  assert.deepEqual(result, { calls: 4, inputTokens: 68, outputTokens: 7, totalTokens: 75, unknownCalls: 1, unavailableSessions: 0 });
});

test('native revision reads use one corpus list, prefer live cuts and reject missing or duplicate cold identities', async () => {
  let lists = 0;
  const sessions = { get: id => id === 'live' ? { seq: 7 } : undefined };
  const persistence = { async list() { lists++; return [
    { header: { id: 'live' }, revision: 'older' }, { header: { id: 'cold' }, revision: 'r1' },
    { header: { id: 'duplicate' }, revision: 'a' }, { header: { id: 'duplicate' }, revision: 'b' },
    { header: { id: 'unrelated-private' }, revision: 'ignored' },
  ]; }, async stat() { assert.fail('no repeated project-directory searches'); } };
  assert.deepEqual([...await nativeUsageRevisions(['live'], { sessions, persistence })], [['live', 'live:7']]);
  assert.equal(lists, 0);
  const revisions = await nativeUsageRevisions(['live', 'cold', 'missing', 'duplicate'], { sessions, persistence });
  assert.equal(lists, 1); assert.deepEqual([...revisions], [['live', 'live:7'], ['cold', 'stored:r1']]);
});

test('one revision batch serves all users, replays only changed logs and retains incomplete cached totals on failure', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `session-${i}`), now = Date.now();
  let lists = 0, reads = 0, fail = false, removed = false;
  const versions = new Map(ids.map(id => [id, 'v1']));
  const persistence = { async list() {
    lists++; if (fail) throw new Error('metadata unavailable');
    return ids.filter(id => !removed || id !== ids[0]).map(id => ({ header: { id }, revision: versions.get(id) }));
  } };
  const sessions = { get() {} };
  const usage = new NativeUsage({
    now: () => now, coreStore: { async load() { return { users: [{ id: 'a' }, { id: 'b' }] }; } },
    core: { async setNativeUsage(rows) { return rows; } },
    ownership: { entriesOf: userId => ids.slice(userId === 'a' ? 0 : 150, userId === 'a' ? 150 : 300).map(sessionId => ({ sessionId })) },
    revisions: entries => nativeUsageRevisions(entries, { sessions, persistence }),
    query: { async observeSession() { reads++; return { inheritedEventCount: 0, events: [{ type: 'assistant/message', time: now, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } }], [Symbol.dispose]() {} }; } },
  });
  const original = await usage.refresh(); assert.equal(lists, 1); assert.equal(reads, 300);
  assert.deepEqual(await usage.refresh(), original); assert.equal(lists, 2); assert.equal(reads, 300);
  versions.set(ids[0], 'v2'); await usage.refresh(); assert.equal(reads, 301);
  removed = true; const missing = await usage.refresh();
  assert.equal(missing[0].totalTokens, original[0].totalTokens); assert.equal(missing[0].unavailableSessions, 1);
  fail = true; const incomplete = await usage.refresh();
  assert.equal(reads, 301, 'unavailable revisions cannot reuse a successful-looking cut or trigger an unbounded fallback');
  for (const row of incomplete) { assert.equal(row.totalTokens, 300); assert.equal(row.unavailableSessions, 150); }
  assert.equal(usage.periods.get('a').daily.unavailableSessions, 150);
});

test('real native logs backfill account usage including disabled users, exclude fork seeds and survive repeated/cold reads', { skip: !modules, timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-'));
  const f = await publicMemberAccessFixture({ modules, directory });
  t.after(async () => { await f.close(); await rm(directory, { recursive: true }); });
  const { lastAssistantStreamChunk } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')).href);
  const coreStore = new MemoryStore(), cap = {}, core = new LanService({ store: coreStore, hostCapability: cap }); await core.start(); t.after(() => core.close());
  const password = 'synthetic-account-usage-password';
  const admin = await core.execute({ action: 'bootstrap', username: 'admin', displayName: 'Admin', password }, { ownerBootstrap: true });
  const auth = { token: admin.token, csrf: admin.csrf }, users = {};
  for (const name of ['alice', 'bob']) users[name] = (await core.execute({ action: 'admin.createUser', username: name, displayName: name, password }, auth)).user.id;
  const sessions = f.host.get('sessions');
  const append = (session, turn, input, output) => {
    session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 });
    session.append('assistant/attempt', { turn, step: 1, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output } } }] });
    session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  let a, b, child;
  const sessionFiber = f.host.plugin(ctx => {
    const store = ctx.get('sessions');
    a = store.create('usage-a', { meta: { cwd: directory } }); b = store.create('usage-b', { meta: { cwd: directory } });
    append(a, 1, 100, 5); append(b, 1, 10, 2);
    child = store.fork(a, undefined, 'usage-child'); append(child, 2, 7, 3);
  }); await sessionFiber.await(); t.after(() => sessionFiber.dispose());
  const owned = new Map([[users.alice, ['usage-a', 'usage-child']], [users.bob, ['usage-b']]]);
  const options = { core, coreStore, hostCapability: cap, query: f.host.get('sessionQuery'), ownership: { entriesOf: id => (owned.get(id) ?? []).map(sessionId => ({ sessionId })) }, lastUsage: stream => lastAssistantStreamChunk(stream, 'usage')?.usage };
  const usage = new NativeUsage(options);
  await assert.rejects(core.setNativeUsage([], {}), { code: 'FORBIDDEN' });
  let board = await usage.refresh(); const alice = value => value.users.find(x => x.displayName === 'alice');
  assert.equal(alice(board).calls, 2); assert.equal(alice(board).totalTokens, 115);
  assert.deepEqual(await usage.refresh(), board, 'refresh does not add a second copy');
  let reads = 0;
  const cached = new NativeUsage({ ...options, revision: async id => `live:${sessions.get(id).seq}`,
    query: { observeSession(...args) { reads++; return options.query.observeSession(...args); } } });
  await cached.refresh(); assert.equal(reads, 3);
  await cached.refresh(); assert.equal(reads, 3, 'unchanged source revisions reuse exact aggregates');
  await updateAccount(core, { action: 'admin.updateUser', userId: users.alice, disabled: true }, auth);
  assert.equal(alice(await new NativeUsage(options).refresh()).totalTokens, 115, 'disabled users retain historical usage');
  append(b, 2, 20, 4);
  await cached.refresh(); assert.equal(reads, 4, 'a new live event invalidates only its session aggregate');
  board = await usage.refresh(); assert.equal(board.users.find(x => x.displayName === 'bob').totalTokens, 36);
  for (const id of ['usage-a', 'usage-b', 'usage-child']) {
    const observed = await options.query.observeSession(id, { projectionMode: 'none' });
    const writer = await f.host.get('sessionPersistence').create(observed.header, { inheritedEventCount: observed.inheritedEventCount });
    try { await writer.append(observed.events); await writer.flush(); } finally { await writer.close(); observed[Symbol.dispose](); }
  }
  await sessionFiber.dispose();
  const cold = await options.query.observeSession('usage-a', { projectionMode: 'none' }); cold[Symbol.dispose]();
  assert.deepEqual(await new NativeUsage(options).refresh(), board, 'cold durable backfill matches live cuts');
  const persistence = f.host.get('sessionPersistence'), ids = ['usage-a', 'usage-b', 'usage-child'];
  const revisions = await nativeUsageRevisions(ids, { sessions, persistence });
  for (const id of ids) assert.equal(revisions.get(id), `stored:${(await persistence.stat(id)).revision}`, 'one native list has the same cold revision as the native single-session port');
  let batchReads = 0;
  const batched = new NativeUsage({ ...options, revisions: entries => nativeUsageRevisions(entries, { sessions, persistence }),
    query: { observeSession(...args) { batchReads++; return options.query.observeSession(...args); } } });
  assert.deepEqual(await batched.refresh(), board);
  assert.deepEqual(await batched.refresh(), board); assert.equal(batchReads, 3, 'real unchanged cold logs are not replayed a second time');
  const failing = new NativeUsage({ ...options, query: { async observeSession(id, opt) { if (id === 'usage-a') throw Error('Unavailable'); return options.query.observeSession(id, opt); } } });
  const partial = alice(await failing.refresh()); assert.equal(partial.incomplete, true); assert.equal(partial.unavailableSessions, 1);
  const publicText = JSON.stringify(board); for (const privateValue of [directory, users.alice, 'alice-session', 'usage-child', 'password', 'provider']) assert.equal(publicText.includes(privateValue), false);
});
