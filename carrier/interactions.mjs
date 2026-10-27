import { z } from 'zod';

// The gateway's public event-result wire shape. Settlement, delivery receipts,
// cancellation and reconnect state remain owned by the native gateway.
const reply = z.object({ args: z.object({
  clientId: z.uuid(), eventId: z.uuid(), outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('next') }).strict(),
    z.object({ kind: z.literal('result'), value: z.json().optional() }).strict(),
    z.object({ kind: z.literal('rejected'), error: z.object({ name: z.string().min(1), message: z.string(), code: z.string().optional(), details: z.json().optional() }).strict() }).strict(),
  ]),
}).strict() }).strict();
const events = new Set(['approval/request', 'user-questions/request']);
const failure = () => ({ ok: false, error: { code: 'gateway/interactions-forbidden', message: 'This reply requires a live request delivered to this account and connection.', details: {} } });

export function installMemberInteractions(receiver, { ownership, capabilities }) {
  const gateway = receiver[Symbol.for('cordis.original')] ?? receiver, restores = [];
  if (!(gateway.remoteEventClients instanceof Map) || !(gateway.pendingRemoteEvents instanceof Map)) throw new Error('Native interaction delivery integration is unavailable');
  const allowed = (pending, client) => {
    try {
      const peer = client.peer, userId = peer.principal.userId;
      return peer.principal.kind === 'lan-member' && peer.interactions === 'answer' && !peer.signal.aborted && !client.signal.aborted
        && events.has(pending.frame.event) && ownership.ownerOf(pending.frame.agentId) === userId && capabilities.policy(userId).interactions;
    } catch { return false; }
  };
  const patch = (name, make) => {
    const original = gateway[name], descriptor = Object.getOwnPropertyDescriptor(gateway, name);
    if (typeof original !== 'function') throw new Error('Native interaction method is unavailable');
    const wrapper = make(original); gateway[name] = wrapper;
    restores.push(() => { if (gateway[name] === wrapper) { if (descriptor) Object.defineProperty(gateway, name, descriptor); else delete gateway[name]; } });
  };
  patch('startRemoteEvent', original => function(source) {
    const userId = ownership.ownerOf(source.context?.agentId);
    if (userId && events.has(source.event)) {
      try { if (!capabilities.policy(userId).interactions) throw new Error('Interactive requests are disabled for this account.'); }
      catch (error) { source.reject(error); return; }
    }
    original.call(this, source);
    const pending = [...this.pendingRemoteEvents.values()].find(item => item.source === source);
    if (pending) for (const client of this.remoteEventClients.values()) if (allowed(pending, client)) this.deliverRemoteEvent(pending, client);
  });
  patch('openRemoteEvents', original => async function*(payload, signal, peer) {
    for await (const frame of original.call(this, payload, signal, peer)) {
      if (peer.principal.kind === 'lan-member' && frame.type === 'ready') {
        const client = this.remoteEventClients.get(frame.clientId);
        for (const pending of this.pendingRemoteEvents.values()) if (client && allowed(pending, client)) this.deliverRemoteEvent(pending, client);
      }
      if (peer.principal.kind === 'lan-member' && frame.type === 'waterfall') {
        const pending = this.pendingRemoteEvents.get(frame.eventId);
        const client = pending && [...pending.deliveries].find(item => item.peer === peer && allowed(pending, item));
        if (!client) continue;
      }
      yield frame;
    }
  });
  patch('dispatchRpc', original => async function(endpoint, payload, signal, peer) {
    if (endpoint !== '$events/result' || peer.principal.kind !== 'lan-member') return original.call(this, endpoint, payload, signal, peer);
    const parsed = reply.safeParse(payload);
    if (!parsed.success || signal?.aborted || peer.signal.aborted) return failure();
    const result = parsed.data.args, client = this.remoteEventClients.get(result.clientId), pending = this.pendingRemoteEvents.get(result.eventId);
    if (!client || client.peer !== peer || !pending || !pending.deliveries.has(client) || !allowed(pending, client)) return failure();
    this.receiveRemoteEventResult(client, result);
    return { ok: true, value: undefined };
  });
  return () => { for (const restore of restores.reverse()) restore(); };
}
