/** Bounded LAN carrier for the public Gateway stream protocol.
 * This is an independent implementation, not a deep import of the stock mux.
 * open/item/end/cancel and item/error/end are the protocol's entire envelope;
 * domain values (including terminal acknowledgements) pass through unchanged.
 */
const DEFAULTS = Object.freeze({
  maxStreams: 64, maxFrameBytes: 256 * 1024, inboxBytes: 1024 * 1024,
  pendingBytes: 1024 * 1024, outgoingBytes: 8 * 1024 * 1024,
  sendTimeoutMs: 10_000, cleanupTimeoutMs: 2_000,
  heartbeatMs: 15_000, revalidateMs: 30_000, lifetimeMs: 12 * 60 * 60 * 1000,
  maxConnections: 64, peerConnections: 4,
});
const done = () => ({ done: true, value: undefined });
const failure = (code, message) => Object.assign(new Error(message), { code });
function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure('lan/timeout', 'Member stream operation timed out')), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}
function interrupted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort;
  return Promise.race([promise, new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  })]).finally(() => signal.removeEventListener('abort', abort));
}
function textOf(data) {
  if (typeof data === 'string') return data;
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

/** Single consumer queue, bounded by complete encoded frame bytes, not values. */
class Inbox {
  constructor(maxBytes, violate) {
    this.maxBytes = maxBytes; this.violate = violate; this.queue = []; this.bytes = 0;
    this.ended = false; this.closed = false; this.taken = false; this.wake = null;
  }
  push(value, bytes) {
    if (this.closed || this.error) return;
    if (this.ended) return this.violate(failure('gateway/protocol', 'Uplink item after end'));
    if (this.bytes + bytes > this.maxBytes) return this.violate(failure('gateway/uplink-overflow', 'Member uplink buffer exceeded'));
    this.queue.push({ value, bytes }); this.bytes += bytes; this.signal();
  }
  end() { this.ended = true; this.signal(); }
  fail(error) { if (this.closed || this.error) return; this.error = error; this.queue = []; this.bytes = 0; this.signal(); }
  signal() { const wake = this.wake; this.wake = null; wake?.(); }
  [Symbol.asyncIterator]() {
    if (this.taken) throw new Error('Member uplink already has a consumer');
    this.taken = true; return this;
  }
  async next() {
    for (;;) {
      if (this.closed) return done();
      if (this.error) throw this.error;
      const entry = this.queue.shift();
      if (entry) { this.bytes -= entry.bytes; return { value: entry.value, done: false }; }
      if (this.ended) return done();
      if (this.wake) throw new Error('Concurrent member uplink reads');
      await new Promise(resolve => { this.wake = resolve; });
    }
  }
  return() { this.closed = true; this.queue = []; this.bytes = 0; this.signal(); return Promise.resolve(done()); }
}

/** Pure socket adapter, injectable codec and socket for runtime tests. No listener. */
export function createMemberMuxConnection({ socket, wireStream, peer, authenticate, parseClientMessage, limits = {} }) {
  const cfg = { ...DEFAULTS, ...limits };
  for (const value of Object.values(cfg)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Positive mux bounds required');
  if (peer?.principal?.kind !== 'lan-member' || !peer.signal || typeof authenticate !== 'function' || typeof parseClientMessage !== 'function') throw new TypeError('Member mux requires its own authenticated Peer and public codec');
  const streams = new Map(), pumps = new Set();
  let stopped = false, pendingBytes = 0, outgoingBytes = 0, writes = Promise.resolve(), reads = Promise.resolve();
  let missedPongs = 0, revalidating = false;
  const timers = [];
  const safeReturn = iterator => {
    try { return bounded(Promise.resolve(iterator?.return?.()), cfg.cleanupTimeoutMs).catch(() => {}); }
    catch { return Promise.resolve(); }
  };
  const stopStream = (active, reason, report = false) => {
    if (active.control.signal.aborted) return;
    active.report = report; active.control.abort(reason); active.inbox.fail(reason);
    // return() must be called even if next() or the opener is still pending.
    active.returning ??= safeReturn(active.iterator);
  };
  const send = message => {
    let text;
    try { text = JSON.stringify(message); } catch { return Promise.reject(failure('lan/encoding', 'Invalid member stream output')); }
    const bytes = Buffer.byteLength(text);
    // Client input frames and server history snapshots have different bounds.
    // A large snapshot may exceed the input cap while fitting the output budget.
    if (outgoingBytes + bytes > cfg.outgoingBytes) return Promise.reject(failure('lan/output-overflow', 'Member output buffer exceeded'));
    outgoingBytes += bytes;
    const delivery = writes.then(() => bounded(new Promise((resolve, reject) => {
      if (stopped || socket.readyState !== 1) return reject(failure('lan/closed', 'Member socket closed'));
      if (socket.bufferedAmount > cfg.outgoingBytes) return reject(failure('lan/output-overflow', 'Member output buffer exceeded'));
      try { socket.send(text, error => error ? reject(error) : resolve()); } catch (error) { reject(error); }
    }), cfg.sendTimeoutMs));
    writes = delivery.catch(() => {});
    return delivery.finally(() => { outgoingBytes -= bytes; });
  };
  const sendFailure = async (id, error) => {
    if (stopped) return;
    let mapped;
    if (typeof error?.code === 'string' && /^(?:lan\/|gateway\/(?:protocol|uplink-overflow))/.test(error.code)) {
      mapped = { code: error.code, message: error.message, details: {} };
    } else {
      try { mapped = wireStream.failure(error); } catch { mapped = null; }
    }
    if (!mapped || typeof mapped.code !== 'string' || typeof mapped.message !== 'string' || !mapped.details || typeof mapped.details !== 'object') mapped = { code: 'lan/stream-failed', message: 'Member stream failed', details: {} };
    try { await send({ type: 'error', streamId: id, error: mapped }); }
    catch { void close(1011, 'stream delivery failed'); }
  };
  const pump = async (id, endpoint, payload, active) => {
    const signal = active.control.signal;
    try {
      const opening = Promise.resolve().then(() => wireStream.open(endpoint, payload, active.inbox, peer, signal)).then(source => {
        // Claim exactly one iterator before the next await, closing the race
        // between opener resolution and cancellation of the awaiting pump.
        active.iterator = source[Symbol.asyncIterator]();
        if (signal.aborted) active.returning = safeReturn(active.iterator);
        return active.iterator;
      });
      await interrupted(opening, signal);
      for (;;) {
        const next = await interrupted(Promise.resolve(active.iterator.next()), signal);
        if (next.done) break;
        // Gateway's documented ready.host.home is owner-machine metadata used
        // only for UI path abbreviation. Keep the ready contract, not that path.
        const value = endpoint === '$events' && next.value?.type === 'ready'
          ? { ...next.value, host: { ...next.value.host, home: '' } }
          : next.value;
        await interrupted(send({ type: 'item', streamId: id, value }), signal);
      }
      active.inbox.return();
      await send({ type: 'end', streamId: id });
    } catch (error) {
      if (!signal.aborted || active.report) await sendFailure(id, signal.aborted ? signal.reason : error);
    } finally {
      clearTimeout(active.timer);
      active.inbox.return();
      if (!signal.aborted) active.control.abort(failure('lan/ended', 'Member stream ended'));
      active.returning ??= safeReturn(active.iterator);
      await active.returning;
      if (streams.get(id) === active) streams.delete(id);
    }
  };
  const receive = (message, bytes) => {
    if (message.streamId.length > 128) throw failure('lan/protocol', 'Stream identity too long');
    if (message.type === 'open') {
      if (streams.has(message.streamId)) throw failure('lan/protocol', 'Duplicate member stream identity');
      if (streams.size >= cfg.maxStreams) { void sendFailure(message.streamId, failure('lan/stream-limit', 'Too many member streams')); return; }
      if (message.endpoint.length > 256) throw failure('lan/protocol', 'Endpoint too long');
      const active = { control: new AbortController(), report: false };
      active.inbox = new Inbox(cfg.inboxBytes, reason => stopStream(active, reason, true));
      active.timer = setTimeout(() => stopStream(active, failure('lan/lifetime', 'Member stream generation expired'), true), cfg.lifetimeMs);
      active.timer.unref?.();
      streams.set(message.streamId, active);
      const task = pump(message.streamId, message.endpoint, message.payload, active);
      pumps.add(task); task.finally(() => pumps.delete(task)).catch(() => {});
      return;
    }
    const active = streams.get(message.streamId);
    if (!active) return; // in-flight frames from a completed generation
    if (message.type === 'item') active.inbox.push(message.value, bytes);
    else if (message.type === 'end') active.inbox.end();
    else if (message.type === 'cancel') stopStream(active, failure('lan/cancelled', 'Member cancelled stream'));
  };
  const onMessage = (data, binary) => {
    if (stopped) return;
    if (binary) { void close(1003, 'text frames required'); return; }
    let text, bytes, message;
    try {
      text = textOf(data); bytes = Buffer.byteLength(text);
      if (bytes > cfg.maxFrameBytes || pendingBytes + bytes > cfg.pendingBytes) throw failure('lan/input-overflow', 'Member input buffer exceeded');
      message = parseClientMessage(text);
    } catch { void close(1008, 'invalid member stream frame'); return; }
    pendingBytes += bytes;
    // Authenticate every inbound frame, serially, without unbounded queued bytes.
    reads = reads.then(async () => {
      if (stopped) return;
      try { await bounded(Promise.resolve().then(authenticate), cfg.sendTimeoutMs); } catch { void close(1008, 'member session expired'); return; }
      if (!stopped) receive(message, bytes);
    }).catch(() => { void close(1008, 'invalid member stream request'); }).finally(() => { pendingBytes -= bytes; });
  };
  const onClose = () => { void close(); };
  const onError = () => { void close(1011, 'member socket error'); };
  const onPong = () => { missedPongs = 0; };
  const onPeerAbort = () => { void close(1001, 'member session revoked'); };
  let closing;
  function close(code, reason) {
    if (closing) return closing;
    stopped = true;
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    socket.off('message', onMessage); socket.off('pong', onPong);
    socket.off('close', onClose); socket.off('error', onError);
    // ws can emit an error while closing; never leave it unhandled.
    socket.on('error', () => {});
    peer.signal.removeEventListener('abort', onPeerAbort);
    for (const active of streams.values()) stopStream(active, failure('lan/closed', 'Member socket closed'));
    if (code && socket.readyState === 1) {
      try { socket.close(code, reason); } catch { socket.terminate?.(); }
      const terminate = setTimeout(() => { if (socket.readyState !== 3) socket.terminate?.(); }, cfg.cleanupTimeoutMs);
      terminate.unref?.(); socket.once('close', () => clearTimeout(terminate));
    }
    closing = bounded(Promise.allSettled([...pumps]), cfg.cleanupTimeoutMs + 10).catch(() => {});
    return closing;
  }
  socket.on('message', onMessage); socket.on('pong', onPong); socket.once('close', onClose); socket.once('error', onError);
  peer.signal.addEventListener('abort', onPeerAbort, { once: true });
  timers.push(setInterval(() => {
    if (++missedPongs > 2) { void close(1001, 'member heartbeat expired'); return; }
    try { socket.ping(); } catch { void close(1011, 'member heartbeat failed'); }
  }, cfg.heartbeatMs));
  timers.push(setInterval(() => {
    if (revalidating || stopped) return;
    revalidating = true;
    bounded(Promise.resolve().then(authenticate), cfg.sendTimeoutMs).catch(() => close(1008, 'member session expired')).finally(() => { revalidating = false; });
  }, cfg.revalidateMs));
  for (const timer of timers) timer.unref?.();
  if (peer.signal.aborted) onPeerAbort();
  return { close, get streamCount() { return streams.size; }, get pendingBytes() { return pendingBytes; } };
}

/** Uses only ws's public noServer API and Gateway's exported protocol codec. */
export async function createMemberMux({ wireStream, limits, WebSocketServer: Server, parseClientMessage } = {}) {
  Server ??= (await import('ws')).WebSocketServer;
  parseClientMessage ??= (await import('@deepseek-ai/dsh-api-gateway/stream-protocol')).parseRemoteStreamClientMessage;
  const server = new Server({ noServer: true, maxPayload: limits?.maxFrameBytes ?? DEFAULTS.maxFrameBytes, perMessageDeflate: false });
  const cfg = { ...DEFAULTS, ...limits }, connections = new Set(), peerCounts = new Map();
  let closed = false, accepting = 0;
  return {
    handleUpgrade(req, socket, head, peer, authenticate) {
      const count = peerCounts.get(peer) ?? 0;
      if (closed || peer.signal.aborted) { socket.destroy(); return; }
      if (connections.size + accepting >= cfg.maxConnections || count >= cfg.peerConnections) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      accepting++; peerCounts.set(peer, count + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const remaining = (peerCounts.get(peer) ?? 1) - 1;
        if (remaining > 0) peerCounts.set(peer, remaining); else peerCounts.delete(peer);
      };
      socket.once('close', release);
      try { server.handleUpgrade(req, socket, head, websocket => {
        const connection = createMemberMuxConnection({ socket: websocket, wireStream, peer, authenticate, parseClientMessage, limits });
        connections.add(connection);
        websocket.once('close', () => { connections.delete(connection); release(); });
      }); } catch (error) { release(); throw error; }
      finally { accepting--; }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...connections].map(connection => connection.close(1001, 'member carrier stopped')));
      for (const client of server.clients) client.terminate();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
