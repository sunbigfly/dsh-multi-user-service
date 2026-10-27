const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0, unavailableSessions: 0 });
const fields = ['inputTokens', 'outputTokens', 'totalTokens'];

function tokens(usage) {
  if (!usage || ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const inputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const totalTokens = inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return { inputTokens, outputTokens: usage.outputTokens, totalTokens };
}

/** Fold only the observed Session's own log suffix. An attempt and its assembled
 * message replace the same sample; a provider retry starts a separate call. */
function nativeSamples(events, lastUsage = () => undefined) {
  const attempts = new Map(), generations = new Map();
  for (const event of events) {
    const data = event.data, step = `${data.turn}:${data.step}`;
    if (event.type === 'llm/retry-started') { generations.set(step, (generations.get(step) ?? 0) + 1); continue; }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const key = `${step}:${generations.get(step) ?? 0}`;
      const usage = tokens(data.usage ?? lastUsage(data.stream ?? []));
      // An empty assembled message must not erase an earlier reported sample.
      if (usage || !attempts.has(key)) attempts.set(key, { usage, time: attempts.get(key)?.time ?? event.time });
    } else if (event.type === 'compaction/summary' && data.llmStreamCall === true) {
      attempts.set('compact:' + data.compactionId, { usage: tokens(data.usage), time: event.time });
    }
  }
  return [...attempts.values()];
}
function summarize(samples) {
  const result = zero();
  for (const { usage: sample } of samples) {
    result.calls++;
    if (!sample) result.unknownCalls++;
    else for (const field of fields) result[field] += sample[field];
  }
  return result;
}
export function foldNativeUsage(events, lastUsage = () => undefined) {
  return summarize(nativeSamples(events, lastUsage));
}
export const USAGE_TIME_ZONE = 'Asia/Shanghai';
const usageDate = new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function periodKeys(time, timeZone = USAGE_TIME_ZONE) {
  const formatter = timeZone === USAGE_TIME_ZONE ? usageDate : new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = formatter.format(time);
  return { day, month: day.slice(0, 7) };
}
export function foldNativePeriods(events, lastUsage = () => undefined, now = Date.now()) {
  const keys = periodKeys(now), samples = nativeSamples(events, lastUsage), daily = [], monthly = [];
  let undatedCalls = 0;
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.time) || sample.time < 0) { undatedCalls++; continue; }
    const period = periodKeys(sample.time);
    if (period.day === keys.day) daily.push(sample);
    if (period.month === keys.month) monthly.push(sample);
  }
  return { ...keys, timeZone: USAGE_TIME_ZONE, daily: summarize(daily), monthly: summarize(monthly), undatedCalls };
}

/** The native single-session stat searches every project directory. Take one
 * native corpus cut for cold revisions instead; live Session sequence numbers
 * remain authoritative. Missing/ambiguous records must never reuse a cache hit.
 */
export async function nativeUsageRevisions(ids, { sessions, persistence }) {
  const revisions = new Map(), cold = new Set();
  for (const id of ids) {
    const live = sessions.get(id);
    if (live) revisions.set(id, `live:${live.seq}`);
    else cold.add(id);
  }
  if (!cold.size) return revisions;
  const rows = await persistence?.list();
  if (!Array.isArray(rows)) throw new Error('Native usage revisions are unavailable');
  const seen = new Set();
  for (const row of rows) {
    const id = row.header?.id;
    if (!cold.has(id)) continue;
    if (seen.has(id)) revisions.delete(id);
    else {
      seen.add(id);
      if (row.revision !== undefined) revisions.set(id, `stored:${row.revision}`);
    }
  }
  return revisions;
}

/** Native logs are the durable ledger. Refresh replays exact live/cold cuts,
 * including disabled users and children, so restarts/backfill never add twice.
 * No prompts, provider configuration or file contents enter the public board. */
export class NativeUsage {
  constructor(options) { Object.assign(this, options); this.cache = new Map(); this.periods = new Map(); }
  refresh() {
    return this.pending ??= this.collect().finally(() => { this.pending = null; });
  }
  async collect() {
    let state = await this.coreStore.load();
    if (state === null) {
      const status = await this.core.execute({ action: 'status' }, {});
      if (status.initialized !== false) throw new Error('Native usage account state is unavailable');
      state = { users: [] };
    }
    const rows = [], periods = new Map(), now = this.now?.() ?? Date.now(), keys = periodKeys(now);
    const users = [...state.users, ...(state.retiredUsers ?? [])];
    const ownership = new Map(users.map(user => [user.id, this.ownership.entriesOf(user.id)]));
    let revisions, revisionsFailed = false;
    if (this.revisions) {
      try {
        revisions = await this.revisions([...new Set([...ownership.values()].flatMap(entries => entries.map(row => row.sessionId)))]);
        if (!(revisions instanceof Map)) throw new Error('Invalid native usage revisions');
      } catch { revisionsFailed = true; }
    }
    for (const user of users) {
      const entries = ownership.get(user.id);
      if (!entries.length) continue;
      const aggregate = { userId: user.id, ...zero() };
      const period = foldNativePeriods([], this.lastUsage, now);
      let next = 0;
      const collectEntry = async entry => {
        let observation, value;
        try {
          if (revisionsFailed || revisions && !revisions.has(entry.sessionId)) throw new Error('Native usage source is unavailable');
          const revision = revisions ? revisions.get(entry.sessionId) : await this.revision?.(entry.sessionId), cached = this.cache.get(entry.sessionId);
          if (revision !== undefined && cached?.revision === revision && cached.day === keys.day) value = cached.value;
          else {
            observation = await this.query.observeSession(entry.sessionId, { projectionMode: 'none' });
            const events = observation.events.slice(observation.inheritedEventCount);
            value = { total: foldNativeUsage(events, this.lastUsage), periods: foldNativePeriods(events, this.lastUsage, now) };
            this.cache.set(entry.sessionId, { revision, value, day: keys.day });
          }
        } catch {
          aggregate.unavailableSessions++;
          period.daily.unavailableSessions++; period.monthly.unavailableSessions++;
          value = this.cache.get(entry.sessionId)?.value;
        } finally { observation?.[Symbol.dispose](); }
        if (value) {
          for (const key of Object.keys(zero())) aggregate[key] += value.total[key];
          if (value.periods.day === keys.day) {
            for (const bucket of ['daily', 'monthly']) for (const key of Object.keys(zero())) period[bucket][key] += value.periods[bucket][key];
            period.undatedCalls += value.periods.undatedCalls;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) await collectEntry(entries[next++]);
      }));
      rows.push(aggregate);
      periods.set(user.id, period);
    }
    const result = await this.core.setNativeUsage(rows, this.hostCapability);
    this.periods = periods; this.ready = true;
    return result;
  }
}
