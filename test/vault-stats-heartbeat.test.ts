// Heartbeat decoupling — the page that woke John up overnight 2026-05-06
// happened because the heartbeat only fired when computeVaultStats() succeeded.
// On a 1949-file vault graph compute regularly hit the 30s timeout, refreshStats
// rejected, no ping landed, Better Stack expired the heartbeat and paged. The
// fix: an independent fixed-interval timer that fires whenever the proxy event
// loop is alive, regardless of stats outcome.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  pingHeartbeatNow,
  startHeartbeatTimer,
  stopHeartbeatTimer,
} from "../src/vault-stats.js";

describe("heartbeat timer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    stopHeartbeatTimer();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires immediately on start, then on every interval tick", async () => {
    startHeartbeatTimer(60_000);

    // Immediate ping at t=0
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No second ping before the interval elapses
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Tick: second ping
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Two more intervals → two more pings
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops cleanly when stopHeartbeatTimer is called", async () => {
    startHeartbeatTimer(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stopHeartbeatTimer();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starting twice does not stack timers (no double-pings)", async () => {
    startHeartbeatTimer(60_000);
    startHeartbeatTimer(60_000);

    // Two immediate pings (one per start), but only one timer running
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    // One more ping from the (single) interval, not two
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("pings even when stats are unavailable (the bug we're fixing)", async () => {
    // No refreshStats() call here — lastRefreshed stays null. Old code path
    // wouldn't have fired any heartbeat. New path fires with an "alive |
    // stats=unavailable" payload.
    await pingHeartbeatNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("uptime.betterstack.com/api/v1/heartbeat");
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toContain("alive");
  });

  it("swallows fetch errors so a Better Stack outage doesn't crash the proxy", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    // Should not throw; the warn is swallowed inside.
    await expect(pingHeartbeatNow()).resolves.toBeUndefined();
  });
});
