import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  generateEcosystemConfig,
  type VaultRow,
} from "../src/ecosystem-gen.js";

/**
 * P8-A4 ecosystem generator — deterministic CommonJS output that PM2
 * reads. We want a full regen (not append), so any two calls with the
 * same vault set must produce byte-identical output.
 */
describe("ecosystem-gen (P8-A4)", () => {
  const vaults: VaultRow[] = [
    {
      id: "vault_00000000",
      slug: "personal",
      git_repo_path: "/root/life",
      server_port: 8190,
      discovery_port: 8091,
      // Migration seeds personal=1 to preserve the prior hardcoded behavior
      provenance_required: 1,
    },
    {
      id: "vault_team",
      slug: "team",
      git_repo_path: "/root/vaults/team",
      server_port: 8191,
      discovery_port: 8092,
      provenance_required: 0,
    },
  ];

  it("emits grove-proxy + one server/discovery/scheduler triple per vault (no qmd-server)", () => {
    const out = generateEcosystemConfig(vaults);
    expect(out).toContain(`"name": "grove-proxy"`);
    // qmd-server is intentionally NOT emitted — qmd 2.1+ has no `serve`
    // subcommand and the legacy BM25 HTTP wrapper no longer exists.
    expect(out).not.toContain(`"name": "qmd-server"`);
    expect(out).toContain(`"name": "grove-server-personal"`);
    expect(out).toContain(`"name": "grove-discovery-personal"`);
    expect(out).toContain(`"name": "grove-scheduler-personal"`);
    expect(out).toContain(`"name": "grove-server-team"`);
    expect(out).toContain(`"name": "grove-discovery-team"`);
    expect(out).toContain(`"name": "grove-scheduler-team"`);
  });

  it("pins GROVE_VAULT_ID on each grove-scheduler-<slug> entry (P23-1)", () => {
    const out = generateEcosystemConfig(vaults);
    expect(out).toMatch(
      /"name": "grove-scheduler-personal"[\s\S]*?"GROVE_VAULT_ID": "vault_00000000"/,
    );
    expect(out).toMatch(
      /"name": "grove-scheduler-team"[\s\S]*?"GROVE_VAULT_ID": "vault_team"/,
    );
    expect(out).toMatch(
      /"name": "grove-scheduler-personal"[\s\S]*?scheduler-bin\.ts/,
    );
  });

  it("injects GROVE_VAULT_ID + port env per vault", () => {
    const out = generateEcosystemConfig(vaults);
    // personal server: vault_00000000 on 8190
    expect(out).toMatch(/"GROVE_VAULT_ID": "vault_00000000"[\s\S]*?"GROVE_SERVER_PORT": "8190"/);
    expect(out).toMatch(/"GROVE_VAULT_ID": "vault_team"[\s\S]*?"GROVE_SERVER_PORT": "8191"/);
  });

  it("injects GROVE_VAULT_SLUG per vault so URL builders stop defaulting to 'personal'", () => {
    // server.ts, rest.ts, and discovery.ts all derive the vaultSlug used
    // in noteUrl() from process.env.GROVE_VAULT_SLUG, falling back to
    // "personal". Without this env var on per-vault processes, every URL
    // that every non-personal vault mints points at /@<handle>/personal/,
    // which silently cross-links wrong (and 404s on grove-www when
    // followed).
    const out = generateEcosystemConfig(vaults);
    expect(out).toMatch(/"name": "grove-server-personal"[\s\S]*?"GROVE_VAULT_SLUG": "personal"/);
    expect(out).toMatch(/"name": "grove-server-team"[\s\S]*?"GROVE_VAULT_SLUG": "team"/);
    expect(out).toMatch(/"name": "grove-discovery-personal"[\s\S]*?"GROVE_VAULT_SLUG": "personal"/);
    expect(out).toMatch(/"name": "grove-discovery-team"[\s\S]*?"GROVE_VAULT_SLUG": "team"/);
  });

  it("sets GROVE_REQUIRE_PROVENANCE_personal=true on grove-proxy (multi-tenant REST path)", () => {
    // The proxy hosts REST writes for all tenants in one process. To
    // enforce strict mode for the personal vault but NOT for ryan/etc,
    // it gets a per-vault env var. The slug-aware
    // provenanceRequired(slug) helper in src/blame.ts checks
    // GROVE_REQUIRE_PROVENANCE_<slug> first, falling back to the
    // global flag.
    const out = generateEcosystemConfig(vaults);
    expect(out).toMatch(/"name": "grove-proxy"[\s\S]*?"GROVE_REQUIRE_PROVENANCE_personal": "true"/);
    // Negative: proxy must NOT have flags for non-personal tenants.
    const proxyBlock = out.match(/"name": "grove-proxy"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(proxyBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE_team");
  });

  it("flips strict mode based on vaults.provenance_required, not slug", () => {
    // Per-vault opt-in via the DB column. Take a fixture where `team`
    // has provenance_required=1 and `personal` has =0 — the inverted
    // case from the default — and confirm flag follows the column,
    // not the slug.
    const inverted: VaultRow[] = [
      { ...vaults[0], provenance_required: 0 },
      { ...vaults[1], provenance_required: 1 },
    ];
    const out = generateEcosystemConfig(inverted);
    expect(out).toMatch(/"name": "grove-server-team"[\s\S]*?"GROVE_REQUIRE_PROVENANCE": "true"/);
    const personalServer = out.match(/"name": "grove-server-personal"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(personalServer?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE");
    // Proxy mirrors via per-vault env vars
    expect(out).toMatch(/"name": "grove-proxy"[\s\S]*?"GROVE_REQUIRE_PROVENANCE_team": "true"/);
    const proxyBlock = out.match(/"name": "grove-proxy"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(proxyBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE_personal");
  });

  it("sets GROVE_REQUIRE_PROVENANCE=true on grove-server-personal only", () => {
    // Phase C2: only the `personal` vault has all callers migrated to
    // pass provenance on every write (this CLI's garden skills,
    // image-enrich, vault-life CLAUDE.md mandate). Other tenants stay
    // default-off until their callers migrate; flipping the flag for
    // them would break their writes.
    const out = generateEcosystemConfig(vaults);
    expect(out).toMatch(/"name": "grove-server-personal"[\s\S]*?"GROVE_REQUIRE_PROVENANCE": "true"/);
    // Negative: non-personal servers must NOT have the flag set.
    const teamServerBlock = out.match(/"name": "grove-server-team"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(teamServerBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE");
    // Negative: discovery worker (which bypasses handleWriteNote
    // entirely) must NOT have the flag — it's irrelevant there.
    const discoveryBlock = out.match(/"name": "grove-discovery-personal"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(discoveryBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE");
  });

  it("wraps tsx invocations in bash using the hermetic node_modules/.bin/tsx path", () => {
    // The deploy uses full `npm ci` (NOT --production) so tsx is always present
    // at node_modules/.bin/tsx. We invoke tsx via /bin/bash to keep `script`
    // constant across deploys (pm2 reload doesn't re-read a changed `script`
    // field per feedback_pm2_reload_script_path). Using `node_modules/.bin/tsx`
    // instead of `npx tsx` makes the deploy hermetic — no network fetch, no
    // silent version drift when the npx cache is cold.
    const out = generateEcosystemConfig(vaults);
    expect(out).toContain(`"script": "/bin/bash"`);
    expect(out).toContain("node_modules/.bin/tsx");
    expect(out).not.toContain("npx tsx");
  });

  it("spreads .env under each process's static env at PM2 load time", () => {
    // Write a temp .env + ecosystem and require() the generated module the
    // same way PM2 does. Secrets from .env must land in every process's
    // `env` (so VOYAGE_API_KEY, R2_*, etc. reach grove-server-*), and
    // static overrides (GROVE_VAULT_ID, GROVE_SERVER_PORT) must win over
    // anything the user accidentally sets in .env.
    const tmp = mkdtempSync(join(tmpdir(), "grove-eco-"));
    try {
      writeFileSync(join(tmp, ".env"), [
        "VOYAGE_API_KEY=vk_test_123",
        "R2_BUCKET_NAME=grove-images-test",
        // .env attempts to override a pinned var — must be ignored
        "GROVE_SERVER_PORT=9999",
      ].join("\n"));
      const out = generateEcosystemConfig(vaults, { repoRoot: tmp });
      writeFileSync(join(tmp, "ecosystem.config.cjs"), out);
      const req = createRequire(join(tmp, "ecosystem.config.cjs"));
      const mod = req(join(tmp, "ecosystem.config.cjs")) as {
        apps: Array<{ name: string; env: Record<string, string> }>;
      };
      const personal = mod.apps.find((a) => a.name === "grove-server-personal")!;
      expect(personal.env.VOYAGE_API_KEY).toBe("vk_test_123");
      expect(personal.env.R2_BUCKET_NAME).toBe("grove-images-test");
      // Static override wins over .env's 9999
      expect(personal.env.GROVE_SERVER_PORT).toBe("8190");
      expect(personal.env.GROVE_VAULT_ID).toBe("vault_00000000");
      // Same for proxy — .env secrets reach it too
      const proxy = mod.apps.find((a) => a.name === "grove-proxy")!;
      expect(proxy.env.VOYAGE_API_KEY).toBe("vk_test_123");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tolerates missing .env (test harness or first deploy)", () => {
    // Without a .env file, the generated config must still load — the
    // loader swallows ENOENT and passes an empty dotenv map through.
    const tmp = mkdtempSync(join(tmpdir(), "grove-eco-"));
    try {
      const out = generateEcosystemConfig(vaults, { repoRoot: tmp });
      writeFileSync(join(tmp, "ecosystem.config.cjs"), out);
      const req = createRequire(join(tmp, "ecosystem.config.cjs"));
      const mod = req(join(tmp, "ecosystem.config.cjs")) as {
        apps: Array<{ name: string; env: Record<string, string> }>;
      };
      const personal = mod.apps.find((a) => a.name === "grove-server-personal")!;
      // Static overrides still land even without .env
      expect(personal.env.GROVE_VAULT_ID).toBe("vault_00000000");
      expect(personal.env.NODE_ENV).toBe("production");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is deterministic — two calls with same input produce identical output", () => {
    const a = generateEcosystemConfig(vaults);
    const b = generateEcosystemConfig(vaults);
    expect(a).toBe(b);
  });

  it("emits a valid CommonJS module that parses back as { apps: [...] }", () => {
    // The generated config uses require("node:fs") to load .env at PM2
    // boot, so we need a real module scope (require + __dirname).
    const tmp = mkdtempSync(join(tmpdir(), "grove-eco-"));
    try {
      const out = generateEcosystemConfig(vaults, { repoRoot: tmp });
      writeFileSync(join(tmp, "ecosystem.config.cjs"), out);
      const req = createRequire(join(tmp, "ecosystem.config.cjs"));
      const parsed = req(join(tmp, "ecosystem.config.cjs")) as {
        apps: Array<{ name: string }>;
      };
      expect(Array.isArray(parsed.apps)).toBe(true);
      // proxy + 3 per vault = 1 + 6 = 7 (qmd-server intentionally absent;
      // grove-scheduler-<slug> joined the per-vault trio in P23-1)
      expect(parsed.apps).toHaveLength(7);
      expect(parsed.apps.map((a) => a.name).sort()).toEqual([
        "grove-discovery-personal",
        "grove-discovery-team",
        "grove-proxy",
        "grove-scheduler-personal",
        "grove-scheduler-team",
        "grove-server-personal",
        "grove-server-team",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("respects custom repoRoot / proxy / qmd ports", () => {
    const out = generateEcosystemConfig(vaults, {
      repoRoot: "/opt/grove",
      proxyPort: 9420,
      qmdPort: 9177,
    });
    expect(out).toContain("/opt/grove/src/proxy.ts");
    expect(out).toContain(`"GROVE_PORT": "9420"`);
    expect(out).toContain(`"QMD_PORT": "9177"`);
  });

  it("handles zero-vault input (proxy only, no server/discovery/scheduler entries)", () => {
    const out = generateEcosystemConfig([]);
    expect(out).toContain(`"name": "grove-proxy"`);
    expect(out).not.toContain(`"name": "qmd-server"`);
    expect(out).not.toContain(`"grove-server-`);
    expect(out).not.toContain(`"grove-discovery-`);
    expect(out).not.toContain(`"grove-scheduler-`);
  });
});
