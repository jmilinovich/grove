// Phase C2 follow-up: per-vault provenance_required column on vaults
// table, ecosystem-gen reads it, CLI flips it.

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateEcosystemConfig, readProvisionedVaults, type VaultRow } from "../src/ecosystem-gen.js";

let tempDir: string;
let dbPath: string;
let db: InstanceType<typeof Database>;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-pv-prov-test-"));
  dbPath = join(tempDir, "grove.db");
  db = new Database(dbPath);
  // Minimal schema for what these tests need.
  db.exec(`
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      git_repo_path TEXT NOT NULL,
      server_port INTEGER,
      discovery_port INTEGER,
      provenance_required INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    "INSERT INTO vaults (id, slug, git_repo_path, server_port, discovery_port, provenance_required) VALUES (?,?,?,?,?,?)",
  ).run("vault_00000000", "personal", "/root/life", 8190, 8091, 1);
  db.prepare(
    "INSERT INTO vaults (id, slug, git_repo_path, server_port, discovery_port, provenance_required) VALUES (?,?,?,?,?,?)",
  ).run("vault_ryan", "ryan", "/root/vaults/ryan", 8191, 8092, 0);
  db.prepare(
    "INSERT INTO vaults (id, slug, git_repo_path, server_port, discovery_port, provenance_required) VALUES (?,?,?,?,?,?)",
  ).run("vault_sharpshoot", "sharpshoot", "/root/vaults/sharpshoot", 8192, 8093, 0);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("readProvisionedVaults", () => {
  it("loads provenance_required from the column", () => {
    const vaults = readProvisionedVaults(db);
    const personal = vaults.find((v) => v.slug === "personal")!;
    const ryan = vaults.find((v) => v.slug === "ryan")!;
    expect(personal.provenance_required).toBe(1);
    expect(ryan.provenance_required).toBe(0);
  });

  it("returns 0 for vaults that haven't been opted in", () => {
    const vaults = readProvisionedVaults(db);
    const ss = vaults.find((v) => v.slug === "sharpshoot")!;
    const ryan = vaults.find((v) => v.slug === "ryan")!;
    expect(ss.provenance_required).toBe(0);
    expect(ryan.provenance_required).toBe(0);
  });
});

describe("ecosystem generator + per-vault config", () => {
  it("emits proxy env vars for every vault with provenance_required=1", () => {
    db.prepare("UPDATE vaults SET provenance_required = 1 WHERE slug = 'sharpshoot'").run();
    const out = generateEcosystemConfig(readProvisionedVaults(db));
    expect(out).toMatch(/"name": "grove-proxy"[\s\S]*?"GROVE_REQUIRE_PROVENANCE_personal": "true"/);
    expect(out).toMatch(/"name": "grove-proxy"[\s\S]*?"GROVE_REQUIRE_PROVENANCE_sharpshoot": "true"/);
    // ryan stays off
    const proxyBlock = out.match(/"name": "grove-proxy"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(proxyBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE_ryan");
    // Restore
    db.prepare("UPDATE vaults SET provenance_required = 0 WHERE slug = 'sharpshoot'").run();
  });

  it("emits global flag on grove-server-<slug> when that vault is opted in", () => {
    const out = generateEcosystemConfig(readProvisionedVaults(db));
    expect(out).toMatch(/"name": "grove-server-personal"[\s\S]*?"GROVE_REQUIRE_PROVENANCE": "true"/);
    const ryanServer = out.match(/"name": "grove-server-ryan"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(ryanServer?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE");
  });

  it("flipping personal off → flag disappears from both proxy and server", () => {
    db.prepare("UPDATE vaults SET provenance_required = 0 WHERE slug = 'personal'").run();
    const out = generateEcosystemConfig(readProvisionedVaults(db));
    const proxyBlock = out.match(/"name": "grove-proxy"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(proxyBlock?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE_personal");
    const personalServer = out.match(/"name": "grove-server-personal"[\s\S]*?(?=\}\s*,?\s*\{)/);
    expect(personalServer?.[0] ?? "").not.toContain("GROVE_REQUIRE_PROVENANCE");
    // Restore
    db.prepare("UPDATE vaults SET provenance_required = 1 WHERE slug = 'personal'").run();
  });
});
