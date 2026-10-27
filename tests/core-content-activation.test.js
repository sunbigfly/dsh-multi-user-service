import test from 'node:test';
import assert from 'node:assert/strict';
import { LanService, LanError, MemoryStore } from '../core/service.js';

const PASSWORD = 'shared-content-activation-test-password';
const REVISION_A = 'a1'.repeat(32), REVISION_B = 'b2'.repeat(32);
const metadataA = { skills: [{ id: 'skill-alpha', label: 'Alpha skill' }], mcp: [{ id: 'mcp-alpha', label: 'Alpha MCP' }], agents: [{ id: 'agent-alpha', label: 'Alpha agent' }] };
const metadataB = { skills: [{ id: 'skill-beta', label: 'Beta skill' }], mcp: [{ id: 'mcp-beta', label: 'Beta MCP' }], agents: [{ id: 'agent-beta', label: 'Beta agent' }] };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const context = session => ({ token: session.token, csrf: session.csrf });
const request = (service, action, data = {}, session) => service.execute({ action, ...data }, session ? context(session) : {});
const rejects = (promise, code, status) => assert.rejects(promise, error => {
  assert.ok(error instanceof LanError); assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});
class ObservedStore extends MemoryStore {
  writes = [];
  beforeSave = null;
  async save(state) {
    this.writes.push(structuredClone(state));
    if (this.beforeSave) await this.beforeSave(structuredClone(state));
    await super.save(state);
  }
}
async function setup(t, store = new ObservedStore()) {
  const service = new LanService({ store, now: () => 1000 });
  await service.start(); t.after(() => service.close());
  const admin = await service.execute({ action: 'bootstrap', username: 'owner', displayName: 'Owner', password: PASSWORD }, { ownerBootstrap: true });
  return { service, store, admin };
}

// Exercise the real state service and persistence contract, not a model of the
// publish algorithm. The content token and its catalog must be one durable
// environment document, never two independently visible publications.
test('content activation commits revision and all environment metadata in one durable transaction', async t => {
  const { service, store, admin } = await setup(t);
  const oldEnvironment = (await store.load()).environment;
  const entered = deferred(), release = deferred();
  store.beforeSave = async () => { entered.resolve(); await release.promise; };
  const initialWrites = store.writes.length;
  let published = false, readFinished = false;
  const publishing = request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: REVISION_A }, admin).then(value => { published = true; return value; });
  await entered.promise;
  assert.equal(store.writes.length, initialWrites + 1, 'one whole-state save, not token then catalog');
  assert.deepEqual(store.writes.at(-1).environment, { version: 1, contentRevision: REVISION_A, ...metadataA });
  assert.deepEqual((await store.load()).environment, oldEnvironment, 'durable state remains the prior complete document until save commits');
  const snapshot = request(service, 'snapshot', {}, admin).then(value => { readFinished = true; return value; });
  await flush(); assert.equal(published, false); assert.equal(readFinished, false, 'reads queue behind durable publication');
  release.resolve();
  const result = await publishing;
  assert.deepEqual(result.environment, { version: 1, contentRevision: REVISION_A, ...metadataA });
  assert.deepEqual((await snapshot).admin.environment, result.environment);
  assert.deepEqual((await store.load()).environment, result.environment);
  result.environment.skills[0].label = 'caller mutation';
  assert.equal((await request(service, 'snapshot', {}, admin)).admin.environment.skills[0].label, 'Alpha skill');
});

test('content activation save failure preserves previous revision/catalog/version and retry publishes once', async t => {
  const { service, store, admin } = await setup(t);
  await request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: REVISION_A }, admin);
  const before = await store.load();
  store.beforeSave = async () => { throw new Error('simulated storage outage'); };
  await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B }, admin), 'STORAGE_FAILURE', 503);
  assert.deepEqual(await store.load(), before);
  assert.deepEqual((await request(service, 'snapshot', {}, admin)).admin.environment, before.environment);
  assert.deepEqual(store.writes.at(-1).environment, { version: 2, contentRevision: REVISION_B, ...metadataB }, 'failed draft contains both token and catalog');
  store.beforeSave = null;
  const retry = await request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B }, admin);
  assert.deepEqual(retry.environment, { version: 2, contentRevision: REVISION_B, ...metadataB }, 'failed publication did not consume a version');
  assert.deepEqual((await store.load()).environment, retry.environment);
});

