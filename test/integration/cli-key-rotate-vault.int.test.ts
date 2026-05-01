/**
 * Regression test: `grove key rotate` must preserve the old key's vault binding.
 *
 * Before the fix, `cmdKeyRotate` called keysPost with `{ action: "create", name }` and
 * NO vault field. The server then called `resolveMintVaultId` with no explicit vault in
 * the body, falling back to the caller's earliest vault_members row — exactly the
 * 2026-05-01 flag-drop root cause, just via rotate instead of create. For a
 * platform-owner rotating a key that was bound to a tenant's vault (e.g. a seed key
 * they forgot to revoke), the rotated key silently landed in the operator's default
 * vault while appearing to belong to the tenant.
 *
 * The fix: step 1 fetches the old key's vault_id from the list response; step 2
 * passes `{ vault: oldKey.vault_id }` so resolveMintVaultId uses that exact id
 * (membership-checked) rather than defaulting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";

describe("grove key rotate — vault binding preservation", () => {
  let h: Harness;
  let capturedCreateBody: string | null = null;

  beforeAll(async () => {
    h = await harness({
      routes: {
        // List returns a key bound to a non-default vault (vault_ryan).
        "POST /keys": (_req, body) => {
          const parsed = JSON.parse(body);

          if (parsed.action === "list") {
            return {
              status: 200,
              body: {
                keys: [
                  {
                    id: "key_old123",
                    user_id: "user_admin",
                    name: "ingest-bootstrap",
                    scopes: "read,write",
                    vault_id: "vault_ryan",
                    created_at: "2026-05-01T00:00:00.000Z",
                    last_used_at: null,
                    expires_at: null,
                  },
                ],
              },
            };
          }

          if (parsed.action === "create") {
            capturedCreateBody = body;
            return {
              status: 200,
              body: {
                id: "key_new456",
                name: parsed.name,
                token: "grove_live_new_token",
              },
            };
          }

          if (parsed.action === "revoke") {
            return { status: 200, body: { revoked: parsed.id } };
          }

          return { status: 400, body: { error: "unknown action" } };
        },
      },
    });
  });

  afterAll(() => h.close());

  it("passes the old key's vault_id in the create call", async () => {
    const r = await h.runCli([
      "key", "rotate", "key_old123",
      "--name", "ingest-bootstrap-rotated",
      "--format", "json",
    ]);

    expect(r.exit).toBe(0);
    expect(capturedCreateBody).not.toBeNull();

    const createBody = JSON.parse(capturedCreateBody!);
    expect(createBody.action).toBe("create");
    // THE REGRESSION: before the fix this field was absent, causing the server
    // to bind the new key to the caller's default vault instead of vault_ryan.
    expect(createBody.vault).toBe("vault_ryan");
  });

  it("does NOT pass a vault field when old key has no vault_id (edge case)", async () => {
    // Reset captured body
    capturedCreateBody = null;

    // Override the list route to return a key with empty vault_id
    const h2 = await harness({
      routes: {
        "POST /keys": (_req, body) => {
          const parsed = JSON.parse(body);
          if (parsed.action === "list") {
            return {
              status: 200,
              body: {
                keys: [
                  {
                    id: "key_noVault",
                    user_id: "user_admin",
                    name: "legacy-key",
                    scopes: "read,write",
                    vault_id: "",
                    created_at: "2026-05-01T00:00:00.000Z",
                    last_used_at: null,
                    expires_at: null,
                  },
                ],
              },
            };
          }
          if (parsed.action === "create") {
            capturedCreateBody = body;
            return {
              status: 200,
              body: { id: "key_new789", name: parsed.name, token: "grove_live_tok" },
            };
          }
          if (parsed.action === "revoke") {
            return { status: 200, body: { revoked: parsed.id } };
          }
          return { status: 400, body: { error: "unknown action" } };
        },
      },
    });

    try {
      const r = await h2.runCli([
        "key", "rotate", "key_noVault",
        "--format", "json",
      ]);
      expect(r.exit).toBe(0);
      expect(capturedCreateBody).not.toBeNull();
      const createBody = JSON.parse(capturedCreateBody!);
      // Empty vault_id — should not pass vault at all (let server pick default)
      expect(createBody.vault).toBeUndefined();
    } finally {
      await h2.close();
    }
  });
});
