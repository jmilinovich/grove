import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";

describe("CLI contract: whoami", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/whoami": {
          status: 200,
          body: {
            key_id: "key_123",
            key_name: "test",
            scopes: ["read", "write"],
            vault_id: "life",
          },
        },
      },
    });
  });
  afterAll(() => h.close());

  it("whoami --format json returns ok envelope to stdout, exit 0", async () => {
    const r = await h.runCli(["whoami", "--format", "json"]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.key_id).toBe("key_123");
    expect(parsed.data.key_name).toBe("test");
  });

  it("auto-JSON when stdout is not a TTY (default)", async () => {
    const r = await h.runCli(["whoami"]);
    expect(r.exit).toBe(0);
    // Stdout is piped (not TTY), so format defaults to json.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
  });
});

describe("CLI contract: errors", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/notes/missing.md": { status: 404, body: { error: "not found" } },
        "GET /v1/whoami": { status: 401, body: { error: "bad token" } },
      },
    });
  });
  afterAll(() => h.close());

  it("404 → exit 4 (not-found class) with envelope", async () => {
    const r = await h.runCli(["read", "missing.md", "--format", "json"]);
    // exitCodeFor in src/cli.ts maps the legacy `not_found` CliError to exit
    // code 4. If this fails, src/cli.ts:exitCodeFor regressed and started
    // returning 1 again — fix the regression rather than widening the test.
    expect(r.exit).toBe(4);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(typeof env.error.code).toBe("string");
    expect(env.error.message.length).toBeGreaterThan(0);
  });

  it("401 → exit 2 (auth class)", async () => {
    const r = await h.runCli(["whoami", "--format", "json"]);
    expect(r.exit).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
  });
});

describe("CLI contract: token-in-argv guard", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({});
  });
  afterAll(() => h.close());

  it("rejects --token=grove_live_... on non-init commands with exit 1", async () => {
    const r = await h.runCli(["search", "foo", "--token=grove_live_abcdefg12345", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("TOKEN_IN_ARGV");
    expect(env.error.suggestions.length).toBeGreaterThan(0);
  });

  it("allows --token on init (only permitted command)", async () => {
    // init will fail because server mock doesn't have /health, but it should NOT hit TOKEN_IN_ARGV.
    const r = await h.runCli(["init", "--server", h.baseUrl, "--token", "grove_live_abcdefg12345"]);
    // Either success (if /health is mocked elsewhere) or a non-TOKEN_IN_ARGV error.
    expect(r.stdout + r.stderr).not.toContain("TOKEN_IN_ARGV");
  });
});

describe("CLI contract: --format paths with -0", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/list": {
          status: 200,
          body: {
            entries: [
              { path: "Resources/People/Alice.md", type: "person" },
              { path: "Resources/People/Bob.md", type: "person" },
            ],
            count: 2,
          },
        },
      },
    });
  });
  afterAll(() => h.close());

  it("--format paths emits newline-separated paths", async () => {
    const r = await h.runCli(["list", "Resources/People/", "--format", "paths"]);
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual(["Resources/People/Alice.md", "Resources/People/Bob.md"]);
  });

  it("--format paths -0 emits NUL-separated paths", async () => {
    const r = await h.runCli(["list", "Resources/People/", "--format", "paths", "-0"]);
    expect(r.exit).toBe(0);
    const parts = r.stdout.split("\0").filter((l) => l.length > 0);
    expect(parts).toEqual(["Resources/People/Alice.md", "Resources/People/Bob.md"]);
    expect(r.stdout).toContain("\0");
  });
});

describe("CLI contract: insecure config refused", () => {
  it("refuses 0644 config with CONFIG_INSECURE", async () => {
    const h = await harness({});
    const { chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    chmodSync(join(h.configDir, "cli.json"), 0o644);

    const r = await h.runCli(["whoami", "--format", "json"]);
    expect(r.exit).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("CONFIG_INSECURE");
    expect(env.error.suggestions.some((s: string) => s.includes("chmod 600"))).toBe(true);

    await h.close();
  });
});
