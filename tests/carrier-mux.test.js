import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { createMemberMuxConnection, createMemberMux } from '../carrier/mux.mjs';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; callbacks = []; auto = true;
  send(text, callback) { this.sent.push(JSON.parse(text)); if (this.auto) callback(); else this.callbacks.push(callback); }
  ping() { this.emit('pong'); }
  close(code, reason) { this.code = code; this.reason = reason; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006, 'terminated'); }
  frame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
}
function fixture(t, open, limits = {}) {
  const socket = new Socket(), control = new AbortController(), calls = [];
  let valid = true, authCalls = 0;
  const peer = { principal: { kind: 'lan-member', userId: 'member' }, signal: control.signal };
  const connection = createMemberMuxConnection({ socket, peer, wireStream: {
    async open(...args) { calls.push(args); return await open(...args); },
    failure(error) { return { code: error.code ?? 'test/failure', message: error.message, details: {} }; },
  }, authenticate: async () => { authCalls++; if (!valid) throw new Error('revoked'); }, parseClientMessage: parseRemoteStreamClientMessage,
    limits: { cleanupTimeoutMs: 100, sendTimeoutMs: 100, ...limits } });
  t.after(() => connection.close(1001, 'test ended'));
  return { connection, socket, peer, calls, revoke() { valid = false; }, dispose() { control.abort(); }, get authCalls() { return authCalls; } };
}
const openFrame = (streamId = 'one', endpoint = 'session/watch') => ({ type: 'open', streamId, endpoint, payload: { args: {} } });

test('mux speaks actual public frames with same member peer and passes business acknowledgement unchanged', async t => {
  const f = fixture(t, async function* (endpoint, payload, uplink, peer, signal) {
    assert.equal(endpoint, 'session/watch'); assert.deepEqual(payload, { args: {} });
    assert.equal(peer.principal.kind, 'lan-member'); assert.equal(signal.aborted, false);
    yield { type: 'flowControlAck', sequence: 1 }; yield { type: 'ack', sequence: 2 };
  });
  f.socket.frame(openFrame()); await flush();
  assert.deepEqual(f.socket.sent, [{ type: 'item', streamId: 'one', value: { type: 'flowControlAck', sequence: 1 } }, { type: 'item', streamId: 'one', value: { type: 'ack', sequence: 2 } }, { type: 'end', streamId: 'one' }]);
  assert.equal(f.calls[0][3], f.peer); assert.equal(f.connection.streamCount, 0); assert.equal(f.authCalls, 1);
});

test('forwarded-event ready preserves generation contract without owner home path', async t => {
  const f = fixture(t, async function* () {
    yield { type: 'ready', clientId: 'member-event-generation', host: { home: 'C:\\Users\\private-owner' } };
    yield { type: 'emit', event: 'safe-event', args: ['owned-session'] };
  });
  f.socket.frame(openFrame('events', '$events')); await flush();
  assert.deepEqual(f.socket.sent[0], { type: 'item', streamId: 'events', value: { type: 'ready', clientId: 'member-event-generation', host: { home: '' } } });
  assert.deepEqual(f.socket.sent[1].value, { type: 'emit', event: 'safe-event', args: ['owned-session'] });
  assert.equal(JSON.stringify(f.socket.sent).includes('private-owner'), false);
});

test('uplink items delivered before opener settles, half-close ends queue, iterator returned on completion', async t => {
  const gate = deferred(), values = []; let returned = 0;
  const f = fixture(t, async (_endpoint, _payload, uplink) => {
    await gate.promise;
    const source = (async function* () { for await (const value of uplink) { values.push(value); yield { received: value }; } })();
    const original = source.return.bind(source); source.return = (...args) => { returned++; return original(...args); }; return source;
  });
  f.socket.frame(openFrame()); f.socket.frame({ type: 'item', streamId: 'one', value: { sequence: 1 } }); f.socket.frame({ type: 'end', streamId: 'one' });
  await flush(); gate.resolve(); await flush();
  assert.deepEqual(values, [{ sequence: 1 }]); assert.equal(returned, 1);
  assert.equal(f.socket.sent.at(-1).type, 'end'); assert.equal(f.authCalls, 3);
});

