import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set GROVE_DB_PATH before importing db/crypto so the singleton uses our temp db.
const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-crypto-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  deriveKey,
  generateVaultKey,
  encryptVaultKey,
  decryptVaultKey,
  encryptContent,
  decryptContent,
  encryptIndex,
  decryptIndexToMemory,
  encryptVault,
  unlockVault,
  lockVault,
  changePassphrase,
  getVaultStatus,
  isVaultEncrypted,
  isVaultLocked,
  getCachedVaultKey,
  cacheVaultKey,
  purgeAllVaultKeys,
  setKeyCacheTtl,
} from "../src/crypto.js";

function seed(): void {
  resetDb();
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH, { force: true });
  createSchema();
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
    .run("user_1", "alice", "alice@example.com", "owner");
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)")
    .run("vault_1", "user_1", "life", "Life", "/tmp/vault");
}

beforeEach(() => {
  purgeAllVaultKeys();
  seed();
});

afterAll(() => {
  resetDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("primitives", () => {
  it("encryptContent / decryptContent roundtrips", () => {
    const key = generateVaultKey();
    const plaintext = "hello, encrypted world 🌲 with some 特殊字符";
    const ct = encryptContent(plaintext, key);
    expect(typeof ct).toBe("string");
    expect(ct).toContain("-----GROVE-ENCRYPTED-v1-----");
    expect(ct).not.toContain("hello");
    expect(decryptContent(ct, key)).toBe(plaintext);
  });

  it("decryptContent with wrong key throws a clear error (not garbage)", () => {
    const key1 = generateVaultKey();
    const key2 = generateVaultKey();
    const ct = encryptContent("secret", key1);
    expect(() => decryptContent(ct, key2)).toThrowError(/[Dd]ecrypt/);
  });

  it("each encryption produces a distinct ciphertext (fresh IV)", () => {
    const key = generateVaultKey();
    const a = encryptContent("hello", key);
    const b = encryptContent("hello", key);
    expect(a).not.toBe(b);
    expect(decryptContent(a, key)).toBe("hello");
    expect(decryptContent(b, key)).toBe("hello");
  });

  it("tampering with ciphertext fails decryption (GCM auth tag)", () => {
    const key = generateVaultKey();
    const ct = encryptContent("important", key);
    // Flip a character in the base64 body
    const lines = ct.split("\n");
    const body = lines[1];
    const tampered = body.slice(0, -2) + "XX";
    const tamperedCt = lines[0] + "\n" + tampered + "\n";
    expect(() => decryptContent(tamperedCt, key)).toThrow();
  });

  it("deriveKey is deterministic for the same salt + passphrase", () => {
    const salt = Buffer.alloc(16, 7);
    const a = deriveKey("correct horse battery staple", salt);
    const b = deriveKey("correct horse battery staple", salt);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it("key derivation takes >100ms (cost parameters resist brute force)", () => {
    const salt = Buffer.alloc(16, 1);
    const start = Date.now();
    deriveKey("slowpoke", salt);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(100);
  });

  it("encryptVaultKey / decryptVaultKey roundtrips", () => {
    const vaultKey = generateVaultKey();
    const { encrypted, salt } = encryptVaultKey(vaultKey, "p@ssword!");
    expect(decryptVaultKey(encrypted, salt, "p@ssword!").equals(vaultKey)).toBe(true);
  });

  it("decryptVaultKey with wrong passphrase throws invalid_passphrase", () => {
    const vaultKey = generateVaultKey();
    const { encrypted, salt } = encryptVaultKey(vaultKey, "right");
    expect(() => decryptVaultKey(encrypted, salt, "wrong")).toThrowError("invalid_passphrase");
  });
});

describe("index encryption", () => {
  it("encryptIndex / decryptIndexToMemory roundtrips", () => {
    const indexPath = join(TEST_DIR, "index.bin");
    const plaintext = Buffer.from("SQLITE_INDEX_CONTENT\x00binary\xffdata", "binary");
    writeFileSync(indexPath, plaintext);
    const key = generateVaultKey();

    encryptIndex(indexPath, key);
    const onDisk = readFileSync(indexPath);
    expect(onDisk.equals(plaintext)).toBe(false);

    const roundtripped = decryptIndexToMemory(indexPath, key);
    expect(roundtripped.equals(plaintext)).toBe(true);
  });

  it("decryptIndexToMemory with wrong key throws", () => {
    const indexPath = join(TEST_DIR, "index2.bin");
    writeFileSync(indexPath, Buffer.from("some bytes"));
    encryptIndex(indexPath, generateVaultKey());
    expect(() => decryptIndexToMemory(indexPath, generateVaultKey())).toThrowError("decryption_failed");
  });
});

describe("vault lifecycle", () => {
  const VAULT = "vault_1";

  it("encryptVault stores an encrypted key and leaves the vault unlocked", () => {
    expect(isVaultEncrypted(VAULT)).toBe(false);
    encryptVault(VAULT, "hunter2hunter2");
    expect(isVaultEncrypted(VAULT)).toBe(true);
    expect(isVaultLocked(VAULT)).toBe(false);

    const status = getVaultStatus(VAULT);
    expect(status.encrypted).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.last_unlocked_at).not.toBeNull();
  });

  it("encryptVault refuses to re-encrypt", () => {
    encryptVault(VAULT, "pw-pw-pw-1");
    expect(() => encryptVault(VAULT, "different")).toThrowError("already_encrypted");
  });

  it("lock purges the in-memory key; unlock with correct passphrase restores it", () => {
    encryptVault(VAULT, "pw-pw-pw-1");
    const keyBefore = getCachedVaultKey(VAULT);
    expect(keyBefore).not.toBeNull();

    expect(lockVault(VAULT)).toBe(true);
    expect(isVaultLocked(VAULT)).toBe(true);
    expect(getCachedVaultKey(VAULT)).toBeNull();

    expect(unlockVault(VAULT, "pw-pw-pw-1")).toBe(true);
    expect(isVaultLocked(VAULT)).toBe(false);

    const keyAfter = getCachedVaultKey(VAULT);
    expect(keyAfter).not.toBeNull();
    expect(keyAfter!.equals(keyBefore!)).toBe(true);
  });

  it("unlock with wrong passphrase returns false and leaves vault locked", () => {
    encryptVault(VAULT, "pw-pw-pw-1");
    lockVault(VAULT);
    expect(unlockVault(VAULT, "nope")).toBe(false);
    expect(isVaultLocked(VAULT)).toBe(true);
  });

  it("unlock on a never-encrypted vault throws not_encrypted", () => {
    expect(() => unlockVault(VAULT, "anything")).toThrowError("not_encrypted");
  });

  it("simulated server restart requires re-unlock (cache cleared)", () => {
    encryptVault(VAULT, "pw-pw-pw-1");
    purgeAllVaultKeys(); // simulate process restart
    expect(isVaultLocked(VAULT)).toBe(true);
    expect(unlockVault(VAULT, "pw-pw-pw-1")).toBe(true);
  });

  it("cache TTL expiry locks the vault automatically", () => {
    encryptVault(VAULT, "pw-pw-pw-1");
    setKeyCacheTtl(-1); // force expiry
    // Re-cache the key under the expired TTL
    const rec = getDb().prepare("SELECT encrypted_key, key_salt FROM vault_keys WHERE vault_id = ?").get(VAULT) as { encrypted_key: Buffer; key_salt: Buffer };
    cacheVaultKey(VAULT, decryptVaultKey(rec.encrypted_key, rec.key_salt, "pw-pw-pw-1"));
    expect(getCachedVaultKey(VAULT)).toBeNull();
    expect(isVaultLocked(VAULT)).toBe(true);
    setKeyCacheTtl(24 * 60 * 60 * 1000); // restore default
  });

  it("changePassphrase rewraps the same vault key under the new passphrase", () => {
    encryptVault(VAULT, "old-pass-1");
    const keyBefore = getCachedVaultKey(VAULT);

    expect(changePassphrase(VAULT, "old-pass-1", "new-pass-2")).toBe(true);

    // Old passphrase no longer works
    lockVault(VAULT);
    expect(unlockVault(VAULT, "old-pass-1")).toBe(false);

    // New passphrase unlocks to the same vault key (data stays decryptable)
    expect(unlockVault(VAULT, "new-pass-2")).toBe(true);
    const keyAfter = getCachedVaultKey(VAULT);
    expect(keyAfter!.equals(keyBefore!)).toBe(true);
  });

  it("changePassphrase with wrong old passphrase returns false", () => {
    encryptVault(VAULT, "old-pass-1");
    expect(changePassphrase(VAULT, "wrong", "new")).toBe(false);
  });
});
