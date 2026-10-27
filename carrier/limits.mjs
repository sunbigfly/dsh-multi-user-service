import * as v from '../core/validation.js';
import { reject } from '../core/errors.js';
import { foldNativePeriods, periodKeys } from './usage.mjs';

const FIELDS = ['maxConcurrent', 'dailyTokens', 'monthlyTokens'];
export function accountLimits(value = {}) {
  v.object(value, FIELDS, []);
  return Object.fromEntries(FIELDS.map(key => [key, value[key] == null ? null : v.integer(value[key], key)]));
}

/** Native logs remain the sole token ledger. Only policy is persisted here. */
export class MemberLimits {
  constructor(options) { Object.assign(this, options); this.active = new Map(); }
  async start() {
    const value = await this.store.load() ?? { version: 1, users: {} };
    v.object(value, ['version', 'users']);
    if (value.version !== 1 || !value.users || Array.isArray(value.users) || typeof value.users !== 'object') reject('INVALID_LIMITS', 'Invalid limits storage');
    for (const [id, row] of Object.entries(value.users)) { v.id(id, 'usr'); v.object(row, ['revision', ...FIELDS]); v.integer(row.revision, 'revision'); accountLimits(Object.fromEntries(FIELDS.map(k => [k, row[k]]))); }
    this.state = structuredClone(value); return this;
  }
  policy(userId) { return { revision: 0, ...accountLimits(), ...this.state.users[userId] }; }
  snapshot(userId) {
    return { ...this.policy(userId), active: this.active.get(userId)?.size ?? 0,
      usage: this.usage.periods.get(userId) ?? foldNativePeriods([], undefined, this.now?.() ?? Date.now()) };
  }
  update(request, caller) {
    return this.core.runAdministratorOperation(caller, async () => {
      v.object(request, ['action', 'userId', 'expectedRevision', ...FIELDS], ['action', 'userId', 'expectedRevision']); v.id(request.userId, 'usr');
      if (request.action !== 'admin.updateLimits') reject('INVALID_INPUT', 'Unknown limits action.');
      const state = await this.coreStore.load();
      if (!state.users.some(row => row.id === request.userId)) reject('USER_NOT_FOUND', 'Account was not found.', 404);
      const current = this.policy(request.userId);
      if (v.integer(request.expectedRevision, 'revision') !== current.revision) reject('LIMITS_CONFLICT', 'Limits changed. Refresh before saving.', 409);
      const limits = accountLimits(Object.fromEntries(FIELDS.map(k => [k, Object.hasOwn(request, k) ? request[k] : current[k]])));
      const next = structuredClone(this.state);
      next.users[request.userId] = { ...limits, revision: current.revision + 1 };
      await this.store.save(next); this.state = next;
      return { limits: this.snapshot(request.userId) };
    });
  }
  check(userId) {
    this.beforeAdmission?.();
    this.core.memberAccess(userId, this.hostCapability);
    const policy = this.policy(userId), usage = this.snapshot(userId).usage;
    // Calendar rollover is checked against a fresh ledger at the model seam.
    // A synchronous reminder must never be rejected using yesterday's totals.
    if (usage.day !== periodKeys(this.now?.() ?? Date.now()).day) return;
    for (const [field, bucket, code] of [['dailyTokens', 'daily', 'MEMBER_DAILY_TOKEN_LIMIT'], ['monthlyTokens', 'monthly', 'MEMBER_MONTHLY_TOKEN_LIMIT']]) {
      if (policy[field] === null) continue;
      if (!this.usage.ready || usage.undatedCalls || usage[bucket].unknownCalls || usage[bucket].unavailableSessions) reject('MEMBER_USAGE_UNAVAILABLE', '用量记录尚不完整，暂时无法核对额度。请联系管理员。', 503);
      if (usage[bucket].totalTokens >= policy[field]) reject(code, field === 'dailyTokens' ? '今日 tokens 额度已用完，请明日再试或联系管理员。' : '本月 tokens 额度已用完，请联系管理员。', 429);
    }
  }
  async prepare(userId) {
    const policy = this.policy(userId);
    if (policy.dailyTokens !== null || policy.monthlyTokens !== null) {
      try { await this.usage.refresh(); }
      catch { reject('MEMBER_USAGE_UNAVAILABLE', '暂时无法读取用量记录，请稍后重试。', 503); }
    }
    this.check(userId);
  }
  reserve(userId, sessionId) {
    this.check(userId);
    let running = this.active.get(userId);
    if (running?.has(sessionId)) return { created: false, close() {} };
    const limit = this.policy(userId).maxConcurrent;
    if (limit !== null && (running?.size ?? 0) >= limit) reject('MEMBER_CONCURRENCY_LIMIT', '同时运行的任务已达上限，请等待现有任务结束。', 429);
    if (!running) this.active.set(userId, running = new Map());
    const key = Symbol(); running.set(sessionId, key);
    return { created: true, close: () => {
      if (running.get(sessionId) === key) running.delete(sessionId);
      if (!running.size && this.active.get(userId) === running) this.active.delete(userId);
    } };
  }
  async stream(userId, sessionId) {
    await this.prepare(userId);
    return this.reserve(userId, sessionId ?? Symbol());
  }
  nativeError(error) {
    return this.RemoteError && /^MEMBER_(CONCURRENCY_LIMIT|DAILY_TOKEN_LIMIT|MONTHLY_TOKEN_LIMIT|USAGE_UNAVAILABLE)$/.test(error?.code)
      ? new this.RemoteError('lan/usage-limit', error.message, { reason: error.code }) : error;
  }
}

