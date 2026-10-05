/**
 * In-memory fixed-window rate limiter.
 *
 * Chosen over a DB-count check because Weltbon runs as a single Node process
 * (one container per instance), so process memory is the whole picture, and a
 * limiter that never touches the database cannot be used to load it. The cost:
 * counts reset when the process restarts, and a multi-replica deployment would
 * give each replica its own budget. Revisit if the API ever runs more than one
 * process behind a load balancer.
 */
export interface FixedWindowLimiter {
  /** Count one hit against `key`. `retryAfterSeconds` is 0 when allowed. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
  /** Forget every key. Tests use this to start each case with a clean budget. */
  reset(): void;
  /** Number of keys currently tracked. */
  size(): number;
}

export function createFixedWindowLimiter(opts: {
  limit: number;
  windowMs: number;
  /** Most live windows tracked; past it, unseen keys are refused until some expire. */
  maxKeys?: number;
  now?: () => number;
}): FixedWindowLimiter {
  const { limit, windowMs, maxKeys = 10_000, now = Date.now } = opts;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  function sweep(t: number, force = false) {
    // At most once per window, drop every window that has already ended, so
    // a stream of one-off addresses cannot grow the map without bound.
    if (!force && t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, w] of windows) {
      if (t - w.start >= windowMs) windows.delete(key);
    }
  }

  return {
    hit(key) {
      const t = now();
      sweep(t);
      const current = windows.get(key);
      if (!current && windows.size >= maxKeys) {
        // Full of live windows: fail closed for new keys rather than grow.
        sweep(t, true);
        if (windows.size >= maxKeys) {
          let oldest = t;
          for (const w of windows.values()) oldest = Math.min(oldest, w.start);
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
        }
      }
      if (!current || t - current.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (current.count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((current.start + windowMs - t) / 1000) };
      }
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      windows.clear();
      lastSweep = now();
    },
    size() {
      return windows.size;
    },
  };
}
