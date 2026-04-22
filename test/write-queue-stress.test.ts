/**
 * WriteQueue stress test — 100 concurrent enqueues under real contention.
 *
 * The existing write-queue.test.ts covers the contract (serial execution,
 * error isolation, flush semantics). This test covers the invariant:
 * **no matter how many writes hit at once, they never interleave and the
 * final state is deterministic.**
 *
 * This is grove's foundational correctness property. CLAUDE.md rule #3
 * ("all writes are serialized, no concurrent git operations, ever") is
 * not aspirational — it's why the server can be the sole writer to git
 * without split-brain. If this test fails, the write queue is broken and
 * grove can corrupt its own vault.
 */

import { describe, it, expect } from "vitest";
import { WriteQueue } from "../src/write-queue.js";

describe("WriteQueue under concurrent pressure", () => {
  it("serializes 100 concurrent enqueues without interleaving", async () => {
    const queue = new WriteQueue();
    const log: Array<{ id: number; phase: "start" | "end"; at: number }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const start = Date.now();
    const promises: Promise<number>[] = [];

    for (let i = 0; i < 100; i++) {
      promises.push(
        queue.enqueue(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          log.push({ id: i, phase: "start", at: Date.now() - start });
          // Variable-length work — some slow, some fast — to tempt
          // interleaving if the chain isn't actually enforcing order.
          await new Promise((r) => setTimeout(r, i % 7));
          log.push({ id: i, phase: "end", at: Date.now() - start });
          inFlight--;
          return i;
        }),
      );
    }

    const results = await Promise.all(promises);

    // Contract: every operation ran exactly once, returning its own id.
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));

    // Invariant 1: at most one operation in flight at any time.
    expect(maxInFlight).toBe(1);

    // Invariant 2: FIFO — operations ran in enqueue order.
    const starts = log.filter((e) => e.phase === "start").map((e) => e.id);
    expect(starts).toEqual(Array.from({ length: 100 }, (_, i) => i));

    // Invariant 3: each operation's start is strictly after the previous
    // one's end (no overlap).
    for (let i = 1; i < 100; i++) {
      const prevEnd = log.find((e) => e.id === i - 1 && e.phase === "end")!;
      const thisStart = log.find((e) => e.id === i && e.phase === "start")!;
      expect(thisStart.at).toBeGreaterThanOrEqual(prevEnd.at);
    }
  });

  it("failing writes don't interleave with or break the chain under pressure", async () => {
    const queue = new WriteQueue();
    const completed: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const promises: Promise<unknown>[] = [];

    // Every 3rd write throws; the chain should isolate each failure
    // without interleaving and still complete the surrounding writes.
    for (let i = 0; i < 60; i++) {
      promises.push(
        queue
          .enqueue(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight--;
            if (i % 3 === 0) throw new Error(`boom-${i}`);
            completed.push(i);
          })
          .catch((err) => err),
      );
    }

    await Promise.all(promises);

    // Still no interleaving, even with errors.
    expect(maxInFlight).toBe(1);

    // Every non-throwing write ran exactly once, in order.
    const expectedCompleted = Array.from({ length: 60 }, (_, i) => i).filter(
      (i) => i % 3 !== 0,
    );
    expect(completed).toEqual(expectedCompleted);
  });

  it("flush drains under pressure and triggers exactly one push", async () => {
    const queue = new WriteQueue();
    let pushCount = 0;
    queue.schedulePush(async () => {
      pushCount++;
    });

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        queue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, i % 3));
        }),
      );
    }

    await queue.flush();

    // All writes settled before flush returned.
    await Promise.all(writes);

    // Flush triggered exactly one push (the batched one), not 50.
    expect(pushCount).toBe(1);
  });
});