export function installMemberLimitPrompt(receiver, limits, userOf) {
  const controller = receiver[Symbol.for('cordis.original')] ?? receiver, original = controller.prompt;
  if (typeof original !== 'function') throw new Error('Native prompt admission is unavailable');
  const wrapper = async function(request, ...rest) {
    limits.beforeAdmission?.();
    const userId = userOf(request.sessionId);
    if (userId) {
      try { await limits.prepare(userId); }
      catch (error) {
        // A retry of an already accepted prompt is not new work. Preserve the
        // native inbox/log idempotency before reporting a newly reached limit.
        if (/^MEMBER_/.test(error?.code) && request.requestId) {
          const commands = controller.commands ?? controller;
          const agent = await commands.resolveAgent?.(request.sessionId);
          const matches = message => message.source?.kind === 'user' && message.source.rpcId === request.requestId;
          if (agent && (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches) || agent.session.snapshotEvents().some(event => event.type === 'user/message' && matches(event.data)))) return original.call(this, request, ...rest);
        }
        throw limits.nativeError(error);
      }
    }
    return original.call(this, request, ...rest);
  };
  controller.prompt = wrapper;
  return () => { if (controller.prompt === wrapper) controller.prompt = original; };
}

/** Keep native inboxes and drivers. Check before insertion, reserve synchronously,
 * then release only when that same native Agent becomes idle or is disposed. */
export function installMemberLimitAdmission(agent, limits, userId) {
  const restores = [], leases = new Set();
  if (['send', 'wakeDriver', 'runMaintenance', 'whenIdle'].some(name => typeof agent[name] !== 'function')) throw new Error('Native Agent admission is unavailable');
  for (const name of ['send', 'wakeDriver', 'runMaintenance']) {
    const original = agent[name], descriptor = Object.getOwnPropertyDescriptor(agent, name);
    if (typeof original !== 'function') throw new Error(`Native ${name} admission is unavailable`);
    const wrapper = function(...args) {
      if (name === 'send' && !args[2]) return original.apply(this, args);
      let lease;
      try { lease = limits.reserve(userId, agent.id); }
      catch (error) { throw limits.nativeError(error); }
      try {
        const result = original.apply(this, args);
        if (lease.created) {
          leases.add(lease);
          void Promise.resolve(agent.whenIdle()).catch(() => {}).finally(() => { lease.close(); leases.delete(lease); });
        }
        return result;
      } catch (error) { lease.close(); throw error; }
    };
    agent[name] = wrapper;
    restores.push(() => { if (agent[name] === wrapper) { if (descriptor) Object.defineProperty(agent, name, descriptor); else delete agent[name]; } });
  }
  return () => { for (const lease of leases) lease.close(); for (const restore of restores.reverse()) restore(); };
}
