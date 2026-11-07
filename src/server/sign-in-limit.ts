import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIPv4, isIPv6 } from "node:net";
import { AccessError } from "../factory/actions.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** Failures count against a key for this long. */
export const LIMIT_WINDOW_MS = 15 * MINUTE;
/** The wait once a key reaches its limit. Each further failure doubles it, up to `MAX_WAIT_MS`. */
export const FIRST_WAIT_MS = 30 * SECOND;
export const MAX_WAIT_MS = 15 * MINUTE;
/** The wait while a key's earlier attempts are still being checked, so parallel guesses can't outrun the count. */
const BUSY_WAIT_MS = SECOND;
const MAX_KEY_LENGTH = 64;

/** How many failures in `LIMIT_WINDOW_MS` each kind of key allows, and whether a success clears them. */
const RULES = {
  /** One client: one IPv4 address, or one IPv6 /64 (`clientAddressKey`). */
  client: { max: 5, resetOnSuccess: true },
  /** One username, from anywhere. */
  username: { max: 10, resetOnSuccess: true },
  /** Every attempt together. A success doesn't clear it, so one valid account can't reset it. */
  global: { max: 30, resetOnSuccess: false },
} satisfies Record<string, { max: number; resetOnSuccess: boolean }>;

export type LimitKind = keyof typeof RULES;

/** One counter of failed attempts: `kind` sets its limit, `key` says whose attempts it counts. */
export type Limit = { readonly kind: LimitKind; readonly key: string };

/**
 * `failures` within the window; `strikes`, failures since the key reached its limit, which set the wait and
 * cool down only after a whole window passes the last wait without another; attempts still `pending`.
 */
type Bucket = { failures: number[]; strikes: number; blockedUntil: number; pending: number };
type Outcome = "succeeded" | "failed" | "ignored";

/**
 * Which client a request comes from. serve-exposure swaps this for one that trusts a proxy's forwarded address, which
 * should go through `clientAddressKey` too.
 */
export type ClientKey = (c: Context) => string;

/** The socket's address as `clientAddressKey` keys it, or "unknown" when there is no socket, as under `app.request()`. */
export const socketClientKey: ClientKey = (c) => {
  try {
    return clientAddressKey(getConnInfo(c).remote.address ?? "");
  } catch {
    return "unknown";
  }
};

/**
 * The key a client's address counts under. An IPv6 address counts under its /64, such as `2001:db8:0:1::/64`, since
 * one host usually holds the whole /64 and could otherwise rotate through addresses to get past the per-client
 * limit. An IPv4 address, including one mapped into IPv6 (`::ffff:192.0.2.1`), counts on its own.
 */
export function clientAddressKey(address: string): string {
  const bare = address.replace(/%.*$/, "");
  if (!bare) return "unknown";
  if (!isIPv6(bare)) return isIPv4(bare) ? bare : address;
  const groups = ipv6Groups(bare);
  const [high = 0, low = 0] = groups.slice(6);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of an address `isIPv6` accepts, with `::` filled in and a trailing IPv4 part converted. */
function ipv6Groups(address: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  let text = address;
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    text = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  const gap = text.includes("::") ? 8 - front.length - back.length : 0;
  return [...front, ...new Array<number>(gap).fill(0), ...back];
}

/** Text that's safe in a log line or as a map key: no control or formatting characters, and short. */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_KEY_LENGTH);
}

function spell(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** A refused attempt. The API answers 429 with `Retry-After`. */
export class TooManyAttempts extends AccessError {
  readonly retryAfterSeconds: number;

  constructor(waitMs: number) {
    const seconds = Math.max(1, Math.ceil(waitMs / SECOND));
    super(429, `Too many failed attempts. Try again in ${spell(seconds)}.`);
    this.name = "TooManyAttempts";
    this.retryAfterSeconds = seconds;
  }
}

/**
 * Failed attempts per key, in memory and per app, so a restart forgets them. Once a key reaches its kind's limit it
 * waits `FIRST_WAIT_MS`, doubling with each further failure up to `MAX_WAIT_MS`, until a success or a whole window
 * without failing after the last wait. Attempts refused while waiting aren't counted and store nothing, so a flood
 * of refusals can't grow the map.
 */
export class AttemptLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The counter for `key` of `kind`, such as one client's address or one username. */
  limit(kind: LimitKind, key: string): Limit {
    return { kind, key: printable(key) };
  }

  /** How long another attempt under `limit` must wait, or 0. */
  waitMs(limit: Limit): number {
    const bucket = this.buckets.get(bucketId(limit));
    if (!bucket) return 0;
    const at = this.now();
    if (at < bucket.blockedUntil) return bucket.blockedUntil - at;
    // Each attempt in flight may still fail, so only as many run at once as failures remain before the limit,
    // and one at a time once the key has reached it.
    const left = at < coolsAt(bucket) ? 1 : RULES[limit.kind].max - recent(bucket.failures, at).length;
    return bucket.pending >= Math.max(1, left) ? BUSY_WAIT_MS : 0;
  }

  /**
   * Run `fn` unless any of `limits` is waiting, which throws `TooManyAttempts` without running it. An error
   * `isFailure` accepts counts against every limit; a success clears those whose kind a success resets.
   */
  async attempt<T>(limits: Limit[], fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    const wait = Math.max(0, ...limits.map((limit) => this.waitMs(limit)));
    if (wait > 0) throw new TooManyAttempts(wait);
    const held = limits.map((limit) => ({ limit, bucket: this.hold(limit) }));
    let outcome: Outcome = "ignored";
    try {
      const result = await fn();
      outcome = "succeeded";
      return result;
    } catch (err) {
      if (isFailure(err)) outcome = "failed";
      throw err;
    } finally {
      for (const { limit, bucket } of held) this.settle(limit.kind, bucket, outcome);
      this.sweep();
    }
  }

  private hold(limit: Limit): Bucket {
    const id = bucketId(limit);
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { failures: [], strikes: 0, blockedUntil: 0, pending: 0 };
      this.buckets.set(id, bucket);
    }
    bucket.pending++;
    return bucket;
  }

  private settle(kind: LimitKind, bucket: Bucket, outcome: Outcome): void {
    bucket.pending--;
    if (outcome === "succeeded" && RULES[kind].resetOnSuccess) Object.assign(bucket, { failures: [], strikes: 0, blockedUntil: 0 });
    if (outcome !== "failed") return;
    const at = this.now();
    if (at >= coolsAt(bucket)) bucket.strikes = 0;
    bucket.failures = [...recent(bucket.failures, at), at];
    if (bucket.strikes === 0 && bucket.failures.length < RULES[kind].max) return;
    bucket.strikes++;
    const wait = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (bucket.strikes - 1));
    bucket.blockedUntil = Math.max(bucket.blockedUntil, at + wait);
  }

  /** Forget keys with nothing in flight, nothing to wait out, and no failure still counting. */
  private sweep(): void {
    const at = this.now();
    for (const [id, bucket] of this.buckets) {
      const idle = bucket.pending === 0 && at >= bucket.blockedUntil && at >= coolsAt(bucket);
      if (idle && recent(bucket.failures, at).length === 0) this.buckets.delete(id);
    }
  }
}

const bucketId = (limit: Limit) => `${limit.kind}:${limit.key}`;
const recent = (failures: number[], at: number) => failures.filter((t) => t > at - LIMIT_WINDOW_MS);
/** When a key that reached its limit counts as fresh again: a whole window after its last wait ended. */
const coolsAt = (bucket: Bucket) => (bucket.strikes > 0 ? bucket.blockedUntil + LIMIT_WINDOW_MS : 0);
