/** Fixed-window counter keyed by an arbitrary string such as an IP address or phone id. */
export class RateLimiter {
  private windows = new Map<string, { count: number; start: number }>();
  private lastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt and returns whether it is allowed. */
  allow(key: string, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.windows.set(key, { count: 1, start: now });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
