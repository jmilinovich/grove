import { describe, it, expect } from "vitest";
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
    },
    {
      id: "vault_team",
      slug: "team",
      git_repo_path: "/root/vaults/team",
      server_port: 8191,
      discovery_port: 8092,
    },
  ];

  it("emits grove-proxy + qmd-server + one server/discovery pair per vault", () => {
    const out = generateEcosystemConfig(vaults);
    expect(out).toContain(`"name": "grove-proxy"`);
    expect(out).toContain(`"name": "qmd-server"`);
    expect(out).toContain(`"name": "grove-server-personal"`);
    expect(out).toContain(`"name": "grove-discovery-personal"`);
    expect(out).toContain(`"name": "grove-server-team"`);
    expect(out).toContain(`"name": "grove-discovery-team"`);
  });

  it("injects GROVE_VAULT_ID + port env per vault", () => {
    const out = generateEcosystemConfig(vaults);
    // personal server: vault_00000000 on 8190
    expect(out).toMatch(/"GROVE_VAULT_ID": "vault_00000000"[\s\S]*?"GROVE_SERVER_PORT": "8190"/);
    expect(out).toMatch(/"GROVE_VAULT_ID": "vault_team"[\s\S]*?"GROVE_SERVER_PORT": "8191"/);
  });

  it("is deterministic — two calls with same input produce identical output", () => {
    const a = generateEcosystemConfig(vaults);
    const b = generateEcosystemConfig(vaults);
    expect(a).toBe(b);
  });

  it("emits a valid CommonJS module that parses back as { apps: [...] }", () => {
    const out = generateEcosystemConfig(vaults);
    // Evaluate the generated module in a fresh context
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mod: { exports: unknown } = { exports: {} };
    new Function("module", out)(mod);
    const parsed = mod.exports as { apps: Array<{ name: string }> };
    expect(Array.isArray(parsed.apps)).toBe(true);
    // proxy + qmd + 2 per vault = 2 + 4 = 6
    expect(parsed.apps).toHaveLength(6);
    expect(parsed.apps.map((a) => a.name).sort()).toEqual([
      "grove-discovery-personal",
      "grove-discovery-team",
      "grove-proxy",
      "grove-server-personal",
      "grove-server-team",
      "qmd-server",
    ]);
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

  it("handles zero-vault input (no server/discovery entries)", () => {
    const out = generateEcosystemConfig([]);
    expect(out).toContain(`"name": "grove-proxy"`);
    expect(out).toContain(`"name": "qmd-server"`);
    expect(out).not.toContain(`"grove-server-`);
    expect(out).not.toContain(`"grove-discovery-`);
  });
});
