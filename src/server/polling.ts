/** A real clock and a deterministic test clock use the same small timer interface. */
export interface PollingTimers {
  now(): number;
  schedule(callback: () => void, delayMilliseconds: number): () => void;
}

export const systemPollingTimers: PollingTimers = {
  now: () => Date.now(),
  schedule(callback, delayMilliseconds) {
    const timer = setTimeout(callback, delayMilliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

interface PollingOptions {
  task(): Promise<boolean>;
  intervalMilliseconds(): number;
  enabled(): boolean;
  nextRunChanged(at: string | null): void;
  unexpectedError(error: unknown): void;
  timers?: PollingTimers;
}

/** Owns serialization and scheduling, independent of Tally, HTTP and database details. */
export class PollingLoop {
  private running = false;
  private failures = 0;
  private inFlight: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly timers: PollingTimers;

  constructor(private readonly options: PollingOptions) {
    this.timers = options.timers ?? systemPollingTimers;
  }

  start(): void {
    this.running = true;
    this.reschedule();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.options.nextRunChanged(null);
  }

  settingsChanged(): void {
    // An active check keeps its current configuration. Its finally block reads new settings.
    if (!this.inFlight) this.reschedule();
  }

  async idle(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
  }

  async runNow(task = this.options.task): Promise<void> {
    // Manual company-specific requests serialize too; they never borrow another company's result.
    while (this.inFlight) await this.inFlight.catch(() => undefined);
    this.clearTimer();
    this.options.nextRunChanged(null);
    const run = this.perform(task);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
      this.reschedule();
    }
  }

  private async perform(task: () => Promise<boolean>): Promise<void> {
    try {
      const succeeded = await task();
      this.failures = succeeded ? 0 : this.failures + 1;
    } catch (error) {
      this.failures++;
      throw error;
    }
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private reschedule(): void {
    this.clearTimer();
    if (!this.running || !this.options.enabled()) return;
    const baseDelay = this.options.intervalMilliseconds();
    const backoffDelay = Math.min(baseDelay * 2 ** Math.min(this.failures, 5), 600_000);
    const delay = Math.max(baseDelay, backoffDelay);
    this.options.nextRunChanged(new Date(this.timers.now() + delay).toISOString());
    this.cancelTimer = this.timers.schedule(() => {
      this.cancelTimer = null;
      void this.runNow().catch((error) => this.options.unexpectedError(error));
    }, delay);
  }
}
