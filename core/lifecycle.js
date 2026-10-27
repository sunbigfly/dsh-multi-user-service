import { randomBytes } from 'node:crypto';
import { reject } from './errors.js';
import * as v from './validation.js';

const EFFECTIVE = new Set(['user-input', 'terminal-input', 'preview-input']);
const PASSIVE = new Set(['heartbeat', 'background', 'output', 'poll']);

/**
 * Isolated-runtime lifecycle policy, not an execution adapter. This class has no
 * process or shell fallback and is NOT connected to pilot execute() actions.
 * A trusted integration must supply stopProject and explicitly report runtime
 * attachment/restart. Calling tick() does not assert a process has stopped:
 * only {stopped:true} from stopProject can do that.
 */
export class Lifecycle {
  #now;
  #stop;
  #idleMs;
  #leaseMs;
  #retryMs;
  #stopTimeoutMs;
  #controllers = new Set();
  #entries = new Map();
  #queue = Promise.resolve();
  #epoch = 0;
  #closed = false;

  constructor({ now = Date.now, stopProject, idleMs = 15 * 60 * 1000,
    foregroundLeaseMs = 5 * 60 * 1000, retryMs = 30 * 1000, stopTimeoutMs = 10 * 1000 } = {}) {
    if (typeof now !== 'function' || typeof stopProject !== 'function') throw new TypeError('Lifecycle requires a clock and stopProject callback.');
    this.#now = now;
    this.#stop = stopProject;
    this.#idleMs = v.integer(idleMs, 'idleMs', 1);
    this.#leaseMs = v.integer(foregroundLeaseMs, 'foregroundLeaseMs', 1);
    this.#retryMs = v.integer(retryMs, 'retryMs', 1);
    this.#stopTimeoutMs = v.integer(stopTimeoutMs, 'stopTimeoutMs', 1);
    if (this.#stopTimeoutMs > 60 * 1000) reject('INVALID_INPUT', 'Stop acknowledgement deadline cannot exceed one minute.');
    if (this.#leaseMs > 15 * 60 * 1000) reject('INVALID_INPUT', 'Foreground operation leases cannot exceed 15 minutes.');
  }

  #serial(operation) {
    const pending = this.#queue.then(() => {
      if (this.#closed) reject('SERVICE_CLOSED', 'Lifecycle policy is closed.', 503);
      return operation();
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #time() { return v.integer(this.#now(), 'server time'); }

  #entry(projectId) {
    v.id(projectId, 'prj');
    const entry = this.#entries.get(projectId);
    if (!entry) reject('PROJECT_NOT_FOUND', 'Runtime project is not attached.', 404);
    return entry;
  }

  #view(entry) {
    return { projectId: entry.projectId, state: entry.state, lastActivityAt: entry.lastActivityAt,
      idleDeadline: entry.lastActivityAt + this.#idleMs, activeForeground: entry.leases.size,
      retryAt: entry.retryAt, stopAttempts: entry.stopAttempts };
  }

  #expire(entry, now) {
    let lastExpiry = null;
    for (const [id, lease] of entry.leases) {
      if (lease.expiresAt <= now) {
        entry.leases.delete(id);
        lastExpiry = Math.max(lastExpiry ?? 0, lease.expiresAt);
      }
    }
    // Automatic release happens at fixed expiry, not the next passive poll.
    if (lastExpiry !== null && entry.leases.size === 0) entry.lastActivityAt = Math.max(entry.lastActivityAt, lastExpiry);
  }

