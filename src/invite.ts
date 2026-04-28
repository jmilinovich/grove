/**
 * Invite flow for Grove.
 *
 * Invites a user to access a trail: creates user if needed, provisions
 * a trail-scoped API key, creates the trail grant, and sends a welcome email.
 */

import { randomBytes, createHash } from "node:crypto";
import { getDb } from "./db.js";
import { createKey } from "./keys.js";
import { getUserByEmail, createUser, deriveHandleFromEmail } from "./users.js";
import { sendMagicLinkEmail, sendVaultInviteEmail } from "./email.js";

export interface InviteResult {
  user_id: string;
  email: string;
  trail_id: string;
  key_id: string;
  created: boolean;   // true if new user was created
}

export type VaultRole = "owner" | "member" | "viewer";

export interface VaultInviteResult {
  user_id: string;
  email: string;
  vault_id: string;
  vault_slug: string;
  key_id: string;
  role: VaultRole;
  created: boolean;   // true if new user was created
  newMembership: boolean;   // true if vault_members row was inserted this call
}


/**
 * Invite a user to a trail.
 *
 * Idempotent: re-inviting the same email for the same trail returns the
 * existing user and grant without creating duplicates.
 */
export async function inviteUser(
  email: string,
  trailId: string,
  _role: string,
  baseUrl: string,
): Promise<InviteResult> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Validate trail exists and resolve its owning resident (vault owner).
  //    The handle embeds in the callback URL and invite email so the invitee
  //    can see whose trail they've been added to before signing in.
  //    trails.vault_id is historically set to either the vault id or its
  //    slug — match on both so legacy rows still resolve.
  const trail = db.prepare(
    `SELECT t.id AS id, t.name AS name, t.vault_id AS trail_vault_id,
            v.id AS resolved_vault_id,
            u.username AS owner_handle, u.display_name AS owner_display_name
       FROM trails t
       LEFT JOIN vaults v ON v.id = t.vault_id OR v.slug = t.vault_id
       LEFT JOIN users u ON u.id = v.owner_id
       WHERE t.id = ?`,
  ).get(trailId) as {
    id: string;
    name: string;
    trail_vault_id: string | null;
    resolved_vault_id: string | null;
    owner_handle: string | null;
    owner_display_name: string | null;
  } | undefined;
  if (!trail) {
    throw new Error(`Trail not found: ${trailId}`);
  }
  const ownerHandle = trail.owner_handle ?? "unknown";
  const ownerDisplayName = trail.owner_display_name ?? `@${ownerHandle}`;
  // Bind the trail-scoped key to the trail's actual vault. Prefer the
  // resolved vault id from the JOIN (handles legacy rows where
  // trails.vault_id is the slug); fall back to the raw column. Hardcoding
  // "life" here meant any trail in a non-life vault minted keys bound to
  // the wrong vault, which then failed auth on every request.
  const trailVaultId = trail.resolved_vault_id ?? trail.trail_vault_id;
  if (!trailVaultId) {
    throw new Error(`Trail ${trailId} has no resolvable vault_id`);
  }

  // 2. Find or create user
  let user = getUserByEmail(normalizedEmail);
  const created = !user;
  if (!user) {
    const username = deriveHandleFromEmail(normalizedEmail);
    user = createUser(normalizedEmail, username);
  }

  // 3. Check for existing trail grant (idempotent)
  const existingGrant = db.prepare(
    "SELECT tg.id, tg.grantee_id FROM trail_grants tg WHERE tg.trail_id = ? AND tg.grantee_type = 'token' AND tg.grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)"
  ).get(trailId, user.id) as { id: string; grantee_id: string } | undefined;

  let keyId: string;

  if (existingGrant) {
    keyId = existingGrant.grantee_id;
  } else {
    // 4. Create trail-scoped API key for the invited user
    const keyResult = createKey(`trail:${trail.name}`, ["read"], trailVaultId, undefined, user.id);
    keyId = keyResult.id;

    // 5. Create trail grant linking trail → key
    db.prepare(
      "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "grant_" + randomBytes(4).toString("hex"),
      trailId,
      "token",
      keyResult.id,
      new Date().toISOString(),
    );
  }

  // 6. Send welcome magic link email
  //    Create a magic link token directly so we can send the welcome variant
  const token = randomBytes(32).toString("hex");
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const mlId = "ml_" + randomBytes(8).toString("hex");

  db.prepare(
    "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).run(
    mlId,
    normalizedEmail,
    tokenHash,
    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  );

  // Redirect through grove.md auth callback so the user gets a session cookie
  // and lands on the trail. `resident=<handle>` carries the owning resident
  // into grove-www so the UI can render "@<handle> · <trailName>" chrome
  // before the session is fully established.
  const wwwBase = baseUrl.replace("api.grove.md", "grove.md");
  const redirect = `${wwwBase}/api/auth/callback?trail=${encodeURIComponent(trailId)}&resident=${encodeURIComponent(ownerHandle)}`;
  const verifyUrl = `${baseUrl}/auth/verify?token=${token}&email=${encodeURIComponent(normalizedEmail)}&redirect=${encodeURIComponent(redirect)}`;
  await sendMagicLinkEmail(normalizedEmail, verifyUrl, {
    welcome: true,
    trailName: trail.name,
    ownerHandle,
    ownerDisplayName,
  });

  return {
    user_id: user.id,
    email: normalizedEmail,
    trail_id: trailId,
    key_id: keyId,
    created,
  };
}