test('content revision accepts lowercase 64-hex or null and omitted legacy publication clears token atomically', async t => {
  const { service, store, admin } = await setup(t);
  let version = 0;
  for (const token of ['0'.repeat(64), '0123456789abcdef'.repeat(4), REVISION_A, null]) {
    const { environment } = await request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: token }, admin);
    assert.equal(environment.version, ++version); assert.equal(environment.contentRevision, token);
    assert.deepEqual((await store.load()).environment, environment);
  }
  await request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: REVISION_B }, admin); version++;
  const omitted = await request(service, 'admin.publishEnvironment', metadataB, admin);
  assert.deepEqual(omitted.environment, { version: ++version, contentRevision: null, ...metadataB });
  assert.deepEqual((await store.load()).environment, omitted.environment);
});

test('invalid activation tokens and invalid catalogs never save or partially publish', async t => {
  const { service, store, admin } = await setup(t);
  await request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: REVISION_A }, admin);
  const before = await store.load(), writes = store.writes.length;
  const invalid = ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${REVISION_A}`, `${REVISION_A}\n`, 123, false, [], {}, { revision: REVISION_B }];
  for (const contentRevision of invalid) await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision }, admin), 'INVALID_INPUT');
  await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, skills: ['duplicate', 'duplicate'], contentRevision: REVISION_B }, admin), 'INVALID_INPUT');
  await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B, activationOverride: true }, admin), 'INVALID_INPUT');
  assert.equal(store.writes.length, writes);
  assert.deepEqual(await store.load(), before);
  assert.deepEqual((await request(service, 'snapshot', {}, admin)).admin.environment, before.environment);
});

test('legacy persisted environment without content token still loads, logs in and can migrate on publication', async t => {
  const { store } = await setup(t);
  const legacy = await store.load();
  legacy.environment = { version: 7, ...structuredClone(metadataA) };
  assert.equal(Object.hasOwn(legacy.environment, 'contentRevision'), false);
  const legacyStore = new ObservedStore(legacy), service = new LanService({ store: legacyStore, now: () => 1000 });
  await service.start(); t.after(() => service.close());
  assert.equal(legacyStore.writes.length, 0, 'loading legacy data does not rewrite or silently activate content');
  const admin = await request(service, 'login', { username: 'owner', password: PASSWORD });
  assert.deepEqual((await request(service, 'snapshot', {}, admin)).admin.environment, legacy.environment);
  const published = await request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B }, admin);
  assert.deepEqual(published.environment, { version: 8, contentRevision: REVISION_B, ...metadataB });
  assert.deepEqual((await legacyStore.load()).environment, published.environment);
});

test('invalid stored activation tokens fail closed during service startup', async t => {
  const { store } = await setup(t);
  const good = await store.load();
  for (const token of ['', 'abc', 'F'.repeat(64), 'z'.repeat(64), false, 0, [], {}]) {
    const corrupt = structuredClone(good); corrupt.environment.contentRevision = token;
    const invalidStore = new ObservedStore(corrupt), service = new LanService({ store: invalidStore });
    await rejects(service.start(), 'STORAGE_INVALID', 503);
    await rejects(request(service, 'status'), 'SERVICE_UNAVAILABLE', 503);
    assert.equal(invalidStore.writes.length, 0); await service.close();
  }
});

test('members cannot publish activation tokens or observe administrator catalog/token', async t => {
  const { service, store, admin } = await setup(t);
  await request(service, 'admin.publishEnvironment', { ...metadataA, contentRevision: REVISION_A }, admin);
  await request(service, 'admin.createUser', { username: 'member', displayName: 'Member', password: PASSWORD, routeIds: [] }, admin);
  const member = await request(service, 'login', { username: 'member', password: PASSWORD });
  const before = await store.load(), writes = store.writes.length;
  await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B }, member), 'FORBIDDEN', 403);
  await rejects(service.execute({ action: 'admin.publishEnvironment', ...metadataB, contentRevision: REVISION_B }, { token: admin.token }), 'CSRF_INVALID', 403);
  await rejects(request(service, 'admin.publishEnvironment', { ...metadataB, contentRevision: REVISION_B }), 'UNAUTHENTICATED', 401);
  const snapshot = await request(service, 'snapshot', {}, member);
  assert.equal(Object.hasOwn(snapshot, 'admin'), false);
  assert.equal(JSON.stringify(snapshot).includes(REVISION_A), false);
  assert.equal(store.writes.length, writes); assert.deepEqual(await store.load(), before);
});
