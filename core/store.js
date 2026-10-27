/** Test-only in-memory implementation of the whole-state persistence contract. */
export class MemoryStore {
  #state;

  constructor(state = null) {
    this.#state = state === null ? null : structuredClone(state);
  }

  async load() {
    return this.#state === null ? null : structuredClone(this.#state);
  }

  async save(state) {
    this.#state = structuredClone(state);
  }
}
