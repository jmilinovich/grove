import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import {
  bumpRequest,
  bumpWrite,
  bumpSearch,
  bumpEmbedTokens,
  flushCounters,
  resetCounters,
  snapshot,
  startFlushTimer,
  stopFlushTimer,
} from "../src/vault-usage.js";

describe("vault-usage counters (P8-A6)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-usage-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    resetCounters();
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_admin", "admin", "admin@grove.local", "owner");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_00000000", "user_admin", "personal", "Personal", "/root/life", 8190, 8091);
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_team", "user_admin", "team", "Team", "/root/vaults/team", 8191, 8092);
  });

  afterEach(() => {
    stopFlushTimer();
    resetCounters();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accumulates per-vault counts in memory", () => {
    bumpRequest("vault_00000000");
    bumpRequest("vault_00000000");
    bumpRequest("vault_team");
    bumpWrite("vault_00000000");
    bumpSearch("vault_team");

    const snap = snapshot();
    const personalKey = Object.keys(snap).find((k) => k.startsWith("vault_00000000\0"))!;
    const teamKey = Object.keys(snap).find((k) => k.startsWith("vault_team\0"))!;
    expect(snap[personalKey].requests).toBe(2);
    expect(snap[personalKey].writes).toBe(1);
    expect(snap[teamKey].requests).toBe(1);
    expect(snap[teamKey].search_queries).toBe(1);
  });

  it("ignores empty vault_id", () => {
    bumpRequest("");
    expect(Object.keys(snapshot())).toHaveLength(0);
  });

  it("flush upserts into vault_usage_daily and clears in-memory state", () => {
    bumpRequest("vault_00000000");
    bumpWrite("vault_00000000");
    bumpEmbedTokens("vault_team", 4096);

    flushCounters();
    expect(Object.keys(snapshot())).toHaveLength(0);

    const db = getDb();
    const rows = db
      .prepare("SELECT vault_id, requests, writes, embed_tokens FROM vault_usage_daily ORDER BY vault_id")
      .all() as Array<{ vault_id: string; requests: number; writes: number; embed_tokens: number }>;
    expect(rows).toHaveLength(2);
    const personal = rows.find((r) => r.vault_id === "vault_00000000")!;
    const team = rows.find((r) => r.vault_id === "vault_team")!;
    expect(personal.requests).toBe(1);
    expect(personal.writes).toBe(1);
    expect(team.embed_tokens).toBe(4096);
  });

  it("flush accumulates across multiple flush cycles (upsert addition)", () => {
    bumpRequest("vault_00000000");
    flushCounters();
    bumpRequest("vault_00000000");
    bumpRequest("vault_00000000");
    flushCounters();

    const db = getDb();
    const row = db
      .prepare("SELECT requests FROM vault_usage_daily WHERE vault_id = ?")
      .get("vault_00000000") as { requests: number };
    expect(row.requests).toBe(3);
  });

  it("flush is a no-op when nothing is pending", () => {
    flushCounters();
    const db = getDb();
    const n = (db.prepare("SELECT COUNT(*) as c FROM vault_usage_daily").get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it("startFlushTimer is idempotent", () => {
    startFlushTimer(10_000);
    startFlushTimer(10_000);
    stopFlushTimer();
  });
});
