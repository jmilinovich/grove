import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runEdit, simpleDiff, type EditDeps } from "../../src/cli/edit.js";
import { GroveCliError } from "../../src/cli/lib/errors.js";

describe("simpleDiff", () => {
  it("returns empty-like output when strings are identical", () => {
    const out = simpleDiff("hello\nworld", "hello\nworld");
    expect(out.length).toBe(0);
  });

  it("shows minus/plus for changed lines", () => {
    const out = simpleDiff("a\nb\nc", "a\nX\nc");
    expect(out).toContain("- b");
    expect(out).toContain("+ X");
  });

  it("shows added lines as plus-only", () => {
    const out = simpleDiff("a", "a\nb");
    expect(out).toContain("+ b");
  });

  it("shows removed lines as minus-only", () => {
    const out = simpleDiff("a\nb", "a");
    expect(out).toContain("- b");
  });

  it("caps output at 40 diff lines", () => {
    const a = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const b = Array.from({ length: 100 }, (_, i) => `LINE-${i}`).join("\n");
    const out = simpleDiff(a, b);
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(42); // 40 + the trailing "... more" line
  });
});

describe("runEdit: headless refusal", () => {
  const savedStdin = process.stdin.isTTY;
  const savedStdout = process.stdout.isTTY;
  const savedEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: savedStdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: savedStdout, configurable: true });
    process.env = { ...savedEnv };
  });

  it("refuses when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    delete process.env.GROVE_FORCE_TTY;

    const deps: EditDeps = {
      getNote: async () => ({ content: "a", source_hash: "h" }),
      putNote: async () => ({ status: 200, data: {} }),
    };

    try {
      await runEdit("x.md", deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("HEADLESS_EDITOR");
      // Suggestion must point to the agent-safe alternative.
      expect((e as GroveCliError).suggestions.some((s) => s.startsWith("grove patch"))).toBe(true);
    }
  });

  it("proceeds when stdin is a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const deps: EditDeps = {
      getNote: async () => ({ content: "original", source_hash: "h1" }),
      putNote: async () => ({ status: 200, data: { source_hash: "h2" } }),
      simulatedEdit: (c) => c + "\n-- edited --",
    };

    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("written");
    expect(outcome.new_source_hash).toBe("h2");
  });

  it("GROVE_FORCE_TTY=1 bypasses headless check", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.env.GROVE_FORCE_TTY = "1";

    const deps: EditDeps = {
      getNote: async () => ({ content: "a", source_hash: "h" }),
      putNote: async () => ({ status: 200, data: {} }),
      simulatedEdit: (c) => c + "!",
    };

    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("written");
  });
});

describe("runEdit: conflict recovery", () => {
  const savedStdin = process.stdin.isTTY;
  const savedStdout = process.stdout.isTTY;
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: savedStdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: savedStdout, configurable: true });
  });

  it("returns unchanged when simulatedEdit is identity", async () => {
    const deps: EditDeps = {
      getNote: async () => ({ content: "same", source_hash: "h" }),
      putNote: async () => ({ status: 200, data: {} }),
      simulatedEdit: (c) => c,
    };
    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("unchanged");
  });

  it("handles 409 → retry: re-edits with latest content", async () => {
    let putCalls = 0;
    let serverContent = "latest-server-version";
    const deps: EditDeps = {
      getNote: async () => ({
        content: putCalls === 0 ? "original" : serverContent,
        source_hash: putCalls === 0 ? "h1" : "h2",
      }),
      putNote: async (p, content, hash) => {
        putCalls++;
        if (putCalls === 1) return { status: 409, data: { error: "conflict" } };
        serverContent = content;
        return { status: 200, data: { source_hash: "h3" } };
      },
      promptChar: async () => "r",
      simulatedEdit: (c) => c + "-edited",
    };
    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("overwritten");
    expect(putCalls).toBe(2);
    expect(outcome.new_source_hash).toBe("h3");
  });

  it("handles 409 → overwrite: uses latest hash and force-writes", async () => {
    let putCalls = 0;
    const deps: EditDeps = {
      getNote: async () => ({ content: "server-latest", source_hash: putCalls === 0 ? "h1" : "h2" }),
      putNote: async () => {
        putCalls++;
        if (putCalls === 1) return { status: 409, data: {} };
        return { status: 200, data: { source_hash: "h3" } };
      },
      promptChar: async () => "o",
      simulatedEdit: (c) => c + "-edited",
    };
    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("overwritten");
    expect(putCalls).toBe(2);
  });

  it("handles 409 → abort: returns aborted with tempfile path", async () => {
    const deps: EditDeps = {
      getNote: async () => ({ content: "x", source_hash: "h" }),
      putNote: async () => ({ status: 409, data: {} }),
      promptChar: async () => "a",
      simulatedEdit: (c) => c + "-edited",
    };
    const outcome = await runEdit("x.md", deps);
    expect(outcome.status).toBe("aborted");
    expect(outcome.tempfile).toBeDefined();
    // Verify tempfile still exists (for recovery).
    const { existsSync } = await import("node:fs");
    expect(existsSync(outcome.tempfile!)).toBe(true);
  });

  it("non-409 failure throws SERVER_ERROR with tempfile detail", async () => {
    const deps: EditDeps = {
      getNote: async () => ({ content: "x", source_hash: "h" }),
      putNote: async () => ({ status: 500, data: { error: "boom" } }),
      simulatedEdit: (c) => c + "-edited",
    };
    try {
      await runEdit("x.md", deps);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("SERVER_ERROR");
      expect((e as GroveCliError).details?.tempfile).toBeDefined();
    }
  });
});
