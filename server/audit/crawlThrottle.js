/**
 * Per-origin request pacing and 429 backoff.
 *
 * Every 429 pauses the whole crawl, not just the URL that hit it: the site is
 * telling us our overall rate is too high. A URL gets a bounded number of
 * retries; when the cooldown the site asks for exceeds the audit's budget, the
 * crawl stops early and says so (the `crawl-rate-limited` issue) rather than
 * recording unfetched URLs as broken.
 */

/** Retries per URL after its first 429. Every 429 still pauses new URLs. */
const MAX_RETRIES = 3;
const FIRST_DELAY_MS = 30_000;
const MAX_INTERVAL_MS = 30_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

/** `Retry-After` is either delay-seconds or an HTTP-date. */
function parseRetryAfterMs(header) {
  if (!header) return null;
  const value = header.trim();
  // Keep over-budget values finite for arithmetic.
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1_000, MAX_COOLDOWN_MS + 1);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * One audit's origin pacing. `deadlineAt` bounds how long this chunk may wait;
 * longer cooldowns are carried to the next chunk through `state`.
 */
export function createCrawlThrottle(deadlineAt, previous) {
  const state = previous
    ? { ...previous }
    : {
        intervalMs: 1_000,
        nextRequestAt: 0,
        pausedUntil: 0,
        consecutiveRateLimits: 0,
        cooldownMs: 0,
      };

  const stopped = () =>
    state.consecutiveRateLimits > MAX_RETRIES ||
    state.cooldownMs > MAX_COOLDOWN_MS;

  return {
    /** False when this chunk can no longer start a request. */
    async ready() {
      while (!stopped()) {
        const now = Date.now();
        const readyAt = Math.max(state.pausedUntil, state.nextRequestAt);
        if (now >= deadlineAt || readyAt >= deadlineAt) return false;
        if (readyAt <= now) {
          // Reserve synchronously: waiters waking together must take turns.
          state.nextRequestAt = now + state.intervalMs;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, readyAt - now));
      }
      return false;
    },

    /** Pause the origin on every 429; return whether this URL may retry. */
    async backoff(attempt, retryAfter) {
      state.consecutiveRateLimits += 1;
      state.intervalMs = Math.min(MAX_INTERVAL_MS, state.intervalMs * 2);
      const delayMs = Math.max(
        state.intervalMs,
        parseRetryAfterMs(retryAfter) ??
          FIRST_DELAY_MS * 2 ** (state.consecutiveRateLimits - 1),
      );
      const now = Date.now();
      const pausedUntil = Math.max(state.pausedUntil, now + delayMs);
      state.cooldownMs += pausedUntil - Math.max(now, state.pausedUntil);
      state.pausedUntil = pausedUntil;
      return !stopped() && attempt <= MAX_RETRIES;
    },

    /** A non-429 response breaks a run of consecutive refusals. */
    recovered() {
      state.consecutiveRateLimits = 0;
    },

    get stopped() {
      return stopped();
    },
    get state() {
      return { ...state };
    },
  };
}
