/**
 * Promise-chain mutex for serializing vault writes.
 *
 * Ensures only one write operation runs at a time, isolates errors
 * so a failed write doesn't break the chain, and batches git pushes
 * on a trailing 30-second timer.
 */

export class WriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFn: (() => Promise<void>) | null = null;
  private pendingPush = false;
  private pendingCount = 0;
  private oldestQueuedAt: number | null = null;

  /**
   * Enqueue a write operation. Runs sequentially — each operation
   * waits for the previous one to settle before starting.
   * Errors reject the returned promise but don't break the chain.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const enqueuedAt = Date.now();
    this.pendingCount++;
    if (this.oldestQueuedAt === null) this.oldestQueuedAt = enqueuedAt;
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        try {
          const result = await fn();
          resolve(result);
          this.schedulePushIfNeeded();
        } catch (err) {
          reject(err);
          this.schedulePushIfNeeded();
        } finally {
          this.pendingCount--;
          if (this.pendingCount === 0) this.oldestQueuedAt = null;
        }
      });
    });
  }

  /**
   * Number of operations currently queued (not yet settled). Zero when
   * the queue is idle. Read by vault_status(mode: "perf").
   */
  depth(): number {
    return this.pendingCount;
  }

  /**
   * Milliseconds since the oldest still-pending op was enqueued. Zero
   * when the queue is idle. Spikes here are a tail-latency signal.
   */
  oldestQueuedAgeMs(): number {
    if (this.oldestQueuedAt === null) return 0;
    return Date.now() - this.oldestQueuedAt;
  }

  /**
   * Register a push function and enable batched pushing.
   * After each write, a push is scheduled 30s out. Subsequent
   * writes reset the timer so pushes batch naturally.
   */
  schedulePush(pushFn: () => Promise<void>): void {
    this.pushFn = pushFn;
  }

  private schedulePushIfNeeded(): void {
    if (!this.pushFn) return;
    this.pendingPush = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.executePush();
    }, 30_000);
  }

  private async executePush(): Promise<void> {
    if (!this.pushFn || !this.pendingPush) return;
    this.pendingPush = false;
    this.pushTimer = null;
    try {
      await this.pushFn();
    } catch (err) {
      console.error(`[write-queue] git push failed: ${(err as Error).message}`);
    }
  }

  /** Force an immediate push — use for graceful shutdown. */
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    // Wait for any in-flight writes to finish
    await this.chain;
    await this.executePush();
  }
}
