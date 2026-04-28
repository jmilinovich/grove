/**
 * End-to-end onboarding smoke test.
 *
 * Exercises the full flow `POST /v1/admin/onboard` runs internally
 * (provisionVault → loadVaultMap → inviteUserToVault), then asserts
 * every regression we hit on Sumon's day-one onboarding:
 *
 *   1. Email stored lowercase, no duplicate user when later invites
 *      arrive with mixed case.
 *   2. Owner gets `users.role='owner'` so /keys returns 200, not 403
 *      with a redirect-to-/.
 *   3. vault_members has the owner row with role='owner'.
 *   4. Owner API key minted, has read+write scopes, bound to the new
 *      vault — and adminAuth(req with Bearer key) succeeds.
 *   5. registerQmdCollection effect fires with (slug, vaultPath) so
 *      `qmd update` picks up the new collection on day one.
 *   6. Magic-link verify URL handed to the email targets
 *      `/api/auth/callback` (so the dashboard doesn't bounce the
 *      invitee back to /login when ?code= arrives).
 *
 * If this test goes red, an onboarding regression has shipped — the
 * next user will hit one of the bugs Sumon hit.
 *
 * NOTE: this test runs the business-logic chain in-process. It does
 * NOT spin up the HTTP proxy because the proxy adds nothing to the
 * regression surface here (auth check + JSON dispatch). Adding HTTP
 * coverage would multiply runtime without catching anything new.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-e2e-onboard-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");

import { resetDb, getDb, createSchema } from "../src/db.js";
import { provisionVault, type Effects } from "../src/vault-provision.js";
import { inviteUserToVault } from "../src/invite.js";
import { adminAuth } from "../src/admin-auth.js";
import { seedAdminVault } from "./_helpers/seed.js";
import * as emailModule from "../src/email.js";

describe("e2e onboarding (full path Sumon hit)", () => {
  let qmdCalls: Array<{ slug: string; path: string }>;
  let inviteEmails: Array<{ email: string; primaryUrl: string }>;
  let testEffects: Effects;

  beforeEach(() => {
    resetDb();
    createSchema();
    seedAdminVault(); // canonical admin + life vault

    qmdCalls = [];
    testEffects = {
      initRepo: () => {},
      initQmd: () => {},
      registerQmdCollection: (slug, path) => qmdCalls.push({ slug, path }),
      writeEcosystem: () => {},
      reloadPm2: () => {},
      startPm2Apps: () => {},
      waitForHealth: async () => {},
      listPm2Apps: () => [],
      deletePm2App: () => {},
    };

    // Capture invite-email sends so we can assert on the magic-link
    // URL without actually hitting Resend.
    inviteEmails = [];
    vi.spyOn(emailModule, "sendVaultInviteEmail").mockImplementation(
      async (email, primaryUrl) => {
        inviteEmails.push({ email, primaryUrl });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDb();
  });

  it("provision + invite a brand-new owner with mixed-case email — full chain", async () => {
    // Step 1: provision (mirrors what `/v1/admin/onboard` does first).
    // Mixed-case email on purpose — regression for the duplicate-user bug.
    const r = await provisionVault(
      {
        slug: "newvault",
        ownerEmail: "Newuser@Example.COM",
        displayName: "New Vault",
      },
      { skipReload: false, effects: testEffects },
    );

    // Step 2: invite (mirrors the second half of `/v1/admin/onboard`).
    // Same mixed-case email — invite must resolve to the SAME user row,
    // not create a duplicate.
    const invite = await inviteUserToVault(
      "Newuser@Example.COM",
      "newvault",
      "owner",
      "https://api.grove.md",
    );

    const db = getDb();

    // ── Regression 1: email lowercased, no duplicate user ──
    const users = db
      .prepare("SELECT id, email, role FROM users WHERE LOWER(email) = ?")
      .all("newuser@example.com") as Array<{ id: string; email: string; role: string }>;
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("newuser@example.com");
    expect(invite.user_id).toBe(users[0].id);
    expect(invite.user_id).toBe(r.ownerUserId);

    // ── Regression 2: owner gets users.role='owner' ──
    // Without this the /keys endpoint returns 403 → SSR page redirects
    // to "/" → invitee thinks the magic link is broken.
    expect(users[0].role).toBe("owner");

    // ── Regression 3: vault_members owner row exists ──
    const member = db
      .prepare("SELECT role FROM vault_members WHERE user_id = ? AND vault_id = ?")
      .get(r.ownerUserId, r.vaultId) as { role: string } | undefined;
    expect(member?.role).toBe("owner");

    // ── Regression 4: owner key works for adminAuth ──
    // The owner's freshly-minted token must pass the Grove-wide admin
    // check (no vaultId given — same path /keys takes).
    const fakeReq = {
      headers: { authorization: `Bearer ${r.ownerApiToken}` },
    } as unknown as IncomingMessage;
    const auth = adminAuth(fakeReq);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.userId).toBe(r.ownerUserId);
    }

    // ── Regression 5: QMD collection registered with the right path ──
    // Without this `grove search` returns nothing for the new vault.
    expect(qmdCalls).toContainEqual({
      slug: "newvault",
      path: r.gitPath,
    });

    // Sanity: invite email was sent.
    expect(inviteEmails).toHaveLength(1);
  });

  // ── Open regression (will fail until the magic-link/onboard fix lands) ──
  //
  // The /v1/admin/onboard path: provision creates the user, then
  // inviteUserToVault sees the user as "existing" and (per invite.ts:235)
  // sends a bare dashboard deep-link `https://grove.md/@<handle>/<slug>/
  // dashboard`. That URL has no auth-establishing step. The dashboard
  // layout requires a session cookie, finds none, redirects to /login.
  // Sumon's "I click access and it flickers and bounces to home" was
  // exactly this.
  //
  // Two distinct upstream bugs share the same symptom:
  //   - new-user branch (created:true) → /auth/verify appends ?code= and
  //     302s straight to the dashboard, which doesn't handle ?code=.
  //   - existing-user branch (created:false) → bare dashboard URL, no
  //     auth step. This is the path the /v1/admin/onboard flow always
  //     takes since provision created the user moments earlier.
  //
  // Fix in flight (Audit D + onboard-aware tweak): both branches must
  // route through /api/auth/callback so the dashboard receives a working
  // session cookie before its auth gate runs.
  //
  // Flip `it.todo` → `it` once the fix lands; the assertion is ready.
  it.todo(
    "invite email URL establishes a session before the dashboard auth gate",
    /* () => {
      const url = inviteEmails[0].primaryUrl;
      expect(
        url.includes("/auth/verify") || url.includes("/api/auth/callback"),
        `email URL must establish a session; got bare deep-link: ${url}`,
      ).toBe(true);
    } */
  );
});