/**
 * Invite a user to a specific vault (P8-B2). Idempotent on (email, vault):
 * a second invite finds the existing `vault_members` row and returns the
 * existing key instead of minting a new one.
 *
 * Separate from `inviteUser` (trail-scoped) because vaults and trails have
 * independent access models. A user can be a `member` of vault A *and* a
 * trail-grant holder on a vault-B trail.
 */
export async function inviteUserToVault(
  email: string,
  vaultSlug: string,
  role: VaultRole,
  baseUrl: string,
): Promise<VaultInviteResult> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();
  if (role !== "owner" && role !== "member" && role !== "viewer") {
    throw new Error(`invalid role: ${role}`);
  }

  const vault = db
    .prepare("SELECT id, slug, display_name FROM vaults WHERE slug = ?")
    .get(vaultSlug) as { id: string; slug: string; display_name: string } | undefined;
  if (!vault) {
    throw new Error(`vault not found: ${vaultSlug}`);
  }

  let user = getUserByEmail(normalizedEmail);
  const created = !user;
  if (!user) {
    // New owners get `users.role = 'owner'` so they pass the global
    // owner check in admin-auth.ts (e.g. /keys, where the request has
    // no vault context). Without this, an invitee who is `owner` of
    // their new vault is still rejected when the dashboard's keys
    // page calls /keys → 403 → SSR redirect("/"). Members/viewers stay
    // on the default ("viewer"); they have no reason to mint keys.
    const userRole = role === "owner" ? "owner" : "viewer";
    user = createUser(normalizedEmail, deriveHandleFromEmail(normalizedEmail), userRole);
  } else if (role === "owner" && user.role !== "owner") {
    // Existing user being promoted to owner of a new vault. Same reason
    // as above — they need the global role to manage their own keys.
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(user.id);
    user = { ...user, role: "owner" };
  }

  const existingMembership = db
    .prepare("SELECT role FROM vault_members WHERE user_id = ? AND vault_id = ?")
    .get(user.id, vault.id) as { role: string } | undefined;

  let newMembership = false;
  if (!existingMembership) {
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run(user.id, vault.id, role);
    newMembership = true;
  }

  const existingKey = db
    .prepare(
      "SELECT id FROM api_keys WHERE user_id = ? AND vault_id = ? ORDER BY created_at ASC LIMIT 1",
    )
    .get(user.id, vault.id) as { id: string } | undefined;

  let keyId: string;
  if (existingKey) {
    keyId = existingKey.id;
  } else {
    const scopes = role === "viewer" ? ["read"] : ["read", "write"];
    const keyResult = createKey(`${vault.slug}-${role}`, scopes, vault.id, undefined, user.id);
    keyId = keyResult.id;
  }

  // Magic link for first-time users; existing users just get the deep-link
  // email. Both branches produce a working "Open <vault>" + "Add to Claude.ai"
  // pair so the invitee never has to hunt for URLs.
  const wwwBase = baseUrl.replace("api.grove.md", "grove.md");
  const ownerHandle = user.username;
  const connectorUrl = `${baseUrl}/v/${vault.slug}/mcp`;

  // Both branches must route through grove.md's /api/auth/callback so the
  // dashboard receives a session cookie before its auth gate runs. Skipping
  // the callback (a bare dashboard URL, or a verify→dashboard redirect that
  // only carries ?code=) was the root cause of Sumon's onboarding bounce:
  // /v1/admin/onboard always provisions the user moments before invite, so
  // even the "existing user" branch has no session yet. See inviteUser
  // (~line 126) for the canonical wwwBase + /api/auth/callback shape.
  const dashboardRedirect = `${wwwBase}/@${ownerHandle}/${vault.slug}/dashboard`;
  const callbackUrl = `${wwwBase}/api/auth/callback?redirect=${encodeURIComponent(dashboardRedirect)}`;

  if (created) {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const mlId = "ml_" + randomBytes(8).toString("hex");
    db.prepare(
      "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      mlId,
      normalizedEmail,
      tokenHash,
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    );
    const verifyUrl = `${baseUrl}/auth/verify?token=${token}&email=${encodeURIComponent(normalizedEmail)}&redirect=${encodeURIComponent(callbackUrl)}`;
    await sendVaultInviteEmail(normalizedEmail, verifyUrl, connectorUrl, {
      vaultSlug: vault.slug,
      vaultName: vault.display_name,
      role,
      magicLink: true,
    });
  } else {
    // Existing user — also route through /api/auth/callback. Even when the
    // user predates this invite, they may not have a live grove.md session
    // (cookie expired, different browser, /v1/admin/onboard pre-creating
    // the user). The callback is a no-op for an already-authenticated
    // request and a session-establisher otherwise.
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const mlId = "ml_" + randomBytes(8).toString("hex");
    db.prepare(
      "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      mlId,
      normalizedEmail,
      tokenHash,
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    );
    const verifyUrl = `${baseUrl}/auth/verify?token=${token}&email=${encodeURIComponent(normalizedEmail)}&redirect=${encodeURIComponent(callbackUrl)}`;
    await sendVaultInviteEmail(normalizedEmail, verifyUrl, connectorUrl, {
      vaultSlug: vault.slug,
      vaultName: vault.display_name,
      role,
      magicLink: false,
    });
  }

  return {
    user_id: user.id,
    email: normalizedEmail,
    vault_id: vault.id,
    vault_slug: vault.slug,
    key_id: keyId,
    role,
    created,
    newMembership,
  };
}
