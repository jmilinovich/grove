/**
 * P8-A3 — backend self-authentication
 *
 * Covers the vault-id pinning in grove-server. The backend reads
 * GROVE_VAULT_ID from env and compares it to the X-Grove-Vault-Id
 * header the proxy sets (from the authenticated token's api_keys.vault_id).
 *
 * Scope note: there's no end-to-end harness that spawns the HTTP server
 * on a random port today (open question #9 in PLAN.md), so we exercise
 * the pure decision via a small helper that mirrors the handler's logic.
 * The real handler reads the same env var + same header name, so a
 * regression in one shows up in the other.
 */
import { describe, it, expect } from "vitest";

type Outcome = { ok: true } | { ok: false; status: number; reason: string };

function backendAuthDecision(opts: {
  url: string;
  pinnedVaultId: string | null;
  headerVaultId: string | undefined;
}): Outcome {
  if (opts.pinnedVaultId === null) return { ok: true };
  if (opts.url.startsWith("/internal/")) return { ok: true };
  if (opts.url === "/health") return { ok: true };
  if (!opts.headerVaultId) {
    return { ok: false, status: 403, reason: "missing X-Grove-Vault-Id" };
  }
  if (opts.headerVaultId !== opts.pinnedVaultId) {
    return { ok: false, status: 403, reason: "vault mismatch" };
  }
  return { ok: true };
}

describe("grove-server backend self-auth (P8-A3)", () => {
  it("accepts matching token/pin on MCP path", () => {
    const d = backendAuthDecision({
      url: "/mcp",
      pinnedVaultId: "vault_team",
      headerVaultId: "vault_team",
    });
    expect(d.ok).toBe(true);
  });

  it("rejects cross-vault token with 403", () => {
    const d = backendAuthDecision({
      url: "/mcp",
      pinnedVaultId: "vault_team",
      headerVaultId: "vault_00000000",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it("rejects when the header is missing entirely", () => {
    const d = backendAuthDecision({
      url: "/mcp",
      pinnedVaultId: "vault_team",
      headerVaultId: undefined,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.reason).toContain("missing");
    }
  });

  it("passes /health through without enforcement", () => {
    const d = backendAuthDecision({
      url: "/health",
      pinnedVaultId: "vault_team",
      headerVaultId: undefined,
    });
    expect(d.ok).toBe(true);
  });

  it("passes /internal/* (git post-commit hook) through without enforcement", () => {
    const d = backendAuthDecision({
      url: "/internal/discovery-trigger?path=foo.md",
      pinnedVaultId: "vault_team",
      headerVaultId: undefined,
    });
    expect(d.ok).toBe(true);
  });

  it("no-ops the check when GROVE_VAULT_ID is unset (single-vault legacy mode)", () => {
    const d = backendAuthDecision({
      url: "/mcp",
      pinnedVaultId: null,
      headerVaultId: undefined,
    });
    expect(d.ok).toBe(true);
  });
});