test('cancel aborts blocked next and calls iterator.return without ending other logical streams', async t => {
  let returned = 0, signal;
  const pending = deferred();
  const f = fixture(t, async (_endpoint, _payload, _uplink, _peer, s) => {
    signal = s;
    return { [Symbol.asyncIterator]() { return this; }, next: () => pending.promise, return() { returned++; return Promise.resolve({ done: true }); } };
  });
  f.socket.frame(openFrame()); await flush();
  f.socket.frame({ type: 'cancel', streamId: 'one' }); await flush();
  assert.equal(signal.aborted, true); assert.equal(returned, 1); assert.equal(f.connection.streamCount, 0);
  assert.equal(f.socket.readyState, 1); assert.deepEqual(f.socket.sent, []);
  pending.resolve({ done: true });
});

test('opener resolving after cancel has its iterator returned', async t => {
  const opening = deferred(); let returned = 0;
  const f = fixture(t, () => opening.promise);
  f.socket.frame(openFrame()); await flush(); f.socket.frame({ type: 'cancel', streamId: 'one' }); await flush();
  opening.resolve({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => { returned++; return { done: true }; } });
  await flush(); assert.equal(returned, 1); assert.deepEqual(f.socket.sent, []);
});

test('uplink overflow and item after end fail only offending stream with stable terminal failure', async t => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise, { inboxBytes: 100 });
  f.socket.frame(openFrame()); await flush();
  f.socket.frame({ type: 'item', streamId: 'one', value: 'x'.repeat(80) }); await flush();
  assert.equal(f.socket.sent[0].type, 'error'); assert.equal(f.socket.sent[0].error.code, 'gateway/uplink-overflow');
  assert.equal(f.socket.readyState, 1);
  f.socket.frame(openFrame('two')); await flush(); f.socket.frame({ type: 'end', streamId: 'two' }); f.socket.frame({ type: 'item', streamId: 'two', value: 1 }); await flush();
  assert.equal(f.socket.sent.at(-1).error.code, 'gateway/protocol');
  pending.resolve({ async *[Symbol.asyncIterator]() {} });
});

test('duplicate identity and invalid/binary frames close socket, max streams is bounded', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise, { maxStreams: 1 });
  f.socket.frame(openFrame()); await flush(); f.socket.frame(openFrame('two')); await flush();
  assert.equal(f.socket.sent.at(-1).error.code, 'lan/stream-limit'); assert.equal(f.connection.streamCount, 1);
  f.socket.frame(openFrame()); await flush(); assert.equal(f.socket.code, 1008);
  const g = fixture(t, async function* () {}); g.socket.emit('message', Buffer.from('not JSON'), false); await flush(); assert.equal(g.socket.code, 1008);
  const h = fixture(t, async function* () {}); h.socket.emit('message', Buffer.from('{}'), true); await flush(); assert.equal(h.socket.code, 1003);
  pending.resolve({ async *[Symbol.asyncIterator]() {} });
});

test('per-frame fresh authentication and peer abort terminate revoked sockets and iterators', async t => {
  let returned = 0;
  const f = fixture(t, async () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => { returned++; return { done: true }; } }));
  f.socket.frame(openFrame()); await flush(); f.revoke(); f.socket.frame({ type: 'item', streamId: 'one', value: 'not admitted' }); await flush();
  assert.equal(f.socket.code, 1008); assert.equal(returned, 1); assert.equal(f.authCalls, 2);
  const g = fixture(t, async () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) }));
  g.socket.frame(openFrame()); await flush(); g.dispose(); await flush(); assert.equal(g.socket.code, 1001);
});

test('send callback backpressure prevents unbounded downstream iterator reads', async t => {
  let reads = 0;
  const f = fixture(t, async () => ({ [Symbol.asyncIterator]() { return this; }, next: async () => (++reads <= 2 ? { value: reads, done: false } : { done: true }), return: async () => ({ done: true }) }));
  f.socket.auto = false; f.socket.frame(openFrame()); await flush();
  assert.equal(reads, 1); assert.equal(f.socket.sent.length, 1);
  f.socket.callbacks.shift()(); await flush(); assert.equal(reads, 2); assert.equal(f.socket.sent.length, 2);
  f.socket.callbacks.shift()(); await flush(); assert.equal(f.socket.sent.at(-1).type, 'end');
  f.socket.callbacks.shift()(); await flush(); assert.equal(f.connection.streamCount, 0);
});

