import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';
import { memberAccessPolicy } from '../carrier/access.mjs';
import { pathToFileURL } from 'node:url';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;

// A non-owner "member" Peer on the SAME running Host. Every call below crosses
// the real Gateway -> the real SessionController -> the real Sessions service.
// The only authorization this suite adds is one public
// `ctx.remoteAccess.registerPolicy('lan-member', policy)` call; nothing here
// replaces, patches, or re-implements a product service, and no second server,
// port, browser, billing account, or project execution is involved.
const fixture = async (options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-public-member-'));
  const value = await publicMemberAccessFixture({ modules, directory, ...options });
  value.directory = directory;
  return value;
};
const ids = result => (result?.items ?? []).map(item => item.sessionId).sort();
const denied = (promise, action) => assert.rejects(promise, error => {
  assert.equal(error.code, 'remote-access/denied', `expected remote-access/denied, received ${error.code}: ${error.message}`);
  assert.match(error.message, new RegExp(`remote access: ${action}: access denied`));
  return true;
});

test('native forwarded session events update members without refresh and remain scoped to ownership', { skip: !modules, timeout: 60000 }, async t => {
  const host = await fixture({ memberPolicy: false });
  t.after(async () => { await host.close(); await fs.rm(host.directory, { recursive: true, force: true }); });
  let owned = ['alice-session'];
  const removePolicy = host.host.remoteAccess.registerPolicy('lan-member', memberAccessPolicy({
    sessionIdsOf: userId => userId === 'alice' ? owned : ['bob-session'],
  }));
  const Remotes = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-api-remotes/lib/index.js')).href);
  const events = host.host.plugin(Remotes);
  await events.await();
  const controller = new AbortController();
  const stream = await host.host.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), host.peer('alice'), controller.signal);
  const iterator = stream[Symbol.asyncIterator]();
  t.after(async () => { controller.abort(); await iterator.return(); await events.dispose(); removePolicy(); });
  assert.equal((await iterator.next()).value.type, 'ready');
  const next = async () => {
    let timer;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Session event was not delivered')), 2000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  // Events from another member and global credential events must not leak.
  host.host.emit('api-session/status', 'bob-session', true);
  host.host.emit('credentials/record-updated', 'private-record');
  for (const running of [true, false]) {
    host.host.emit('api-session/status', 'alice-session', running);
    assert.deepEqual((await next()).value, { type: 'emit', event: 'api-session/status', args: ['alice-session', running] });
  }
  for (const [event, args] of [
    ['api-session/activity', ['alice-session', 123456789]],
    ['api-session/added', [{ sessionId: 'alice-session' }]],
    ['api-session/error', ['alice-session', 'test error']],
    ['api-session/removed', ['alice-session']],
  ]) {
    host.host.emit(event, ...args);
    assert.deepEqual((await next()).value, { type: 'emit', event, args });
  }
  // Authorization is re-evaluated for an already-connected event stream.
  owned = ['new-session'];
  host.host.emit('api-session/status', 'alice-session', true);
  host.host.emit('api-session/status', 'new-session', true);
  assert.deepEqual((await next()).value.args, ['new-session', true]);
});

test('one running Host: a lan-member Peer reads and is denied through the original Gateway, RemoteAccess, SessionController and Sessions services', { skip: !modules, timeout: 60000 }, async t => {
  const host = await fixture();
  t.after(() => host.close());
  t.after(() => fs.rm(host.directory, { recursive: true, force: true }));

  await t.test('the owner Peer sees every persisted Session', async () => {
    const listed = await host.rpc('owner', 'session/list', { _request: {} });
    assert.deepEqual(ids(listed), ['alice-session', 'bob-session']);
    for (const row of listed.items) assert.equal(path.isAbsolute(row.cwd), true, 'persisted Session rows carry an absolute project root');
    assert.notEqual(listed.items.find(row => row.sessionId === 'alice-session').cwd, listed.items.find(row => row.sessionId === 'bob-session').cwd);
  });

  await t.test('the alice member Peer sees only the Session her policy grants', async () => {
    const listed = await host.rpc('alice', 'session/list', { _request: {} });
    assert.deepEqual(ids(listed), ['alice-session']);
    const bob = await host.rpc('bob', 'session/list', { _request: {} });
    assert.deepEqual(ids(bob), ['bob-session'], 'a different member is scoped to a different Session, not to alice\'s');
  });

  await t.test('the same scoping holds over the shared HTTP fetch transport', async () => {
    const owner = await host.http('owner', 'session/list', { _request: {} });
    assert.equal(owner.status, 200);
    assert.equal(owner.result.ok, true);
    assert.deepEqual(ids(owner.result.value), ['alice-session', 'bob-session']);
    const alice = await host.http('alice', 'session/list', { _request: {} });
    assert.equal(alice.status, 200);
    assert.deepEqual(ids(alice.result.value), ['alice-session'], 'non-owner transport path applies the same policy');
  });

  await t.test('alice is denied bob\'s Session on both the page and the follow carrier', async () => {
    await denied(host.rpc('alice', 'session/page', { request: { address: { kind: 'session', sessionId: 'bob-session' }, throughSeq: -1 } }), 'session/page');
    await denied(host.stream('alice', 'session/follow', { request: { address: { kind: 'session', sessionId: 'bob-session' }, throughSeq: -1 } }), 'session/follow');
    // The denial is about the address, not about the member: her own page is served.
    const own = await host.rpc('alice', 'session/page', { request: { address: { kind: 'session', sessionId: 'alice-session' }, throughSeq: -1 } });
    assert.deepEqual(Object.keys(own).sort(), ['hasMore', 'records']);
  });
});

test('with no lan-member policy registered the same member call fails closed', { skip: !modules, timeout: 60000 }, async t => {
  const host = await fixture({ memberPolicy: false });
  t.after(() => host.close());
  t.after(() => fs.rm(host.directory, { recursive: true, force: true }));

  assert.equal(host.registeredPolicy, false);
  await denied(host.rpc('alice', 'session/list', { _request: {} }), 'session/list');
  await assert.rejects(
    host.rpc('alice', 'session/list', { _request: {} }),
    error => error.code === 'remote-access/denied' && error.details?.reason === 'no-allow',
    'absence of a policy is no-allow, not an accidental allow',
  );
  // The owner is unaffected: no policy is needed for an owner Peer.
  assert.deepEqual(ids(await host.rpc('owner', 'session/list', { _request: {} })), ['alice-session', 'bob-session']);
  // Registering the public policy afterwards is the only change needed to serve her.
  host.registerPolicy();
  assert.deepEqual(ids(await host.rpc('alice', 'session/list', { _request: {} })), ['alice-session']);
});
