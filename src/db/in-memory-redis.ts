/**
 * NovaBit Exchange — In-memory Redis stand-in (dev/test only)
 *
 * The exchange uses Redis for the live order book (sorted sets) and order
 * metadata (hashes). When REDIS_URL is unset the app must still boot and the
 * trading endpoints must still work, so this module provides a functional —
 * not merely a stubbed — subset of the Redis command surface the application
 * actually uses.
 *
 * Previously the "mock" only implemented ping/quit/on, so every trading path
 * that touched Redis died with `this.redis.zadd is not a function` and the
 * SQL order-book fallback was never reachable. This implementation keeps the
 * order book in process memory so dev/staging behaves like production.
 *
 * NOT for production: it is per-process, non-durable and not shared across
 * workers. Production requires a real REDIS_URL (enforced by the config gate).
 */

import { EventEmitter } from 'node:events';

/** [member, score] pair used internally; flattened for ioredis compatibility. */
type Entry = [member: string, score: number];

export class InMemoryRedis extends EventEmitter {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private expiries = new Map<string, number>();

  // ── internal helpers ─────────────────────────

  private expired(key: string): boolean {
    const at = this.expiries.get(key);
    if (at === undefined) return false;
    if (Date.now() < at) return false;
    this.strings.delete(key);
    this.hashes.delete(key);
    this.sortedSets.delete(key);
    this.expiries.delete(key);
    return true;
  }

  private zset(key: string): Map<string, number> {
    if (this.expired(key)) return new Map();
    let set = this.sortedSets.get(key);
    if (!set) {
      set = new Map();
      this.sortedSets.set(key, set);
    }
    return set;
  }

  private hash(key: string): Map<string, string> {
    if (this.expired(key)) return new Map();
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  /** Redis index normalisation (supports negative offsets such as -1). */
  private static idx(index: number, length: number): number {
    return index < 0 ? Math.max(length + index, 0) : index;
  }

  /** Sorted-set ordering: score ascending, ties broken member-lexicographically. */
  private static ordered(set: Map<string, number>, reverse: boolean): Entry[] {
    const entries: Entry[] = [...set.entries()].sort((a, b) =>
      a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] - b[1],
    );
    return reverse ? entries.reverse() : entries;
  }

  private static within(entries: Entry[], start: number, stop: number): Entry[] {
    const count = entries.length;
    const from = InMemoryRedis.idx(start, count);
    const to = Math.min(InMemoryRedis.idx(stop, count), count - 1);
    if (from > to) return [];
    return entries.slice(from, to + 1);
  }

  /** ioredis replies are flat arrays: [member, score, member, score, …]. */
  private static reply(entries: Entry[], withScores: boolean): string[] {
    return withScores
      ? entries.flatMap(([member, score]) => [member, String(score)])
      : entries.map(([member]) => member);
  }

  private static wantsScores(args: (string | number)[]): boolean {
    return args.some((a) => String(a).toUpperCase() === 'WITHSCORES');
  }

  // ── connection management ────────────────────

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  async disconnect(): Promise<void> {
    return undefined;
  }

  /** ioredis hands out a second client bound to the same server for pub/sub. */
  duplicate(): InMemoryRedis {
    const clone = new InMemoryRedis();
    clone.strings = this.strings;
    clone.hashes = this.hashes;
    clone.sortedSets = this.sortedSets;
    clone.expiries = this.expiries;
    return clone;
  }

