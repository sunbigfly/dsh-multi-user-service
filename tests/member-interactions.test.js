import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicMemberAccessFixture } from '../verification/public-member-access.mjs';
import { installMemberInteractions } from '../carrier/interactions.mjs';

const modules = process.env.DSH_LAN_CONTRACT_MODULES;
test('native interaction gateway isolates replies, preserves owner handling and redelivers after reconnect', { skip: !modules, timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-member-interactions-'));
  const f = await publicMemberAccessFixture({ modules, directory });
  const { createScope } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-scope/lib/index.js')).href);
  const gateway = f.host.typertGateway, controls = [], streams = [], scopes = [], enabled = { alice: true, bob: true };
  const ownerOf = id => id === 'alice-session' ? 'alice' : id === 'bob-session' ? 'bob' : undefined;
  const restore = installMemberInteractions(gateway, { ownership: { ownerOf }, capabilities: { policy: userId => ({ interactions: enabled[userId] }) } });
  const unregister = gateway.registerRemoteEvents(async function*(signal) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }, { home: '/synthetic-owner-home' });
  t.after(async () => {
    for (const control of controls) control.abort();
    for (const stream of streams) await stream.return().catch(() => {});
    for (const scope of scopes) await scope.dispose();
    await unregister(); restore(); await f.close(); await rm(directory, { recursive: true });
  });
  const agents = {};
  for (const name of ['alice', 'bob', 'owner']) {
    const agent = { id: name + '-session' };
    const scope = createScope(f.host, agent); agent.ctx = scope.ctx; scopes.push(scope); agents[name] = agent;
  }
  const open = async name => {
    const control = new AbortController(); controls.push(control);
    const stream = gateway.openRemoteEvents({ args: {} }, control.signal, f.peer(name)); streams.push(stream);
    const ready = (await stream.next()).value; assert.equal(ready.type, 'ready');
    return { control, stream, clientId: ready.clientId };
  };
  const request = (name, event = 'user-questions/request') => {
    const agent = agents[name], control = new AbortController(); controls.push(control);
    const done = Promise.withResolvers();
    const result = done.promise.then(value => ({ ok: true, value }), error => ({ ok: false, message: error.message }));
    gateway.startRemoteEvent({ event, request: { agent, signal: control.signal, prompt: 'Synthetic ' + name }, context: { value: agent.ctx, subject: agent, agentId: agent.id }, resolve: done.resolve, reject: done.reject });
    return { result, control };
  };
  const reply = (name, clientId, eventId, value = 'accepted') => f.http(name, '$events/result', { clientId, eventId, outcome: { kind: 'result', value } });
  let a = await open('alice'); const b = await open('bob');
  const first = request('alice'), frame = (await a.stream.next()).value;
  assert.equal(frame.agentId, 'alice-session');
  assert.equal(gateway.remoteEventClients.get(b.clientId).deliveries.size, 0);
  assert.equal(gateway.remoteEventClients.get(a.clientId).answers, false, 'member emit authorization is not promoted to owner');
  assert.equal((await reply('bob', a.clientId, frame.eventId)).result.ok, false);
  assert.equal((await reply('bob', b.clientId, frame.eventId)).result.ok, false);
  const otherLogin = f.host.connection.createPeer({ principal: { kind: 'lan-member', userId: 'alice', loginId: 'other' }, interactions: 'answer' });
  assert.equal((await gateway.dispatchRpc('$events/result', { args: { clientId: a.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'wrong connection' } } }, AbortSignal.timeout(1000), otherLogin)).ok, false);
  await otherLogin.dispose();
  assert.equal((await f.http('alice', '$events/result', { clientId: a.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'bad', extra: true } })).result.ok, false);
  assert.equal((await reply('alice', a.clientId, frame.eventId, 'ALICE')).result.ok, true);
  assert.deepEqual(await first.result, { ok: true, value: { kind: 'result', value: 'ALICE' } });
  assert.equal((await reply('alice', a.clientId, frame.eventId)).result.ok, false, 'settled requests cannot be replayed');

  const pending = request('alice', 'approval/request'), old = (await a.stream.next()).value, oldClient = a.clientId;
  a.control.abort(); await a.stream.return();
  a = await open('alice'); const resent = (await a.stream.next()).value;
  assert.equal(resent.eventId, old.eventId);
  assert.equal((await reply('alice', oldClient, old.eventId)).result.ok, false);
  assert.equal((await reply('alice', a.clientId, resent.eventId)).result.ok, true);
  assert.equal((await pending.result).ok, true);

  const rejected = request('alice', 'approval/request'), toReject = (await a.stream.next()).value;
  assert.equal((await f.http('alice', '$events/result', { clientId: a.clientId, eventId: toReject.eventId, outcome: { kind: 'rejected', error: { name: 'Error', message: 'User declined', code: 'DECLINED' } } })).result.ok, true);
  assert.deepEqual(await rejected.result, { ok: false, message: 'User declined' });

  const cancelled = request('alice'), toCancel = (await a.stream.next()).value;
  cancelled.control.abort(new Error('synthetic cancellation'));
  assert.equal((await cancelled.result).ok, false);
  assert.equal((await a.stream.next()).value.type, 'cancel');
  assert.equal((await reply('alice', a.clientId, toCancel.eventId)).result.ok, false);

  const revoked = request('alice'), toRevoke = (await a.stream.next()).value;
  enabled.alice = false;
  assert.equal((await reply('alice', a.clientId, toRevoke.eventId)).result.ok, false);
  revoked.control.abort(); await revoked.result; assert.equal((await a.stream.next()).value.type, 'cancel');
  assert.equal((await request('alice').result).ok, false, 'disabled interactions do not create hanging requests');
  const ownB = request('bob', 'approval/request'), bFrame = (await b.stream.next()).value;
  assert.equal(bFrame.agentId, 'bob-session');
  assert.equal((await reply('bob', b.clientId, bFrame.eventId)).result.ok, true); await ownB.result;

  const owner = await open('owner'), ownRequest = request('owner'), ownerFrame = (await owner.stream.next()).value;
  assert.equal((await reply('owner', owner.clientId, ownerFrame.eventId)).result.ok, true); await ownRequest.result;
  gateway.broadcastRemoteEvent({ event: 'synthetic-owner-only', args: ['private-owner-notification'] });
  const unseen = b.stream.next(); await Promise.resolve(); b.control.abort();
  assert.equal((await unseen).done, true, 'owner-only emits never enter the member stream');
});
