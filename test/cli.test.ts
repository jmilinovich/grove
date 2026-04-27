import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, CliError, validateDeleteFlags, walkIngestSources } from "../src/cli.js";

// HELP / printCommandHelp tests live in test/cli/help.test.ts.

// ── parseArgs ───────────────────────────────────────────────────────

describe("parseArgs", () => {
  // parseArgs reads process.stdout.isTTY for auto-detection.
  // Force TTY=true for predictable tests (non-TTY tests override below).
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses a simple command", () => {
    const result = parseArgs(["search"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("");
    expect(result.flags).toEqual({});
  });

  it("parses command with positional argument", () => {
    const result = parseArgs(["search", "taste graph"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("taste graph");
  });

  it("parses long flags with values", () => {
    const result = parseArgs(["search", "query", "--since", "1 week ago"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("query");
    expect(result.flags.since).toBe("1 week ago");
  });

  it("parses boolean long flags", () => {
    const result = parseArgs(["sync", "dir", "--dry-run"]);
    expect(result.command).toBe("sync");
    expect(result.positional).toBe("dir");
    expect(result.flags["dry-run"]).toBe(true);
  });

  it("parses short flags with values", () => {
    const result = parseArgs(["search", "query", "-n", "5"]);
    expect(result.command).toBe("search");
    expect(result.flags.n).toBe("5");
  });

  it("parses boolean short flags", () => {
    const result = parseArgs(["list", "pattern", "-v"]);
    expect(result.flags.v).toBe(true);
  });

  it("defaults to 'help' when no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
  });

  it("handles multiple flags together", () => {
    const result = parseArgs(["search", "query", "--since", "3 days ago", "-n", "20", "--aliases"]);
    expect(result.flags.since).toBe("3 days ago");
    expect(result.flags.n).toBe("20");
    expect(result.flags.aliases).toBe(true);
  });

  it("only captures first positional argument", () => {
    const result = parseArgs(["read", "file1", "file2"]);
    expect(result.positional).toBe("file1");
  });

  it("parses --json as boolean flag", () => {
    const result = parseArgs(["search", "test", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("accepts a leading boolean flag before the command", () => {
    const result = parseArgs(["--json", "search", "knowledge graph"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("knowledge graph");
    expect(result.flags.json).toBe(true);
  });

  it("accepts a leading value flag before the command", () => {
    const result = parseArgs(["-n", "5", "search", "taste"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("taste");
    expect(result.flags.n).toBe("5");
  });

  it("auto-enables json when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    const result = parseArgs(["search", "test"]);
    expect(result.flags.json).toBe(true);
  });

  it("does not auto-enable json when stdout is a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const result = parseArgs(["search", "test"]);
    expect(result.flags.json).toBeUndefined();
  });
});

// ── CliError ────────────────────────────────────────────────────────

describe("CliError", () => {
  it("creates error with code, message, and default exitCode", () => {
    const err = new CliError("not_found", "Note not found");
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("Note not found");
    expect(err.exitCode).toBe(1);
    expect(err).toBeInstanceOf(Error);
  });

  it("creates error with custom exitCode", () => {
    const err = new CliError("auth_error", "Bad token", 2);
    expect(err.exitCode).toBe(2);
  });

  it("creates server error with exitCode 3", () => {
    const err = new CliError("server_error", "Connection refused", 3);
    expect(err.exitCode).toBe(3);
  });

  it("exit code semantics: 1=not_found, 2=auth, 3=server", () => {
    expect(new CliError("not_found", "").exitCode).toBe(1);
    expect(new CliError("bad_request", "").exitCode).toBe(1);
    expect(new CliError("auth_error", "", 2).exitCode).toBe(2);
    expect(new CliError("config_missing", "", 2).exitCode).toBe(2);
    expect(new CliError("server_error", "", 3).exitCode).toBe(3);
    expect(new CliError("connection_refused", "", 3).exitCode).toBe(3);
  });
});

// ── parseArgs: ingest flags ──────────────────────────────────────

describe("parseArgs ingest flags", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses ingest command with directory", () => {
    const result = parseArgs(["ingest", "./import/"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
  });

  it("parses ingest with --dry-run", () => {
    const result = parseArgs(["ingest", "./import/", "--dry-run"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
    expect(result.flags["dry-run"]).toBe(true);
  });

  it("parses ingest with --json", () => {
    const result = parseArgs(["ingest", "./import/", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses ingest with --recursive (positional comes first)", () => {
    const result = parseArgs(["ingest", "./import/", "--recursive"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
    expect(result.flags.recursive).toBe(true);
  });

  it("parses ingest with --recursive before the directory (boolean, doesn't consume next arg)", () => {
    const result = parseArgs(["ingest", "--recursive", "./import/"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
    expect(result.flags.recursive).toBe(true);
  });

  it("parses ingest with -r short flag", () => {
    const result = parseArgs(["ingest", "-r", "./import/"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
    expect(result.flags.r).toBe(true);
  });
});

// ── walkIngestSources: recursion behavior ─────────────────────────

describe("walkIngestSources", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "grove-ingest-"));
    writeFileSync(join(tmp, "top.md"), "# top\n");
    writeFileSync(join(tmp, "skip.txt"), "txt is also picked up");
    writeFileSync(join(tmp, "ignore.json"), "{}");
    mkdirSync(join(tmp, "nested"));
    writeFileSync(join(tmp, "nested", "child.md"), "# child\n");
    mkdirSync(join(tmp, "nested", "deeper"));
    writeFileSync(join(tmp, "nested", "deeper", "grandchild.md"), "# grand\n");
    // dotdirs (.git, .obsidian) must be skipped even in recursive mode
    mkdirSync(join(tmp, ".obsidian"));
    writeFileSync(join(tmp, ".obsidian", "config.md"), "should not appear");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("returns only top-level files when recursive=false", () => {
    const out = walkIngestSources(tmp, false);
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(["skip.txt", "top.md"]);
  });

  it("walks nested directories when recursive=true", () => {
    const out = walkIngestSources(tmp, true);
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(["child.md", "grandchild.md", "skip.txt", "top.md"]);
  });

  it("absPath points at the actual file on disk in nested mode", () => {
    const out = walkIngestSources(tmp, true);
    const child = out.find((e) => e.name === "child.md");
    expect(child).toBeDefined();
    expect(child!.absPath).toBe(join(tmp, "nested", "child.md"));
  });

  it("skips dotfiles and dotdirs even when recursive", () => {
    const out = walkIngestSources(tmp, true);
    const names = out.map((e) => e.name);
    expect(names).not.toContain("config.md");
  });
});

// ── parseArgs: --content flag ─────────────────────────────────────

describe("parseArgs --content flag", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses --content with a string value", () => {
    const result = parseArgs(["write", "path.md", "--content", "hello world", "--type", "concept"]);
    expect(result.flags.content).toBe("hello world");
    expect(result.flags.type).toBe("concept");
  });

  it("parses --content alongside --json", () => {
    const result = parseArgs(["write", "path.md", "--content", "text", "--json"]);
    expect(result.flags.content).toBe("text");
    expect(result.flags.json).toBe(true);
  });
});

// ── parseArgs: vault subcommands ─────────────────────────────────

describe("parseArgs vault", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it.each(["status", "encrypt", "unlock", "lock"])(
    "parses vault %s as positional",
    (sub) => {
      const result = parseArgs(["vault", sub]);
      expect(result.command).toBe("vault");
      expect(result.positional).toBe(sub);
    },
  );

  it("parses bare `grove vault` with no positional (defaults to status)", () => {
    const result = parseArgs(["vault"]);
    expect(result.command).toBe("vault");
    expect(result.positional).toBe("");
  });

  it("parses vault status with --json", () => {
    const result = parseArgs(["vault", "status", "--json"]);
    expect(result.command).toBe("vault");
    expect(result.positional).toBe("status");
    expect(result.flags.json).toBe(true);
  });
});

// ── Passphrase prompt helper ─────────────────────────────────────

describe("promptPassphrase", () => {
  it("returns env var value when set", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    process.env.GROVE_TEST_PASSPHRASE = "swordfish";
    try {
      const result = await promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" });
      expect(result).toBe("swordfish");
    } finally {
      delete process.env.GROVE_TEST_PASSPHRASE;
    }
  });

  it("errors when stdin is not a TTY and env var is unset", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    const prevTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    delete process.env.GROVE_TEST_PASSPHRASE;
    try {
      await expect(
        promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" }),
      ).rejects.toThrow(/PASSPHRASE_REQUIRED|TTY/i);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("treats an empty env var as unset (falls through to TTY/error)", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    const prevTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.env.GROVE_TEST_PASSPHRASE = "";
    try {
      await expect(
        promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" }),
      ).rejects.toThrow(/PASSPHRASE_REQUIRED|TTY/i);
    } finally {
      delete process.env.GROVE_TEST_PASSPHRASE;
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });
});

// ── parseArgs: delete / move ────────────────────────────────────

describe("parseArgs delete", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses `grove delete <path>`", () => {
    const result = parseArgs(["delete", "Inbox/old-idea.md"]);
    expect(result.command).toBe("delete");
    expect(result.positional).toBe("Inbox/old-idea.md");
    expect(result.flags.hard).toBeUndefined();
  });

  it("parses --hard as a boolean flag (no positional consumed)", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--hard", "--yes"]);
    expect(result.positional).toBe("Inbox/x.md");
    expect(result.flags.hard).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it("parses delete with --json", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses --if-hash on delete", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--if-hash", "abc123"]);
    expect(result.flags["if-hash"]).toBe("abc123");
  });
});

describe("parseArgs move", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("captures both positionals for `grove move <from> <to>`", () => {
    const result = parseArgs(["move", "Inbox/idea.md", "Resources/Concepts/idea.md"]);
    expect(result.command).toBe("move");
    expect(result.positional).toBe("Inbox/idea.md");
    expect(result.positionals).toEqual(["Inbox/idea.md", "Resources/Concepts/idea.md"]);
  });

  it("preserves positionals alongside flags", () => {
    const result = parseArgs(["move", "a.md", "b.md", "--json"]);
    expect(result.positionals).toEqual(["a.md", "b.md"]);
    expect(result.flags.json).toBe(true);
  });

  it("accepts flags interleaved with positionals", () => {
    const result = parseArgs(["move", "a.md", "--if-hash", "abc", "b.md"]);
    expect(result.positionals).toEqual(["a.md", "b.md"]);
    expect(result.flags["if-hash"]).toBe("abc");
  });
});

// ── validateDeleteFlags ──────────────────────────────────────────

describe("validateDeleteFlags", () => {
  it("allows soft delete with no flags", () => {
    expect(() => validateDeleteFlags({}, "Inbox/x.md")).not.toThrow();
  });

  it("allows --hard when --yes is set", () => {
    expect(() => validateDeleteFlags({ hard: true, yes: true }, "Inbox/x.md")).not.toThrow();
  });

  it("rejects --hard without --yes with exit code 1", () => {
    try {
      validateDeleteFlags({ hard: true }, "Inbox/x.md");
      throw new Error("expected validateDeleteFlags to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(1);
      expect((err as CliError).message).toMatch(/--yes/);
      expect((err as CliError).message).toContain("Inbox/x.md");
    }
  });
});

