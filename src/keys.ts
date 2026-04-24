#!/usr/bin/env tsx
/**
 * Grove API key management.
 *
 * Usage:
 *   grove keys create --name "claude-desktop"
 *   grove keys list
 *   grove keys revoke <id>
 */

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";

const PREFIX = "grove_live_";

export interface StoredKey {
  id: string;
  user_id: string;
  name: string;
  hashed_token: string;
  scopes: string;         // comma-separated in DB
  vault_id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function loadKeys(userId?: string): StoredKey[] {
  const db = getDb();
  if (userId) {
    return db.prepare("SELECT * FROM api_keys WHERE user_id = ?").all(userId) as StoredKey[];
  }
  return db.prepare("SELECT * FROM api_keys").all() as StoredKey[];
}

function generateId(): string {
  return "key_" + randomBytes(4).toString("hex");
}

function create(name: string, scopes = "read,write", vaultId = "life", ttlDays?: number) {
  const raw = randomBytes(32).toString("hex");
  const token = PREFIX + raw;
  const db = getDb();

  // Use admin user as default owner
  const adminUser = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
  const userId = adminUser?.id ?? "user_00000000";

  const id = generateId();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    userId,
    vaultId,
    name,
    hashToken(token),
    scopes,
    new Date().toISOString(),
    null,
    ttlDays ? new Date(Date.now() + ttlDays * 86400_000).toISOString() : null,
  );

  console.log(`\nKey created: ${id}`);
  console.log(`Name:        ${name}`);
  console.log(`Scopes:      ${scopes}`);
  console.log(`Vault:       ${vaultId}`);
  console.log(`\nToken (shown once, save it now):\n`);
  console.log(`  ${token}\n`);
}

function list() {
  const keys = loadKeys();
  if (keys.length === 0) {
    console.log("No keys. Create one with: grove keys create --name <name>");
    return;
  }
  console.log("\nID            Name                Scopes          Vault   Created");
  console.log("─".repeat(80));
  for (const k of keys) {
    console.log(
      `${k.id.padEnd(14)}${k.name.padEnd(20)}${k.scopes.padEnd(16)}${k.vault_id.padEnd(8)}${k.created_at.slice(0, 10)}`
    );
  }
  console.log();
}

function revoke(id: string) {
  const db = getDb();
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as StoredKey | undefined;
  if (!key) {
    console.error(`Key not found: ${id}`);
    process.exit(1);
  }
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  console.log(`Revoked key: ${key.id} (${key.name})`);
}

// -- CLI --
// Guarded so this block only runs when keys.ts is the entry point (i.e.
// `npm run keys ...`). Without the guard, importing `hashToken` or
// `createKey` from this module printed the usage line into the
// importer's stdout at load time — polluting proxy startup logs and the
// JSON output of any CLI command that transitively imported it.
import { pathToFileURL } from "node:url";
const isEntryPoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "create") {
    const nameIdx = args.indexOf("--name");
    const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
    if (!name) {
      console.error("Usage: grove keys create --name <name> [--scopes read,write] [--vault life]");
      process.exit(1);
    }
    const scopesIdx = args.indexOf("--scopes");
    const scopes = scopesIdx >= 0 ? args[scopesIdx + 1] : "read,write";
    const vaultIdx = args.indexOf("--vault");
    const vault = vaultIdx >= 0 ? args[vaultIdx + 1] : "life";
    create(name, scopes, vault);
  } else if (command === "list") {
    list();
  } else if (command === "revoke") {
    const id = args[1];
    if (!id) {
      console.error("Usage: grove keys revoke <key-id>");
      process.exit(1);
    }
    revoke(id);
  } else {
    console.log("Usage: grove keys <create|list|revoke>");
  }
}

// -- Programmatic API (used by proxy /keys endpoint) --
export function createKey(
  name: string,
  scopes: string[] = ["read", "write"],
  vaultId = "life",
  ttlDays?: number,
  userId?: string,
  sessionId?: string | null,
) {
  const raw = randomBytes(32).toString("hex");
  const token = PREFIX + raw;
  const db = getDb();

  const resolvedUserId = userId ?? (() => {
    const adminUser = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    return adminUser?.id ?? "user_00000000";
  })();

  const id = generateId();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at, last_used_at, expires_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    resolvedUserId,
    vaultId,
    name,
    hashToken(token),
    scopes.join(","),
    new Date().toISOString(),
    null,
    ttlDays ? new Date(Date.now() + ttlDays * 86400_000).toISOString() : null,
    sessionId ?? null,
  );

  return { id, name, token, userId: resolvedUserId };
}

export function revokeKey(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Check if a key has expired */
export function isExpired(key: StoredKey): boolean {
  if (!key.expires_at) return false;
  return new Date(key.expires_at).getTime() < Date.now();
}

/** Update last_used_at timestamp for a key */
export function updateLastUsed(id: string): void {
  const db = getDb();
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}