  // ── keys ─────────────────────────────────────

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      const had =
        this.strings.delete(key) || this.hashes.delete(key) || this.sortedSets.delete(key);
      this.expiries.delete(key);
      if (had) removed += 1;
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(
      (key) => this.strings.has(key) || this.hashes.has(key) || this.sortedSets.has(key),
    ).length;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if ((await this.exists(key)) === 0) return 0;
    this.expiries.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const at = this.expiries.get(key);
    if (at === undefined) return -1;
    return Math.max(Math.round((at - Date.now()) / 1000), 0);
  }

  // ── strings ──────────────────────────────────

  async get(key: string): Promise<string | null> {
    if (this.expired(key)) return null;
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string | number): Promise<'OK'> {
    this.strings.set(key, String(value));
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string | number): Promise<'OK'> {
    await this.set(key, value);
    await this.expire(key, seconds);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  async incrby(key: string, by: number): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + Number(by);
    this.strings.set(key, String(next));
    return next;
  }

  // ── sorted sets (order book) ─────────────────

  /** zadd(key, score, member) — the only form the application uses. */
  async zadd(key: string, score: string | number, member: string): Promise<number> {
    const set = this.zset(key);
    const existed = set.has(member);
    set.set(member, Number(score));
    return existed ? 0 : 1;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = this.zset(key).get(member);
    return score === undefined ? null : String(score);
  }

  async zcard(key: string): Promise<number> {
    return this.zset(key).size;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.zset(key);
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    ...args: (string | number)[]
  ): Promise<string[]> {
    const entries = InMemoryRedis.within(InMemoryRedis.ordered(this.zset(key), false), Number(start), Number(stop));
    return InMemoryRedis.reply(entries, InMemoryRedis.wantsScores(args));
  }

  async zrevrange(
    key: string,
    start: number,
    stop: number,
    ...args: (string | number)[]
  ): Promise<string[]> {
    const entries = InMemoryRedis.within(InMemoryRedis.ordered(this.zset(key), true), Number(start), Number(stop));
    return InMemoryRedis.reply(entries, InMemoryRedis.wantsScores(args));
  }

  /** zrangebyscore(key, min, max[, 'WITHSCORES'][, 'LIMIT', offset, count]) */
  async zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: (string | number)[]
  ): Promise<string[]> {
    const lower = String(min) === '-inf' ? -Infinity : Number(min);
    const upper = String(max) === '+inf' || String(max) === 'inf' ? Infinity : Number(max);

    let entries = InMemoryRedis.ordered(this.zset(key), false).filter(
      ([, score]) => score >= lower && score <= upper,
    );

    const limitIdx = args.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
    if (limitIdx !== -1) {
      const offset = Number(args[limitIdx + 1] ?? 0);
      const count = Number(args[limitIdx + 2] ?? -1);
      entries = count < 0
        ? entries.slice(offset)
        : entries.slice(offset, offset + count);
    }

    return InMemoryRedis.reply(entries, InMemoryRedis.wantsScores(args));
  }

  // ── hashes (order metadata) ──────────────────

  async hset(
    key: string,
    field: string | Record<string, string | number>,
    value?: string | number,
  ): Promise<number> {
    const h = this.hash(key);
    const entries: [string, string][] =
      typeof field === 'object'
        ? Object.entries(field).map(([k, v]) => [k, String(v)])
        : [[field, String(value)]];
    let created = 0;
    for (const [k, v] of entries) {
      if (!h.has(k)) created += 1;
      h.set(k, v);
    }
    return created;
  }

  async hsetnx(key: string, field: string, value: string | number): Promise<number> {
    const h = this.hash(key);
    if (h.has(field)) return 0;
    h.set(field, String(value));
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key).entries());
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.hash(key);
    let removed = 0;
    for (const field of fields) {
      if (h.delete(field)) removed += 1;
    }
    return removed;
  }

  async hlen(key: string): Promise<number> {
    return this.hash(key).size;
  }

  // ── pub/sub ──────────────────────────────────

  async publish(): Promise<number> {
    return 0;
  }

  async subscribe(..._channels: string[]): Promise<number> {
    return 0;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    // Real clients emit 'error'/'ready'/'connect'/'end'; consumers register
    // handlers defensively. Keep those registrations harmless no-ops.
    if (['error', 'ready', 'connect', 'end', 'close', 'reconnecting'].includes(event)) {
      return this;
    }
    return super.on(event, listener);
  }
}

/** Create an isolated in-process Redis stand-in (dev/test only). */
export function createInMemoryRedis(): InMemoryRedis {
  return new InMemoryRedis();
}
