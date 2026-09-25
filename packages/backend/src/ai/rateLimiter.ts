/**
 * Request pacing for AI providers.
 *
 * Free tiers allow a handful of requests per minute. Firing agent calls back
 * to back exhausts that window in seconds, and short retries cannot outlast a
 * one-minute window. Pacing spaces requests out instead:
 *   - AI_MAX_REQUESTS_PER_MINUTE sets an explicit ceiling (0 = none)
 *   - otherwise the limiter stays off until the first 429, then adopts a
 *     ceiling just under the rate that was observed to fail
 */
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ai:pacing');
const WINDOW_MS = 60_000;
const sleepers = new Set<() => void>();
/** A wait that resetPacing() can cut short. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); sleepers.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    sleepers.add(done);
  });
}

let ceiling: number = env.AI_MAX_REQUESTS_PER_MINUTE > 0 ? env.AI_MAX_REQUESTS_PER_MINUTE : 0;
const recent: number[] = [];
let queue: Promise<void> = Promise.resolve();

function prune(now: number): void {
  while (recent.length && now - recent[0]! >= WINDOW_MS) recent.shift();
}

/** Waits until a request may be sent under the current ceiling, then records it. */
export function acquireSlot(): Promise<void> {
  const next = queue.then(async () => {
    for (;;) {
      // Re-checked every pass: the ceiling can change (or be lifted) while waiting.
      const now = Date.now();
      prune(now);
      if (ceiling <= 0 || recent.length < ceiling || recent.length === 0) break;
      const wait = Math.max(50, WINDOW_MS - (now - recent[0]!) + 50);
      log.info(`Pacing AI requests (${ceiling}/min): waiting ${Math.ceil(wait / 1000)}s.`);
      await sleep(wait);
    }
    recent.push(Date.now());
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Called on a 429: tightens the ceiling to just below what was observed. */
export function noteRateLimited(): void {
  prune(Date.now());
  const observed = recent.length;
  const proposed = Math.max(2, Math.min(observed - 1, ceiling || observed - 1));
  if (ceiling === 0 || proposed < ceiling) {
    ceiling = proposed;
    log.warn(`Provider is rate limiting; pacing to ${ceiling} request(s) per minute from now on.`);
  }
}

/**
 * How long to wait before retrying a rate-limited request: the provider's own
 * hint when it gives one ("retry in 27s", "retryDelay": "27s"), otherwise
 * long enough for the per-minute window to roll over.
 */
export function rateLimitDelayMs(message: string, attempt: number): number {
  const hint = message.match(/retry(?:Delay)?["']?\s*(?:in|:)?\s*["']?(\d+(?:\.\d+)?)\s*s/i)?.[1];
  if (hint) return Math.min(90_000, Math.ceil(Number(hint) * 1000) + 500);
  return Math.min(65_000, 15_000 * (attempt + 1)) + Math.floor(Math.random() * 1000);
}

/** Test seam. */
export function resetPacing(max = 0): void {
  ceiling = max;
  recent.length = 0;
  queue = Promise.resolve();
  for (const wake of [...sleepers]) wake();
}
