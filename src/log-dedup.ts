/**
 * Rate-limit repeated log lines (Watchdog / ProcessManager spam).
 * Keyed by message fingerprint; emits a summary when the window closes.
 */

export type DedupLogFn = (line: string) => void;

export class LogDeduper {
  private readonly windowMs: number;
  private readonly log: DedupLogFn;
  private readonly lastAt = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();

  constructor(windowMs = 60_000, log: DedupLogFn = console.log) {
    this.windowMs = windowMs;
    this.log = log;
  }

  /** Returns true if the line was printed (not suppressed). */
  emit(key: string, line: string): boolean {
    const now = Date.now();
    const prev = this.lastAt.get(key);
    if (prev !== undefined && now - prev < this.windowMs) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return false;
    }
    const n = this.suppressed.get(key) ?? 0;
    if (n > 0) {
      this.log(`[LogDedup] suppressed ${n} repeat(s) for key=${key} in last window`);
      this.suppressed.delete(key);
    }
    this.lastAt.set(key, now);
    this.log(line);
    return true;
  }
}

/** Shared Watchdog spam gate (process-wide). */
export const watchdogLogDedup = new LogDeduper(60_000);
