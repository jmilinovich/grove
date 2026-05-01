/**
 * Contract tests for the 2026-05-01 cross-vault key-mint regression
 * and its companion fix.
 *
 *   1. `grove keys create <name> --vault <slug>` MUST send
 *      `vault_slug` in the POST /keys body. Until this fix, the flag
 *      was parsed by the arg parser but silently dropped before the
 *      HTTP call — producing a key bound to the caller's default vault
 *      while the CLI banner showed the new key was minted "for vault
 *      ryan". The flag-and-drop made the bug invisible client-side and
 *      blew up server-side: an "ingest-bootstrap" key the operator
 *      thought was bound to a friend's vault was actually bound to
 *      their own, and the subsequent ingest leaked content into the
 *      operator's vault. See `feedback_cross_vault_key_mint_bug.md`.
 *
 *   2. `grove vault seed-key <slug>` is the platform-owner-only
 *      escape hatch for pre-loading content into a freshly-onboarded
 *      tenant's vault. The standard /keys endpoint gates on
 *      vault_members membership (resolveMintVaultId) — by design — so
 *      a Grove-wide owner cannot mint a key in a tenant's vault
 *      through that path. seed-key bypasses the gate via a separate
 *      endpoint that requires `users.role='owner'`. The CLI must
 *      POST to /v1/admin/vaults/seed-key with {slug, name}.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";

describe("grove keys create — --vault flag", () => {
  let h: Harness;
  let lastBody: string | null = null;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "POST /keys": (_req, body) => {
          lastBody = body;
          const parsed = JSON.parse(body);
          if (parsed.action !== "create") {
            return { status: 400, body: { error: "wrong action" } };
          }
          return {
            status: 200,
            body: {
              id: "key_test123",
              name: parsed.name,
              token: "grove_live_test_token",
            },
          };
        },
      },
    });
  });
  afterAll(() => h.close());

  it("plumbs --vault into vault_slug on the POST /keys body", async () => {
    const r = await h.runCli([
      "keys", "create", "ingest-bootstrap",
      "--vault", "ryan",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    expect(lastBody).not.toBeNull();
    const parsed = JSON.parse(lastBody!);
    expect(parsed.action).toBe("create");
    expect(parsed.name).toBe("ingest-bootstrap");
    // The bug: this assertion would fail before the fix because
    // vault_slug was never written into the body.
    expect(parsed.vault_slug).toBe("ryan");
  });

  it("plumbs --scopes into a string array", async () => {
    const r = await h.runCli([
      "keys", "create", "read-only-key",
      "--scopes", "read",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(lastBody!);
    expect(parsed.scopes).toEqual(["read"]);
  });

  it("omits vault_slug when --vault is not passed (default-vault path)", async () => {
    const r = await h.runCli([
      "keys", "create", "default-vault-key",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(lastBody!);
    expect(parsed.vault_slug).toBeUndefined();
  });
});

describe("grove vault seed-key", () => {
  let h: Harness;
  let lastBody: string | null = null;
  let lastPath: string | null = null;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "POST /v1/admin/vaults/seed-key": (req, body) => {
          lastBody = body;
          lastPath = req.url ?? null;
          const parsed = JSON.parse(body);
          if (typeof parsed.slug !== "string" || !parsed.slug) {
            return { status: 400, body: { error: "slug is required" } };
          }
          return {
            status: 200,
            body: {
              ok: true,
              key_id: "key_seed_abc",
              name: parsed.name,
              token: "grove_live_seed_token",
              vault_id: "vault_ryan",
              vault_slug: parsed.slug,
            },
          };
        },
      },
    });
  });
  afterAll(() => h.close());

  it("POSTs to /v1/admin/vaults/seed-key with slug and default name", async () => {
    const r = await h.runCli([
      "vault", "seed-key", "ryan",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    expect(lastPath).toBe("/v1/admin/vaults/seed-key");
    const parsed = JSON.parse(lastBody!);
    expect(parsed.slug).toBe("ryan");
    expect(parsed.name).toBe("seed-ryan");
    const env = JSON.parse(r.stdout);
    expect(env.data.token).toBe("grove_live_seed_token");
    expect(env.data.vault_slug).toBe("ryan");
  });

  it("uses --name when provided", async () => {
    const r = await h.runCli([
      "vault", "seed-key", "ryan",
      "--name", "ingest-bootstrap",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(lastBody!);
    expect(parsed.name).toBe("ingest-bootstrap");
  });

  it("requires the slug positional", async () => {
    const r = await h.runCli([
      "vault", "seed-key",
      "--format", "json",
    ]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("bad_request");
  });
});