test('large history snapshots and live events use the output budget without raising client frame limits', async t => {
  const snapshot = { type: 'snapshot', cursor: 1, records: [{ text: '历史'.repeat(500000) }] };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024);
  let reads = 0;
  const f = fixture(t, async function* () {
    reads++; yield snapshot;
    reads++; yield { type: 'event', event: { seq: 2, text: '继续执行' } };
  });
  f.socket.auto = false; f.socket.frame(openFrame('history', 'session/follow')); await flush();
  assert.equal(reads, 1);
  assert.deepEqual(f.socket.sent[0], { type: 'item', streamId: 'history', value: snapshot });
  f.socket.callbacks.shift()(); await flush();
  assert.equal(reads, 2); assert.equal(f.socket.sent[1].value.event.seq, 2);
  f.socket.callbacks.shift()(); await flush();
  assert.equal(f.socket.sent[2].type, 'end');
  f.socket.callbacks.shift()(); await flush();
  assert.equal(f.connection.streamCount, 0); assert.equal(f.socket.readyState, 1);

  const g = fixture(t, async function* () {});
  g.socket.frame({ ...openFrame(), payload: { text: 'x'.repeat(256 * 1024) } }); await flush();
  assert.equal(g.socket.code, 1008, 'oversized client input remains rejected');
  assert.equal(g.calls.length, 0);
});

test('output byte overflow still rejects the offending stream and leaves other streams usable', async t => {
  const f = fixture(t, async function* (endpoint) {
    yield endpoint === 'large' ? 'x'.repeat(600) : 'ok';
  }, { outgoingBytes: 512, maxFrameBytes: 256 });
  f.socket.frame(openFrame('large', 'large')); await flush();
  assert.equal(f.socket.sent[0].type, 'error');
  assert.equal(f.socket.sent[0].error.code, 'lan/output-overflow');
  assert.equal(f.socket.readyState, 1);
  f.socket.frame(openFrame('small', 'small')); await flush();
  assert.deepEqual(f.socket.sent.slice(1), [{ type: 'item', streamId: 'small', value: 'ok' }, { type: 'end', streamId: 'small' }]);
});

test('authentication queue bytes are bounded before slow me resolves', async t => {
  const socket = new Socket(), check = deferred(), control = new AbortController();
  const c = createMemberMuxConnection({ socket, peer: { principal: { kind: 'lan-member' }, signal: control.signal }, wireStream: { open() {} }, authenticate: () => check.promise, parseClientMessage: parseRemoteStreamClientMessage, limits: { pendingBytes: 100, maxFrameBytes: 100, cleanupTimeoutMs: 30 } });
  t.after(() => c.close());
  socket.frame(openFrame()); socket.frame(openFrame('two')); await flush();
  assert.equal(socket.code, 1008); assert.ok(c.pendingBytes <= 100); check.resolve();
});

test('noServer adapter limits member physical generations without borrowing owner sockets', async () => {
  const clients = new Set();
  class Server {
    constructor(options) { this.options = options; this.clients = clients; }
    handleUpgrade(_req, _socket, _head, callback) { const ws = new Socket(); clients.add(ws); ws.once('close', () => clients.delete(ws)); callback(ws); }
    close(callback) { callback(); }
  }
  const control = new AbortController(), peer = { principal: { kind: 'lan-member' }, signal: control.signal };
  const mux = await createMemberMux({ wireStream: { async open() { return { async *[Symbol.asyncIterator]() {} }; } }, WebSocketServer: Server, limits: { peerConnections: 1, maxConnections: 2 }, parseClientMessage: parseRemoteStreamClientMessage });
  const raw1 = new EventEmitter(), raw2 = new EventEmitter(); let denied;
  raw2.end = text => { denied = text; };
  mux.handleUpgrade({}, raw1, Buffer.alloc(0), peer, async () => {});
  mux.handleUpgrade({}, raw2, Buffer.alloc(0), peer, async () => {});
  assert.match(denied, /429/); assert.equal(clients.size, 1);
  await mux.close(); assert.equal(clients.size, 0);
});

test('real public ws noServer adapter is constructible without a listener', async () => {
  const mux = await createMemberMux({ wireStream: { open() {}, failure() {} } });
  await mux.close(); await mux.close();
});
