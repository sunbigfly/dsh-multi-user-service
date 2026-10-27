import { memberPath } from './access.mjs';

const USER = /^usr_[0-9a-f]{32}$/;
const ID = /^sha256:[0-9a-f]{64}$/;

/** Server-private, durable upload grants. Members cannot edit these receipts by
 * writing a metadata file in their workspace. Legacy ids migrate once only.
 */
export class MemberAttachmentAccess {
  #store; #state; #queue = Promise.resolve(); #closed = false;
  constructor(store) { this.#store = store; }
  async start(legacy = async () => []) {
    const saved = await this.#store.load();
    if (saved !== null) {
      if (saved?.version !== 1 || !saved.grants || typeof saved.grants !== 'object' || Array.isArray(saved.grants)) throw new Error('Invalid member attachment access state');
      for (const [user, grants] of Object.entries(saved.grants)) {
        if (!USER.test(user) || !Array.isArray(grants) || grants.some(grant => !ID.test(grant?.id) || (grant.path !== null && memberPath(grant.path) !== grant.path))) throw new Error('Invalid member attachment access grant');
      }
      this.#state = saved;
    } else {
      const state = { version: 1, grants: {} };
      for (const { userId, ids } of await legacy()) {
        if (USER.test(userId)) state.grants[userId] = [...new Set(ids.filter(id => ID.test(id)))].map(id => ({ id, path: null }));
      }
      await this.#store.save(state);
      this.#state = state;
    }
    return this;
  }
  async record(userId, id, path) {
    if (this.#closed || !USER.test(userId) || !ID.test(id) || memberPath(path) !== path) throw new Error('Invalid member attachment receipt');
    const operation = this.#queue.then(async () => {
      const next = structuredClone(this.#state), grants = next.grants[userId] ??= [];
      if (!grants.some(grant => grant.id === id && grant.path === path)) grants.push({ id, path });
      await this.#store.save(next);
      this.#state = next;
    });
    this.#queue = operation.catch(() => {});
    await operation;
  }
  allows(userId, candidate, fileHostPath) {
    if (this.#closed || !USER.test(userId) || memberPath(candidate) !== candidate) return false;
    const grants = this.#state.grants[userId] ?? [];
    if (grants.some(grant => grant.path === candidate)) return true;
    // Old file grants carry only the digest. Derive the exact path through the
    // current Host store; a directory named '.dsh/attachments' is not authority.
    const match = /\/files\/([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(candidate);
    if (!match || match[1] !== match[2].slice(0, 2) || typeof fileHostPath !== 'function') return false;
    const id = 'sha256:' + match[2];
    if (!grants.some(grant => grant.id === id && grant.path === null)) return false;
    try { return memberPath(fileHostPath({ attachmentId: id, name: match[3] })) === candidate; } catch { return false; }
  }
  async close() { this.#closed = true; await this.#queue; }
}
