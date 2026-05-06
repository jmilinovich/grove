import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-waitlist-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

// Import after setting GROVE_DB_PATH so the singleton uses our test DB.
import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  addToWaitlist,
  listWaitlist,
  waitlistCount,
  normaliseEmail,
  InvalidWaitlistEmailError,
} from "../src/waitlist.js";

// Ensure RESEND_API_KEY is unset so the email helper takes the dev-fallback
// log path instead of trying to call out. The fire-and-forget `void` in
// addToWaitlist would swallow a fetch failure, but having the key unset
// keeps the test fully offline and deterministic.
const originalKey = process.env.RESEND_API_KEY;
delete process.env.RESEND_API_KEY;

describe("waitlist", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM waitlist");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normaliseEmail", () => {
    it("trims, lowercases, accepts simple shapes", () => {
      expect(normaliseEmail("  Hello@Example.COM ")).toBe("hello@example.com");
      expect(normaliseEmail("a@b.co")).toBe("a@b.co");
    });

    it("rejects empty, missing @, and oversize", () => {
      expect(normaliseEmail("")).toBeNull();
      expect(normaliseEmail("not-an-email")).toBeNull();
      expect(normaliseEmail("a@b")).toBeNull();
      expect(normaliseEmail("a@".padEnd(300, "x") + "@c.co")).toBeNull();
    });
  });

  describe("addToWaitlist", () => {
    it("inserts a fresh email and returns added=true", async () => {
      const r = await addToWaitlist({
        email: "alice@example.com",
        source: "hero",
        ip: "1.2.3.4",
        userAgent: "ua",
      });
      expect(r).toEqual({ ok: true, added: true, email: "alice@example.com" });

      const rows = listWaitlist();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email).toBe("alice@example.com");
      expect(rows[0]!.source).toBe("hero");
      expect(rows[0]!.ip).toBe("1.2.3.4");
      expect(rows[0]!.user_agent).toBe("ua");
    });

    it("normalises email casing on insert", async () => {
      await addToWaitlist({ email: "  Alice@Example.com ", source: "hero" });
      const rows = listWaitlist();
      expect(rows[0]!.email).toBe("alice@example.com");
    });

    it("returns added=false on duplicate, leaves a single row", async () => {
      await addToWaitlist({ email: "bob@example.com", source: "hero" });
      const r2 = await addToWaitlist({ email: "BOB@example.com", source: "bottom-cta" });
      expect(r2.added).toBe(false);
      expect(waitlistCount()).toBe(1);
      // Original source preserved — INSERT OR IGNORE doesn't overwrite.
      expect(listWaitlist()[0]!.source).toBe("hero");
    });

    it("throws InvalidWaitlistEmailError on malformed email", async () => {
      await expect(
        addToWaitlist({ email: "not-an-email", source: "hero" }),
      ).rejects.toBeInstanceOf(InvalidWaitlistEmailError);
      expect(waitlistCount()).toBe(0);
    });

    it("clamps source to 64 chars", async () => {
      const longSource = "x".repeat(200);
      await addToWaitlist({ email: "carol@example.com", source: longSource });
      expect(listWaitlist()[0]!.source).toHaveLength(64);
    });
  });

  describe("listWaitlist", () => {
    it("returns rows newest first", async () => {
      await addToWaitlist({ email: "first@example.com" });
      await new Promise((r) => setTimeout(r, 1100)); // datetime('now') is second-precision
      await addToWaitlist({ email: "second@example.com" });
      const rows = listWaitlist();
      expect(rows.map((r) => r.email)).toEqual([
        "second@example.com",
        "first@example.com",
      ]);
    });

    it("respects the limit and cap", async () => {
      for (let i = 0; i < 5; i++) {
        await addToWaitlist({ email: `u${i}@example.com` });
      }
      expect(listWaitlist(2)).toHaveLength(2);
      // Negative / zero / non-finite all snap up to >=1.
      expect(listWaitlist(0)).toHaveLength(1);
      expect(listWaitlist(-5)).toHaveLength(1);
    });
  });
});

// Restore env after the suite so other test files aren't affected.
afterEach(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

// Clean up the temp DB dir at process exit. Mirrors the auth.test pattern.
process.on("exit", () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