  async attach(projectId, { confirmedRunning = false } = {}) {
    return this.#serial(() => {
      v.id(projectId, 'prj'); v.bool(confirmedRunning, 'confirmedRunning');
      if (this.#entries.has(projectId)) reject('ALREADY_ATTACHED', 'Runtime project is already attached.', 409);
      const entry = { projectId, state: confirmedRunning ? 'running' : 'unknown', lastActivityAt: this.#time(),
        leases: new Map(), retryAt: null, stopAttempts: 0 };
      this.#entries.set(projectId, entry);
      return this.#view(entry);
    });
  }

  /** Host-only reconciliation after preparing a new verified execution range.
   * Reopening never restores old foreground leases or old process handles. */
  async confirmRunning(projectId) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      if (entry.state === 'stopping' || entry.leases.size) reject('RUNTIME_BUSY', 'Project resources are still transitioning.', 409);
      entry.state = 'running'; entry.leases.clear(); entry.retryAt = null;
      entry.lastActivityAt = this.#time();
      return this.#view(entry);
    });
  }

  async confirmStopped(projectId, { stopped = false } = {}) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      entry.state = stopped === true ? 'stopped' : 'stop-failed';
      entry.leases.clear(); entry.retryAt = stopped === true ? null : this.#time() + this.#retryMs;
      return this.#view(entry);
    });
  }

  async activity(projectId, event) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      if (!EFFECTIVE.has(event) && !PASSIVE.has(event)) reject('INVALID_INPUT', 'Unknown activity event.');
      const now = this.#time();
      this.#expire(entry, now);
      if (EFFECTIVE.has(event) && entry.state !== 'stopped') entry.lastActivityAt = now;
      return this.#view(entry);
    });
  }

  async acquireForeground(projectId) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      if (entry.state !== 'running') reject('RUNTIME_UNCONFIRMED', 'Runtime execution is not confirmed running.', 503);
      const now = this.#time();
      this.#expire(entry, now);
      if (entry.leases.size >= 256) reject('LEASE_LIMIT', 'Too many foreground operations.', 409);
      const leaseId = randomBytes(16).toString('hex');
      const expiresAt = now + this.#leaseMs;
      entry.leases.set(leaseId, { expiresAt });
      return { leaseId, expiresAt };
    });
  }

  /** Trusted runtime only: browser heartbeat/output must never call this. */
  async renewForeground(projectId, leaseId) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      if (typeof leaseId !== 'string' || !/^[0-9a-f]{32}$/.test(leaseId)) reject('INVALID_INPUT', 'Invalid operation lease.');
      const now = this.#time();
      this.#expire(entry, now);
      if (entry.state !== 'running' || !entry.leases.has(leaseId)) reject('LEASE_EXPIRED', 'Foreground operation lease is no longer active.', 409);
      const expiresAt = now + this.#leaseMs;
      entry.leases.set(leaseId, { expiresAt });
      return { leaseId, expiresAt };
    });
  }

  async releaseForeground(projectId, leaseId) {
    return this.#serial(() => {
      const entry = this.#entry(projectId);
      if (typeof leaseId !== 'string' || !/^[0-9a-f]{32}$/.test(leaseId)) reject('INVALID_INPUT', 'Invalid operation lease.');
      const now = this.#time();
      this.#expire(entry, now);
      if (entry.leases.delete(leaseId) && entry.leases.size === 0) entry.lastActivityAt = now;
      return this.#view(entry);
    });
  }

  /**
   * Invalidate in-flight acknowledgements synchronously. A restart does not mean
   * stopped, and does not restore a process or an operation lease.
   */
  async runtimeRestarted() {
    this.#epoch += 1;
    for (const controller of this.#controllers) controller.abort();
    return this.#serial(() => {
      const now = this.#time();
      for (const entry of this.#entries.values()) {
        entry.state = 'unknown';
        entry.leases.clear();
        entry.lastActivityAt = now;
        entry.retryAt = null;
      }
      return [...this.#entries.values()].map((entry) => this.#view(entry));
    });
  }

  async #boundedStop(projectId) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer;
    let abortListener;
    const deadline = new Promise((resolve) => {
      abortListener = () => resolve({ stopped: false });
      controller.signal.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(() => controller.abort(), this.#stopTimeoutMs);
    });
    const attempt = Promise.resolve().then(() => this.#stop(projectId, { signal: controller.signal }))
      .catch(() => ({ stopped: false }));
    try { return await Promise.race([attempt, deadline]); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortListener);
      this.#controllers.delete(controller);
    }
  }

  async tick() {
    const candidates = await this.#serial(() => {
      const now = this.#time(), selected = [];
      for (const entry of this.#entries.values()) {
        this.#expire(entry, now);
        if (['stopped', 'stopping'].includes(entry.state) || entry.leases.size > 0 || now < entry.lastActivityAt + this.#idleMs ||
            (entry.retryAt !== null && now < entry.retryAt)) continue;
        entry.state = 'stopping'; entry.stopAttempts += 1;
        selected.push({ entry, epoch: this.#epoch });
      }
      return selected;
    });
    // Resource teardown may await an Agent's foreground release. Never hold
    // this policy's queue across external stop(), or that release deadlocks.
    await Promise.all(candidates.map(async ({ entry, epoch }) => {
      let confirmed = false;
      try { confirmed = (await this.#boundedStop(entry.projectId))?.stopped === true; } catch {}
      if (this.#closed) return;
      await this.#serial(() => {
        if (this.#entries.get(entry.projectId) !== entry) return;
        if (epoch !== this.#epoch) { entry.state = 'unknown'; entry.retryAt = null; return; }
        entry.state = confirmed ? 'stopped' : 'stop-failed';
        entry.retryAt = confirmed ? null : this.#time() + this.#retryMs;
      });
    }));
    return this.snapshot();
  }

  async snapshot() {
    return this.#serial(() => {
      const now = this.#time();
      for (const entry of this.#entries.values()) this.#expire(entry, now);
      return [...this.#entries.values()].map((entry) => this.#view(entry));
    });
  }

  async close() {
    if (this.#closed) return;
    this.#epoch += 1;
    for (const controller of this.#controllers) controller.abort();
    await this.#serial(() => { this.#entries.clear(); this.#closed = true; });
  }
}
