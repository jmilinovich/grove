#!/usr/bin/env tsx
/**
 * Grove Phase 0 — Auth proxy for QMD MCP server.
 *
 * Sits in front of QMD's MCP HTTP server (localhost:8181) and validates
 * bearer tokens before forwarding requests. Implements a minimal OAuth 2.0
 * flow so Claude.ai can connect as a custom connector.
 *
 * Usage:
 *   GROVE_PORT=8420 npx tsx src/proxy.ts
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { RateLimiter } from "./rate-limit.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { createKey, revokeKey, isExpired, hashToken, updateLastUsed, type StoredKey } from "./keys.js";
import { getDb, closeDb } from "./db.js";
import { runMigration } from "./db.js";
import {
  requestMagicLink,
  verifyMagicLink,
  validateSession,
  destroySession,
  createSession as createAuthSession,
  createAuthCode,
  exchangeAuthCode,
  generateCsrfToken,
  validateCsrfToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
  getSessionIdFromToken,
  cleanupExpiredAuth,
  seedAdminEmail,
} from "./auth.js";
import {
  getUserRole,
  deleteUser,
  listUsersWithMeta,
  updateUserDisplayName,
  listUserSessions,
  revokeUserSession,
  revokeAllOtherSessions,
  getUserById,
  changeUserHandle,
  updateUserBio,
} from "./users.js";
import { generateRequestId, log as structuredLog, auditRead, auditWrite, auditUserAction } from "./logger.js";
import { installCrashHandlers } from "./crash-handlers.js";
import { metrics, searchMetrics } from "./metrics.js";
import { resolveTrail, loadTrails, createTrail, updateTrail, disableTrail, deleteTrail, type TrailConfig } from "./trails.js";
import {
  handleGetNote, handleSearch, handleListNotes, handleStats, handleWriteNote,
  handleDeleteNote, handleMoveNote,
  handleStatusHealth, handleStatusHistory, handleStatusDiagnostics,
  handleStatusDigest, handleTrailInfo,
  handleResidentProfile,
  handleTrailPreview, handleTrailPreviewTest,
  VALID_STATUS_MODES,
  handleImageUpload,
  defaultVaultContext,
  type StatusMode,
} from "./rest.js";
import { VaultLockedError } from "./index-crypto.js";
import { parseMultipart, parseBoundary } from "./multipart.js";
import { startStatsTimer } from "./vault-stats.js";
import { inviteUser, inviteUserToVault } from "./invite.js";
import {
  createShareLink,
  resolveSharePublic,
  listShareLinks,
  revokeShareLink,
  getShareLink,
  deriveShareStatus,
  type SharedLink,
} from "./share.js";
import {
  encryptVault,
  unlockVault,
  lockVault,
  changePassphrase,
  getVaultStatus,
  isVaultLocked,
} from "./crypto.js";
import {
  getCurrentHealth,
  getHealthHistory,
  getUnresolvedFlags,
  resolveFlag,
} from "./graph-health.js";
import { touchVaultMember } from "./vault-mru.js";
import {
  loadVaultMap,
  parseVaultPath,
  decideRoute,
  sunsetDate,
  lookupById as lookupVaultById,
  lookupBySlug as lookupVaultBySlug,
  contextFromRoute,
  userCanWriteVault,
  userIsVaultMember,
  type VaultContext,
} from "./vault-router.js";
import { adminAuth, type AdminAuthResult } from "./admin-auth.js";

installCrashHandlers("grove-proxy");

// ── Deploy + boot metadata ──────────────────────────────────────────
// /health returns these so the deploy workflow can verify it's seeing
// the new process (not a stale pre-deploy one) and auto-rollback if
// the new SHA doesn't come up within the health-poll window.
const BOOT_TIME_MS = Date.now();
const BOOT_TIME_ISO = new Date(BOOT_TIME_MS).toISOString();
const DEPLOYED_SHA = readDeployedSha();

function readDeployedSha(): string {
  // Primary: `.deployed_sha` file written by the deploy workflow after
  // `git pull`. Secondary: `git rev-parse HEAD` from the proxy's cwd
  // (works in dev, may fail on the VPS if cwd isn't the repo). Final
  // fallback: "unknown" — /health still works, just no SHA to verify.
  try {
    const sha = readFileSync(join(process.cwd(), ".deployed_sha"), "utf8").trim();
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch { /* fall through */ }
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (sha) return sha;
  } catch { /* fall through */ }
  return process.env.GROVE_DEPLOYED_SHA ?? "unknown";
}

const QMD_PORT = Number(process.env.QMD_PORT ?? 8181);
const GROVE_SERVER_PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);
const PROXY_PORT = Number(process.env.GROVE_PORT ?? 8420);
const LOG_DIR = join(homedir(), ".grove");
const LOG_PATH = join(LOG_DIR, "proxy.log");
const MCP_LOG_PATH = join(LOG_DIR, "mcp.jsonl");
const GROVE_URL = process.env.GROVE_URL ?? "https://api.grove.md";

const rateLimiter = new RateLimiter({ reads: 120, writes: 20, windowMs: 60_000 });

// Mint quota: 20 share links per hour per owner key.
const shareMintLimiter = new RateLimiter({ reads: 20, writes: 20, windowMs: 60 * 60 * 1000 });

// Public view quota: 60 resolutions per minute per client IP.
const shareViewLimiter = new RateLimiter({ reads: 60, writes: 60, windowMs: 60 * 1000 });

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function shareRowToApi(link: SharedLink, baseUrl: string, ownerHandle: string | null): Record<string, unknown> {
  const wwwBase = baseUrl.replace("api.grove.md", "grove.md");
  const handle = ownerHandle ?? "unknown";
  return {
    id: link.id,
    note_path: link.note_path,
    url: `${wwwBase}/@${handle}/s/${link.id}`,
    created_by: link.created_by,
    created_at: link.created_at,
    expires_at: link.expires_at,
    max_views: link.max_views,
    view_count: link.view_count,
    last_accessed_at: link.last_accessed_at,
    revoked_by: link.revoked_by,
    revoked_at: link.revoked_at,
    status: deriveShareStatus(link),
  };
}

// ── Admin auth: see ./admin-auth.ts ──
// `adminAuth(req, vaultId?)` is imported from a sibling module so unit
// tests can exercise it without booting the proxy's HTTP server. The
// `sessionAuth` helper below is proxy-local — used by `/keys` for "any
// authenticated user can manage their own keys".

/** Authenticate any session-cookie user (regardless of role). */
function sessionAuth(req: IncomingMessage): AdminAuthResult {
  const sessionToken = getSessionFromCookie(req);
  if (sessionToken) {
    const user = validateSession(sessionToken);
    if (user) return { ok: true, keyName: user.username ?? user.email, userId: user.id };
  }
  return { ok: false, status: 401 };
}

function validateToken(token: string): StoredKey | null {
  const hash = hashToken(token);
  const db = getDb();
  const key = db.prepare("SELECT * FROM api_keys WHERE hashed_token = ?").get(hash) as StoredKey | null;
  if (!key) return null;
  if (isExpired(key)) return null;
  updateLastUsed(key.id);
  return key;
}

function isVaultOwner(userId: string): boolean {
  const db = getDb();
  // Default vault slug renamed to 'personal' in P8-A1. Keep accepting 'life'
  // during the 90-day legacy window in case any callsite still seeds it.
  const vault = db
    .prepare("SELECT owner_id FROM vaults WHERE slug IN ('personal', 'life') ORDER BY CASE slug WHEN 'personal' THEN 0 ELSE 1 END LIMIT 1")
    .get() as { owner_id: string } | undefined;
  return vault?.owner_id === userId;
}

/** Pick a vault for admin vault operations — either an explicit override or the admin's sole vault. */
function resolveAdminVaultId(userId: string, override?: string): string | null {
  const db = getDb();
  if (override) {
    const v = db.prepare("SELECT id FROM vaults WHERE id = ? AND owner_id = ?").get(override, userId) as { id: string } | undefined;
    return v?.id ?? null;
  }
  const v = db.prepare("SELECT id FROM vaults WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1").get(userId) as { id: string } | undefined;
  return v?.id ?? null;
}

function sendLocked(res: ServerResponse) {
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "vault_locked", message: "Vault is encrypted and locked. Unlock with your passphrase." }));
}

function log(keyName: string | null, method: string, url: string, status: number, extra?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    key: keyName ?? "unauthenticated",
    method,
    url,
    status,
  };
  if (extra) Object.assign(entry, extra);
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch {
    // Best-effort logging — disk full or permission errors are non-fatal
  }
}

/** Log a full MCP conversation turn: request tool + args, response summary, latency */
function logMcp(keyName: string, sessionId: string | undefined, tool: string, args: unknown, response: unknown, latencyMs: number, status: number) {
  // Record metrics for this tool call
  metrics.record(tool, latencyMs, status >= 400);

  const entry = {
    ts: new Date().toISOString(),
    key: keyName,
    session: sessionId ?? null,
    tool,
    args,
    response: summarizeMcpResponse(response),
    latency_ms: latencyMs,
    status,
  };
  try { appendFileSync(MCP_LOG_PATH, JSON.stringify(entry) + "\n"); } catch {
    // Best-effort logging — disk full or permission errors are non-fatal
  }
}

/** Extract a readable summary from an MCP response for logging */
function summarizeMcpResponse(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const r = response as Record<string, unknown>;
  // tools/call response: { result: { content: [{ type, text }] } }
  const result = r.result as Record<string, unknown> | undefined;
  if (result?.content) {
    const content = result.content as { type: string; text: string }[];
    if (content[0]?.text) {
      const text = content[0].text;
      return { text_length: text.length, preview: text.slice(0, 300) };
    }
  }
  // tools/list response
  if (result?.tools) {
    const tools = result.tools as { name: string }[];
    return { tools: tools.map((t) => t.name) };
  }
  // Error response
  if (r.error) return { error: r.error };
  return { keys: Object.keys(r) };
}

// ── OAuth 2.0 minimal implementation ──
// Claude.ai requires OAuth for custom connectors. This implements
// the bare minimum: authorization code flow with auto-approve.
// The "authorization" just shows a page where you paste your API key.

// ── OAuth encryption helpers ──
// Short-lived AES-256-GCM encryption for API keys stored in oauth_codes.
// Keys are encrypted at code creation and decrypted at token exchange (5min window).
const OAUTH_ENCRYPT_KEY = createHash("sha256").update(process.env.GROVE_CSRF_SECRET ?? "grove-oauth-default").digest();

function encryptForOAuth(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", OAUTH_ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptForOAuth(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", OAUTH_ENCRYPT_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;

  // Protected Resource Metadata (RFC 9728) — required by MCP spec
  // Serves at both /mcp-scoped and root paths so clients discover auth regardless of path
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    sendJson(res, 200, {
      resource: `${GROVE_URL}/mcp`,
      authorization_servers: [GROVE_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
    });
    return true;
  }

  // OAuth server metadata (RFC 8414)
  if (path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: GROVE_URL,
      authorization_endpoint: `${GROVE_URL}/oauth/authorize`,
      token_endpoint: `${GROVE_URL}/oauth/token`,
      registration_endpoint: `${GROVE_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    return true;
  }

  // Dynamic Client Registration (RFC 7591)
  if (path === "/oauth/register" && req.method === "POST") {
    readBody(req).then((body) => {
      const data = JSON.parse(body);
      const clientId = "grove_client_" + randomBytes(16).toString("hex");
      const clientSecret = "grove_secret_" + randomBytes(32).toString("hex");
      const redirectUris = data.redirect_uris || [];

      const db = getDb();
      db.prepare(
        "INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris) VALUES (?, ?, ?)"
      ).run(clientId, hashToken(clientSecret), JSON.stringify(redirectUris));

      console.log(`OAuth client registered: ${clientId}`);
      sendJson(res, 201, {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  // Authorization endpoint — shows a simple page to paste your API key
  if (path === "/oauth/authorize" && req.method === "GET") {
    const clientId = htmlEscape(url.searchParams.get("client_id") ?? "");
    const redirectUri = htmlEscape(url.searchParams.get("redirect_uri") ?? "");
    const state = htmlEscape(url.searchParams.get("state") ?? "");
    const codeChallenge = htmlEscape(url.searchParams.get("code_challenge") ?? "");
    const codeChallengeMethod = htmlEscape(url.searchParams.get("code_challenge_method") ?? "");

    const html = `<!DOCTYPE html>
<html><head><title>Grove &mdash; Authorize</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #FAF7F2; color: #2C2416; padding: 20px; }
  .card { width: 100%; max-width: 400px; }
  h1 { font-family: 'Lora', Georgia, serif; font-size: 28px; font-weight: 500; margin-bottom: 8px; letter-spacing: -0.01em; }
  p { color: #2C2416aa; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #2C2416aa; margin-bottom: 8px; }
  input[type=password] { width: 100%; padding: 14px 16px; font-size: 14px; font-family: 'SF Mono', 'Fira Code', monospace; border: 1px solid #2C241620; border-radius: 4px; background: white; color: #2C2416; }
  input[type=password]:focus { outline: none; border-color: #7A8B5C; box-shadow: 0 0 0 3px #7A8B5C20; }
  input[type=password]::placeholder { color: #2C241640; }
  button { width: 100%; padding: 14px; font-size: 14px; font-weight: 600; background: #2C2416; color: #FAF7F2; border: none; border-radius: 4px; cursor: pointer; margin-top: 12px; letter-spacing: 0.02em; transition: background 0.15s; }
  button:hover { background: #3D3524; }
  button:active { transform: scale(0.98); }
  .subtle { font-size: 12px; color: #2C241650; margin-top: 16px; text-align: center; }
  .subtle a { color: #7A8B5C; text-decoration: none; }
  .subtle a:hover { text-decoration: underline; }
</style></head>
<body>
  <div class="card">
    <h1>Grove</h1>
    <p>Paste your API key to connect Claude to your vault.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
      <label for="api_key">API key</label>
      <input type="password" id="api_key" name="api_key" placeholder="grove_live_..." required autofocus>
      <button type="submit">Connect</button>
    </form>
    <p class="subtle">Don't have a key? <a href="https://grove.md">Get early access</a></p>
  </div>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return true;
  }

  // Authorization endpoint — POST (form submit)
  if (path === "/oauth/authorize" && req.method === "POST") {
    // IP-scoped rate limit. Each submitted api_key is validated —
    // without an upper bound this is a brute-force oracle.
    const oauthIp = clientIp(req);
    const oauthLimit = rateLimiter.check(`oauth-authorize:${oauthIp}`, "write");
    if (!oauthLimit.allowed) {
      sendJson(res, 429, { error: "rate_limited", retry_after_ms: oauthLimit.retryAfterMs });
      return true;
    }
    rateLimiter.record(`oauth-authorize:${oauthIp}`, "write");

    readBody(req).then((body) => {
      const params = new URLSearchParams(body);
      const apiKey = params.get("api_key") ?? "";
      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const state = params.get("state") ?? "";
      const codeChallenge = params.get("code_challenge") ?? "";
      const codeChallengeMethod = params.get("code_challenge_method") ?? "";

      // Validate the API key
      const key = validateToken(apiKey);
      if (!key) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 20px;background:#0a0a0a;color:#e0e0e0;">
          <h1 style="color:#c44;">Invalid API key</h1><p>That key wasn't recognized. <a href="javascript:history.back()" style="color:#4a9;">Try again</a></p></body></html>`);
        return;
      }

      // Generate auth code and store in SQLite
      const codeStr = randomBytes(32).toString("hex");
      const db = getDb();
      db.prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, key_id, encrypted_key, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        hashToken(codeStr),
        clientId,
        redirectUri,
        key.id,
        encryptForOAuth(apiKey),
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        codeChallenge || null,
        codeChallengeMethod || null,
      );

      console.log(`OAuth code issued for key: ${key.name}`);

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", codeStr);
      if (state) redirect.searchParams.set("state", state);
      const callbackUrl = redirect.toString();

      // Non-localhost (e.g. claude.ai) — standard 302
      if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
        res.writeHead(302, { Location: callbackUrl });
        res.end();
        return;
      }

      // Localhost — the MCP client should have a callback server running.
      // Serve a success page that redirects via JS. If the client is listening,
      // the redirect completes and the client shows its own close-tab page.
      // If not, the user sees "Authorized" instead of "site can't be reached"
      // and can copy the callback URL to paste into Claude Code manually.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><title>Grove — Authorized</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #FAF7F2; color: #2C2416; padding: 20px; }
  .card { width: 100%; max-width: 400px; text-align: center; }
  .check { color: #7A8B5C; font-size: 48px; margin-bottom: 16px; }
  h1 { font-family: 'Lora', Georgia, serif; font-size: 28px; font-weight: 500; margin-bottom: 8px; letter-spacing: -0.01em; }
  p { color: #2C2416aa; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
  .url { display: none; padding: 12px 16px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; background: white; border: 1px solid #2C241620; border-radius: 4px; word-break: break-all; text-align: left; margin: 16px 0; cursor: pointer; user-select: all; }
  .url:hover { border-color: #7A8B5C; }
  .hint { display: none; font-size: 12px; color: #2C241660; }
</style></head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Authorized</h1>
    <p id="status">Connecting to your client&hellip;</p>
    <div class="url" id="url">${callbackUrl}</div>
    <p class="hint" id="hint">Copy this URL and paste it into Claude Code to complete setup.</p>
  </div>
  <script>
    setTimeout(() => { window.location.href = ${JSON.stringify(callbackUrl)}; }, 600);
    setTimeout(() => {
      // If we're still here after 3s, the redirect didn't work
      document.getElementById("status").textContent = "You can close this tab.";
      document.getElementById("url").style.display = "block";
      document.getElementById("hint").style.display = "block";
    }, 3000);
  </script>
</body></html>`);
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  // Token endpoint — exchange code for access token
  if (path === "/oauth/token" && req.method === "POST") {
    readBody(req).then((body) => {
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");
      const code = params.get("code") ?? "";
      const codeVerifier = params.get("code_verifier") ?? "";

      if (grantType !== "authorization_code") {
        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      const db = getDb();
      const codeHash = hashToken(code);
      const authCode = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as {
        code_hash: string;
        client_id: string;
        redirect_uri: string;
        key_id: string;
        encrypted_key: string;
        expires_at: string;
        code_challenge: string | null;
        code_challenge_method: string | null;
      } | undefined;

      if (!authCode) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code not found" });
        return;
      }

      // Check expiry
      if (new Date(authCode.expires_at).getTime() < Date.now()) {
        db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code expired" });
        return;
      }

      // Verify PKCE if code_challenge was provided
      if (authCode.code_challenge && authCode.code_challenge_method === "S256") {
        const expected = createHash("sha256")
          .update(codeVerifier)
          .digest("base64url");
        if (expected !== authCode.code_challenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }

      // Remove used code and decrypt the API key
      db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
      const accessToken = decryptForOAuth(authCode.encrypted_key);

      console.log(`OAuth token issued for code`);

      // Return the original API key as the access token
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 86400 * 365, // 1 year — effectively no expiry
      });
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  return false;
}

// ── Proxy helpers ──

function proxyToQmd(req: IncomingMessage, res: ServerResponse) {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (key === "authorization" || key === "host") continue;
    if (val) headers[key] = Array.isArray(val) ? val.join(", ") : val;
  }

  const proxyReq = httpRequest(
    {
      hostname: "::1",
      port: QMD_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val) resHeaders[key] = val;
      }
      resHeaders["access-control-allow-origin"] = "*";
      resHeaders["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      resHeaders["access-control-allow-headers"] =
        "Content-Type, Authorization, mcp-session-id";
      resHeaders["access-control-expose-headers"] = "mcp-session-id";

      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "QMD server unreachable" }));
    }
  });

  req.pipe(proxyReq);
}

/** HTML-escape for safe interpolation into attributes/text. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function verifyPage(token: string, email: string, csrf: string, redirect: string = ""): string {
  // All four values may be attacker-controlled (magic-link query params,
  // posted form values). Escape before interpolating into attributes.
  const tokenEsc = htmlEscape(token);
  const emailEsc = htmlEscape(email);
  const csrfEsc = htmlEscape(csrf);
  const redirectEsc = htmlEscape(redirect);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove — Confirm Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;color:#2C2416;padding:20px}
  .card{width:100%;max-width:400px}
  h1{font-family:'Lora',Georgia,serif;font-size:28px;font-weight:500;margin-bottom:8px;letter-spacing:-0.01em}
  p{color:#2C2416aa;font-size:14px;line-height:1.6;margin-bottom:24px}
  .email{font-weight:600;color:#2C2416}
  button{width:100%;padding:14px;font-size:14px;font-weight:600;background:#2C2416;color:#FAF7F2;border:none;border-radius:4px;cursor:pointer;letter-spacing:0.02em;transition:background 0.15s}
  button:hover{background:#3D3524}
</style></head><body>
<div class="card">
  <h1>Grove</h1>
  <p>Sign in as <span class="email">${emailEsc}</span></p>
  <form method="POST" action="/auth/verify">
    <input type="hidden" name="token" value="${tokenEsc}">
    <input type="hidden" name="email" value="${emailEsc}">
    <input type="hidden" name="csrf" value="${csrfEsc}">
    <input type="hidden" name="redirect" value="${redirectEsc}">
    <button type="submit">Confirm Sign In</button>
  </form>
</div>
</body></html>`;
}

function setupPage(keyName: string | null): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
  h1{font-size:1.4em;margin-bottom:4px}
  .sub{color:#666;margin-bottom:32px;font-size:.9em}
  .section{margin-bottom:28px}
  .section h2{font-size:.85em;text-transform:uppercase;letter-spacing:.05em;color:#888;margin-bottom:8px}
  .endpoint{background:#f5f5f5;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:.9em;word-break:break-all;cursor:pointer;position:relative}
  .endpoint:hover{background:#eee}
  .endpoint::after{content:'copy';position:absolute;right:12px;top:12px;font-family:sans-serif;font-size:.75em;color:#888}
  input,button{font-size:.9em;padding:8px 12px;border-radius:6px;border:1px solid #ddd}
  input{width:100%;margin-bottom:8px}
  button{background:#1a1a1a;color:#fff;border:none;cursor:pointer;padding:8px 20px}
  button:hover{background:#333}
  .key-list{font-size:.85em;margin-top:12px}
  .key-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #eee}
  .key-item button{font-size:.75em;padding:4px 10px;background:#c33}
  .token-display{background:#f0f7e6;padding:12px;border-radius:8px;font-family:monospace;font-size:.8em;word-break:break-all;margin-top:8px}
  .note{font-size:.8em;color:#888;margin-top:4px}
  #auth-section{margin-bottom:28px}
  #authed{display:none}
</style></head><body>
<h1>Grove</h1>
<p class="sub">Knowledge API for your Obsidian vault</p>

<div class="section">
  <h2>MCP Endpoint</h2>
  <div class="endpoint" onclick="navigator.clipboard.writeText('${GROVE_URL}/mcp')">${GROVE_URL}/mcp</div>
  <p class="note">Use this URL when adding Grove as an MCP connector in Claude.ai, Cursor, or any MCP client.</p>
</div>

<div id="auth-section">
  <div class="section">
    <h2>Sign in with Email</h2>
    <input type="email" id="email-input" placeholder="you@example.com" />
    <button onclick="magicLink()">Send magic link</button>
    <div id="magic-link-msg" style="display:none" class="note"></div>
  </div>
  <div class="section">
    <h2>Or use an API key</h2>
    <input type="password" id="token-input" placeholder="Paste your API key (grove_live_...)" />
    <button onclick="auth()">Sign in</button>
    <p class="note">Need a key? Run <code>grove keys create my-key</code> from any device with an existing key.</p>
  </div>
</div>

<div id="authed">
  <div class="section">
    <h2>Create API Key</h2>
    <input type="text" id="key-name" placeholder="Key name (e.g., phone, laptop, cli)" />
    <button onclick="createKey()">Create</button>
    <div id="new-token" style="display:none">
      <div class="token-display" id="token-value"></div>
      <p class="note">Save this now — it won't be shown again.</p>
    </div>
  </div>
  <div class="section">
    <h2>API Keys</h2>
    <div id="key-list" class="key-list">Loading...</div>
  </div>
</div>

<script>
let bearerToken = null;
// Check for existing session on page load
fetch('/auth/session').then(r => r.ok ? r.json() : null).then(d => {
  if (d && d.user) {
    document.getElementById('auth-section').style.display = 'none';
    document.getElementById('authed').style.display = 'block';
    loadKeys();
  }
});
function magicLink() {
  const email = document.getElementById('email-input').value.trim();
  if (!email) return;
  const msg = document.getElementById('magic-link-msg');
  fetch('/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then(r => r.json()).then(() => {
    msg.textContent = 'Check your email for a sign-in link.';
    msg.style.display = 'block';
  });
}
function auth() {
  bearerToken = document.getElementById('token-input').value.trim();
  if (!bearerToken) return;
  fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: bearerToken }),
  }).then(r => {
    if (r.ok) {
      document.getElementById('auth-section').style.display = 'none';
      document.getElementById('authed').style.display = 'block';
      loadKeys();
    }
  });
}
function authHeaders() {
  var h = { 'Content-Type': 'application/json' };
  if (bearerToken) h['Authorization'] = 'Bearer ' + bearerToken;
  return h;
}
function loadKeys() {
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'list' }),
  }).then(r => r.json()).then(d => {
    const keys = d.keys || [];
    if (keys.length === 0) {
      document.getElementById('key-list').innerHTML = '<p class="note">No keys.</p>';
      return;
    }
    document.getElementById('key-list').innerHTML = keys.map(k =>
      '<div class="key-item"><span>' + k.name + ' <span class="note">(' + k.id + ', ' + (k.scopes||[]).join(',') + ')</span></span>' +
      '<button onclick="revokeKey(\\'' + k.id + '\\')">Revoke</button></div>'
    ).join('');
  });
}
function revokeKey(id) {
  if (!confirm('Revoke key ' + id + '?')) return;
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'revoke', id }),
  }).then(() => loadKeys());
}
function createKey() {
  const name = document.getElementById('key-name').value.trim();
  if (!name) return;
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'create', name }),
  }).then(r => r.json()).then(d => {
    if (d.token) {
      document.getElementById('token-value').textContent = d.token;
      document.getElementById('new-token').style.display = 'block';
      document.getElementById('key-name').value = '';
    }
  });
}
</script>
</body></html>`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1048576; // 1MB body size limit
const MAX_IMAGE_BODY = 12 * 1024 * 1024; // 12MB raw (10MB file + multipart overhead)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Proxy a request to QMD and return the full response body as a string */
function proxyAndCapture(hostname: string, port: number, origReq: IncomingMessage, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        hostname,
        port,
        path: origReq.url,
        method: origReq.method,
        headers: (() => {
          const h: Record<string, string> = {
            "Accept": "application/json, text/event-stream",
          };
          for (const [k, v] of Object.entries(origReq.headers)) {
            if (k === "authorization" || k === "host") continue;
            if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          return h;
        })(),
      },
      (proxyRes) => {
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => resolve(data));
      }
    );
    proxyReq.on("error", reject);
    proxyReq.write(body);
    proxyReq.end();
  });
}

// ── Main server ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PROXY_PORT}`);
  const rid = (req.headers["x-request-id"] as string) ?? generateRequestId();
  res.setHeader("X-Request-Id", rid);

  // CORS preflight — /v1/* gets locked-down CORS (handled in the /v1/ block below),
  // everything else gets permissive CORS for MCP/Claude.ai compatibility
  if (req.method === "OPTIONS" && !url.pathname.startsWith("/v1/")) {
    // Lock down cookie-auth routes; keep * for Bearer-only routes (MCP, search)
    const isCookieRoute = url.pathname.startsWith("/auth") ||
      url.pathname.startsWith("/admin") ||
      url.pathname === "/keys" ||
      url.pathname === "/";
    const corsOrigin = isCookieRoute ? GROVE_URL : "*";
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
      "Access-Control-Expose-Headers": "mcp-session-id",
    });
    res.end();
    return;
  }

  // OAuth endpoints (unauthenticated)
  if (handleOAuth(req, res, url)) return;

  // Deep health check — verifies downstream services (Grove server + embed).
  // The legacy `qmd-server` HTTP companion on :8177 is no longer required —
  // hybrid-search runs BM25 in-process via FTS5 (see hybrid-search.ts:85).
  // We still PROBE :8177 so operators can see whether anything's listening,
  // but its state no longer fails the readiness gate. Only the proxy's
  // ability to reach the canonical grove-server (via $GROVE_SERVER_PORT)
  // and the presence of a Voyage API key are required for `ok: true`.
  if (url.pathname === "/health") {
    const checks: Record<string, boolean> = { proxy: true };
    const checkServer = (hostname: string, port: number, path: string) =>
      new Promise<boolean>((resolve) => {
        const r = httpRequest({ hostname, port, path, method: "GET", timeout: 3000 }, (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 400);
        });
        r.on("error", () => resolve(false));
        r.on("timeout", () => { r.destroy(); resolve(false); });
        r.end();
      });
    const [groveOk, qmdOk] = await Promise.all([
      checkServer("127.0.0.1", GROVE_SERVER_PORT, "/health"),
      checkServer("127.0.0.1", 8177, "/health"), // legacy BM25 companion — advisory only
    ]);
    // Embed health: just check that VOYAGE_API_KEY is set (API is external).
    const embedOk = !!process.env.VOYAGE_API_KEY;
    checks["grove-server"] = groveOk;
    checks.qmd = qmdOk;
    checks.embed = embedOk;
    // qmd intentionally omitted from the readiness gate. See header comment.
    const allOk = groveOk && embedOk;
    sendJson(res, allOk ? 200 : 503, {
      ok: allOk,
      sha: DEPLOYED_SHA,
      started_at: BOOT_TIME_ISO,
      uptime_sec: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),
      checks,
    });
    return;
  }

  // P8-A2: vault-scoped health (/v/<slug>/health). Lets the deploy workflow
  // and the multi-vault smoke test hit each vault's grove-server directly
  // without an auth token. Unknown slugs return 404 (health is a public
  // probe — no slug-enumeration leak concern, unlike MCP/REST).
  {
    const healthMatch = /^\/v\/([^/?#]+)\/health$/.exec(url.pathname);
    if (healthMatch) {
      const slug = healthMatch[1]!;
      const v = (await import("./vault-router.js")).lookupBySlug(slug);
      if (!v) {
        sendJson(res, 404, { ok: false, error: "unknown vault" });
        return;
      }
      const checkServer = (hostname: string, port: number, path: string) =>
        new Promise<{ ok: boolean; body: string }>((resolve) => {
          const r = httpRequest({ hostname, port, path, method: "GET", timeout: 3000 }, (proxyRes) => {
            let body = "";
            proxyRes.on("data", (c) => body += c);
            proxyRes.on("end", () => resolve({ ok: (proxyRes.statusCode ?? 500) < 400, body }));
          });
          r.on("error", () => resolve({ ok: false, body: "" }));
          r.on("timeout", () => { r.destroy(); resolve({ ok: false, body: "" }); });
          r.end();
        });
      const result = await checkServer("127.0.0.1", v.server_port, "/health");
      // Passthrough the backend's structured body so SHA / checks are visible.
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(result.body); } catch { /* backend may be down or not JSON */ }
      sendJson(res, result.ok ? 200 : 503, {
        ok: result.ok,
        vault: slug,
        vault_id: v.id,
        backend_port: v.server_port,
        ...parsed,
      });
      return;
    }
  }

  // Metrics endpoint — request counts, latency percentiles, error rates
  if (url.pathname === "/metrics") {
    const admin = adminAuth(req);
    if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }
    res.setHeader("Access-Control-Allow-Origin", GROVE_URL);
    sendJson(res, 200, { ...metrics.getMetrics(), search: searchMetrics.getSearchStats() });
    return;
  }

  // P8-B3 (decision #11) — MRU tracking. Any request with a valid bearer bumps
  // `vault_members.last_active_at` so bare `/dashboard` can 301 to the user's
  // most-recently-used vault. Throttled per (user, vault) to ≤1 write/min.
  // /health, /metrics, /oauth/*, and OPTIONS already short-circuited above.
  {
    const mruAuth = req.headers.authorization;
    const mruToken = mruAuth?.startsWith("Bearer ") ? mruAuth.slice(7) : null;
    if (mruToken) {
      const mruKey = validateToken(mruToken);
      if (mruKey) touchVaultMember(mruKey.user_id, mruKey.vault_id);
    }
  }

  // ── Admin login (POST /admin/login — creates persistent session cookie) ──
  if (url.pathname === "/admin/login" && req.method === "POST") {
    // IP-scoped rate limit. Without this, this endpoint is a
    // brute-force oracle for API keys.
    const ip = clientIp(req);
    const limit = rateLimiter.check(`admin-login:${ip}`, "write");
    if (!limit.allowed) {
      sendJson(res, 429, { error: "rate_limited", retry_after_ms: limit.retryAfterMs });
      return;
    }
    rateLimiter.record(`admin-login:${ip}`, "write");

    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }
    const apiKey = parsed.api_key ?? "";
    const key = validateToken(apiKey);
    if (!key) { sendJson(res, 401, { error: "invalid key" }); return; }
    // Find the user who owns this key and create a persistent session
    const keyOwner = getDb().prepare("SELECT id FROM users WHERE id = ?").get(key.user_id) as { id: string } | undefined;
    const { token: sessionToken } = createAuthSession(keyOwner?.id ?? key.user_id, req.headers["user-agent"] ?? null);
    setSessionCookie(res, sessionToken);
    sendJson(res, 200, { ok: true, name: key.name });
    return;
  }

  // ── Magic link auth routes ──────────────────────────────────────
  if (url.pathname === "/auth/magic-link" && req.method === "POST") {
    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }
    const email = parsed.email;
    const redirect = parsed.redirect;
    if (!email || typeof email !== "string") { sendJson(res, 400, { error: "email required" }); return; }
    try {
      await requestMagicLink(email, GROVE_URL, redirect);
    } catch (err) {
      console.error("[auth] magic link error:", err);
    }
    // Always return success to prevent email enumeration
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/auth/verify" && req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const email = url.searchParams.get("email") ?? "";
    const redirect = url.searchParams.get("redirect") ?? "";
    if (!token || !email) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><p>Invalid link.</p></body></html>");
      return;
    }
    const csrf = generateCsrfToken();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(verifyPage(token, email, csrf, redirect));
    return;
  }

  if (url.pathname === "/auth/verify" && req.method === "POST") {
    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    const params = new URLSearchParams(body);
    const token = params.get("token") ?? "";
    const email = params.get("email") ?? "";
    const csrf = params.get("csrf") ?? "";
    const redirect = params.get("redirect") ?? "";

    if (!validateCsrfToken(csrf)) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body><p>Invalid or expired request. <a href=\"/\">Try again</a></p></body></html>");
      return;
    }

    const result = verifyMagicLink(token, email, req.headers["user-agent"] ?? null);
    if (!result) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body><p>This link is invalid or has expired. <a href=\"/\">Request a new one</a></p></body></html>");
      return;
    }

    // If redirect to grove.md, use auth code flow. `startsWith` alone
    // permits e.g. `https://grove.md.evil.com/...` — parse the URL and
    // compare the host exactly so the auth code never leaks off-origin.
    let redirectsToGroveMd = false;
    if (redirect) {
      try {
        const parsed = new URL(redirect);
        redirectsToGroveMd = parsed.protocol === "https:" && parsed.host === "grove.md";
      } catch {
        redirectsToGroveMd = false;
      }
    }
    if (redirectsToGroveMd) {
      const code = createAuthCode(result.user.id);
      const sep = redirect.includes("?") ? "&" : "?";
      res.writeHead(302, { "Location": `${redirect}${sep}code=${code}` });
      res.end();
      return;
    }

    setSessionCookie(res, result.sessionToken);
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/auth/exchange" && req.method === "GET") {
    // IP-scoped rate limit. Defence-in-depth: codes are 32 random
    // hex chars so guessing is infeasible, but we still don't want
    // to be a free brute-force oracle.
    const xchgIp = clientIp(req);
    const xchgLimit = rateLimiter.check(`auth-exchange:${xchgIp}`, "write");
    if (!xchgLimit.allowed) {
      sendJson(res, 429, { error: "rate_limited", retry_after_ms: xchgLimit.retryAfterMs });
      return;
    }
    rateLimiter.record(`auth-exchange:${xchgIp}`, "write");

    const code = url.searchParams.get("code") ?? "";
    if (!code) { sendJson(res, 400, { error: "code required" }); return; }
    const result = exchangeAuthCode(code, req.headers["user-agent"] ?? null);
    if (!result) { sendJson(res, 401, { error: "invalid or expired code" }); return; }
    // Set session cookie so the caller can make authenticated requests (e.g. create keys)
    setSessionCookie(res, result.sessionToken);
    sendJson(res, 200, { session_token: result.sessionToken, user: result.user });
    return;
  }

  if (url.pathname === "/auth/session" && req.method === "GET") {
    const sessionToken = getSessionFromCookie(req);
    res.setHeader("Access-Control-Allow-Origin", GROVE_URL);
    if (!sessionToken) { sendJson(res, 401, { error: "not authenticated" }); return; }
    const user = validateSession(sessionToken);
    if (!user) { sendJson(res, 401, { error: "session expired" }); return; }
    sendJson(res, 200, { user: { id: user.id, username: user.username, email: user.email } });
    return;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const sessionToken = getSessionFromCookie(req);
    if (sessionToken) destroySession(sessionToken);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Setup page at / ──
  if (url.pathname === "/" && req.method === "GET") {
    const admin = adminAuth(req);
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authed = admin.ok ? admin : (token ? (() => { const k = validateToken(token); return k ? { keyId: k.id, keyName: k.name } : null; })() : null);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupPage(authed?.keyName ?? null));
    return;
  }

  // ── Key management API (admin session cookie or bearer auth required) ──
  if (url.pathname === "/keys" && req.method === "POST") {
    // Allow any authenticated user to manage their own keys; fall back to admin auth for Bearer tokens
    const session = sessionAuth(req);
    const admin = session.ok ? session : adminAuth(req);
    if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

    let body: string;
    try { body = await readBody(req); } catch (err: unknown) {
      if ((err as Error).message === "payload too large") { sendJson(res, 413, { error: "payload too large" }); return; }
      sendJson(res, 400, { error: "read error" }); return;
    }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

    const owner = isVaultOwner(admin.userId);

    if (parsed.action === "list") {
      const db = getDb();
      // Optional per-vault filter: grove-www sends `vault_slug` when the
      // caller is viewing a specific vault's keys page so a multi-vault
      // owner doesn't see every vault's keys mashed together. Resolved
      // to vault_id here rather than client-side so the filter survives
      // stale cached vault lists in the UI.
      let vaultIdFilter: string | null = null;
      if (typeof parsed.vault_slug === "string" && parsed.vault_slug.length > 0) {
        const row = db
          .prepare("SELECT id FROM vaults WHERE slug = ? LIMIT 1")
          .get(parsed.vault_slug) as { id: string } | undefined;
        if (row?.id) vaultIdFilter = row.id;
      } else if (typeof parsed.vault_id === "string" && parsed.vault_id.length > 0) {
        vaultIdFilter = parsed.vault_id;
      }

      // Owner sees all keys; non-owner sees only their own.
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!owner) {
        clauses.push("user_id = ?");
        params.push(admin.userId);
      }
      if (vaultIdFilter) {
        clauses.push("vault_id = ?");
        params.push(vaultIdFilter);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const query = `SELECT id, user_id, name, scopes, vault_id, created_at, last_used_at, expires_at FROM api_keys ${where}`;
      const rows = db.prepare(query).all(...params) as StoredKey[];
      const keys = rows.map((k) => ({
        id: k.id,
        user_id: k.user_id,
        name: k.name,
        scopes: k.scopes,
        vault_id: k.vault_id,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        expires_at: k.expires_at,
      }));
      sendJson(res, 200, { keys });
      return;
    }
    if (parsed.action === "create" && parsed.name) {
      // If the caller is session-authenticated, link the new key to that session so
      // /v1/me can flag it as the current device. Bearer-authenticated key creation
      // has no session and stores null.
      const sessionToken = getSessionFromCookie(req);
      const linkedSessionId = sessionToken ? getSessionIdFromToken(sessionToken) : null;
      // Pick the bound vault: explicit `vault` (id) > `vault_slug`
      // (resolved) > caller's earliest membership > legacy "life"
      // sentinel. Grove-www sends `vault_slug` when the key is minted
      // from a specific vault's `/dashboard/access/keys` page so the
      // key binds to that vault instead of the user's primary.
      let boundVaultId: string = parsed.vault ?? "";
      if (!boundVaultId && typeof parsed.vault_slug === "string" && parsed.vault_slug.length > 0) {
        const row = getDb()
          .prepare("SELECT id FROM vaults WHERE slug = ? LIMIT 1")
          .get(parsed.vault_slug) as { id: string } | undefined;
        if (row?.id) boundVaultId = row.id;
      }
      if (!boundVaultId) {
        const membership = getDb()
          .prepare(
            `SELECT vault_id FROM vault_members
               WHERE user_id = ?
               ORDER BY joined_at ASC
               LIMIT 1`,
          )
          .get(admin.userId) as { vault_id: string } | undefined;
        boundVaultId = membership?.vault_id ?? "life";
      }
      const result = createKey(
        parsed.name,
        parsed.scopes ?? ["read", "write"],
        boundVaultId,
        undefined,
        admin.userId,
        linkedSessionId,
      );

      // If trail_id provided, create a trail grant linking this key to the trail
      if (parsed.trail_id) {
        const db = getDb();
        const trail = db.prepare("SELECT id FROM trails WHERE id = ?").get(parsed.trail_id);
        if (trail) {
          const grantId = "grant_" + randomBytes(4).toString("hex");
          db.prepare(
            "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(grantId, parsed.trail_id, "token", result.id, new Date().toISOString());
        }
      }

      sendJson(res, 200, { id: result.id, name: result.name, token: result.token });
      return;
    }
    if (parsed.action === "revoke" && parsed.id) {
      // Non-owner can only revoke their own keys
      if (!owner) {
        const db = getDb();
        const target = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get(parsed.id) as { user_id: string } | undefined;
        if (!target || target.user_id !== admin.userId) {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
      }
      revokeKey(parsed.id);
      sendJson(res, 200, { revoked: parsed.id });
      return;
    }
    sendJson(res, 400, { error: "invalid action" });
    return;
  }

  // Search endpoint — proxies to the BM25 search server on 8177
  if (url.pathname.startsWith("/search")) {
    const authHeader2 = req.headers.authorization;
    const token2 = authHeader2?.startsWith("Bearer ") ? authHeader2.slice(7) : null;
    if (!token2 || !validateToken(token2)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const searchHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "authorization" || k === "host") continue;
      if (v) searchHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const searchReq = httpRequest(
      { hostname: "127.0.0.1", port: 8177, path: req.url, method: req.method, headers: searchHeaders },
      (searchRes) => {
        const h: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(searchRes.headers)) { if (v) h[k] = v; }
        h["access-control-allow-origin"] = "*";
        res.writeHead(searchRes.statusCode ?? 200, h);
        searchRes.pipe(res);
      }
    );
    searchReq.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { error: "Search server unreachable" });
    });
    req.pipe(searchReq);
    return;
  }

  // ── REST API v1 endpoints (for grove-www note viewer) ──────────────
  // These are Bearer-authed, CORS-locked to grove.md, and accept either
  // the legacy `/v1/*` path (which targets the proxy's bound vault) OR
  // the multi-vault `/v/<slug>/v1/*` shape (routed to the matching
  // vault's git repo via vault-router). `restPath` is the path the
  // dispatch table below matches on; `restCtx` is the per-request vault
  // context threaded into every rest.ts handler call.
  let restPath = url.pathname;
  let restCtx: VaultContext = defaultVaultContext();
  // True when this request arrived as `/v/<slug>/v1/*`. Admin endpoints
  // use it to scope list results to that vault instead of returning
  // every row the caller owns.
  let restIsVaultScoped = false;
  const vaultV1Match = /^\/v\/([^/?#]+)(\/v1\/.*)$/.exec(url.pathname);
  if (vaultV1Match) {
    const slug = vaultV1Match[1]!;
    const route = lookupVaultBySlug(slug);
    if (!route) {
      // Unknown slug — return 403 (not 404) so we don't leak which slugs exist.
      structuredLog("warn", "vault.rest_route_denied", rid, {
        url_slug: slug, reason: "unknown vault", status: 403,
      });
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Bearer token must authorize the URL's vault. Two accepted shapes:
    //   1. Legacy per-vault keys — `api_keys.vault_id === route.id`.
    //   2. User-session keys from grove-www — `api_keys.vault_id` is a
    //      legacy binding (may be a stale string like "life"), but the
    //      token's `user_id` is a member of the URL's vault via
    //      `vault_members`. Authorization follows user membership, not
    //      the key's bound vault, so a single session can reach every
    //      vault the user owns without re-minting a key per vault.
    //
    // For mutation methods (POST/PUT/PATCH/DELETE), require the
    // member's role is `owner` or `member` — viewers are strictly
    // read-only. Legacy per-vault keys bypass this check (they're
    // bound directly to the vault and their scopes already encode
    // read-vs-write intent).
    const restAuthHeader = req.headers.authorization;
    const restToken = restAuthHeader?.startsWith("Bearer ") ? restAuthHeader.slice(7) : null;
    const restKey = restToken ? validateToken(restToken) : null;
    const isMutation =
      req.method === "POST" ||
      req.method === "PUT" ||
      req.method === "PATCH" ||
      req.method === "DELETE";
    const directlyBound = !!restKey && restKey.vault_id === route.id;
    const memberAuthorized =
      !!restKey &&
      (isMutation
        ? userCanWriteVault(restKey.user_id, route.id)
        : userIsVaultMember(restKey.user_id, route.id));
    const restAuthorized = !!restKey && (directlyBound || memberAuthorized);
    if (!restAuthorized) {
      structuredLog("warn", "vault.rest_auth_denied", rid, {
        url_slug: slug,
        token_vault_id: restKey?.vault_id ?? null,
        token_user_id: restKey?.user_id ?? null,
        status: 403,
      });
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    restPath = vaultV1Match[2]!;
    restCtx = contextFromRoute(route);
    restIsVaultScoped = true;
  } else if (restPath.startsWith("/v1/")) {
    // Legacy `/v1/*` paths don't carry a vault slug. The previous
    // shape left `restCtx = defaultVaultContext()`, which reads from
    // the proxy's `$GROVE_VAULT` — that served every token's reads
    // from the proxy's primary vault regardless of which vault the
    // token actually bound to. A token for vault B calling
    // `/v1/notes/x.md` got vault A's (primary's) content.
    //
    // Look up the Bearer token tentatively (handlers still do their
    // own full auth below — this just resolves the right ctx) and
    // route to its vault when we can. Fallback to default only when
    // there's no parseable bearer (e.g. public endpoints like
    // `/v1/share/:id`, `/v1/residents/:handle`, `/v1/trails/:id/info`).
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authKey = authToken ? validateToken(authToken) : null;
    if (authKey?.vault_id) {
      const boundVault = lookupVaultById(authKey.vault_id);
      if (boundVault) {
        restCtx = contextFromRoute(boundVault);
      }
    }
  }
  if (restPath.startsWith("/v1/")) {
    const REST_CORS_ORIGIN = process.env.GROVE_WWW_ORIGIN ?? "https://grove.md";

    // CORS for /v1/* — locked to grove.md only
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": REST_CORS_ORIGIN,
        "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // ── Admin endpoints (session cookie or Bearer) ──
    if (restPath === "/v1/admin/users" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      // Scope to the URL's vault when we arrived via
      // `/v/<slug>/v1/admin/users` so the Members page shows only that
      // vault's roster. Legacy unscoped path continues returning every
      // user (admin panel elsewhere still depends on that shape).
      const users = listUsersWithMeta(restIsVaultScoped ? restCtx.vaultId : undefined);
      sendJson(res, 200, { users });
      return;
    }

    // DELETE /v1/admin/users/:id — remove a user and all their data
    if (restPath.startsWith("/v1/admin/users/") && req.method === "DELETE") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const userId = restPath.slice("/v1/admin/users/".length);
      if (!userId) { sendJson(res, 400, { error: "user id required" }); return; }

      // Per-vault scope: the target must share at least one
      // `vault_members` row with a vault the caller is an owner of.
      // Global `users.role='owner'` alone isn't enough — that would
      // let one vault's owner delete another vault's member.
      const db = getDb();
      const sharedOwnerRow = db
        .prepare(
          `SELECT 1
             FROM vault_members AS caller
             JOIN vault_members AS target ON caller.vault_id = target.vault_id
            WHERE caller.user_id = ?
              AND target.user_id = ?
              AND caller.role = 'owner'
            LIMIT 1`,
        )
        .get(admin.userId, userId);
      if (!sharedOwnerRow) {
        // 404 rather than 403 so we don't leak whether the user exists.
        sendJson(res, 404, { error: "user not found" });
        return;
      }

      try {
        const deleted = deleteUser(userId);
        if (!deleted) { sendJson(res, 404, { error: "user not found" }); return; }
        sendJson(res, 200, { deleted: userId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: msg });
      }
      return;
    }

    // POST /v1/admin/invite — invite a user to a trail
    if (restPath === "/v1/admin/invite" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      // `admin` is always a truthy object (AdminAuthResult). The correct
      // unauthenticated check is `!admin.ok` — the typo gated nothing
      // and made this endpoint fully unauthenticated. Anyone could
      // POST arbitrary invites (including role=owner for any vault).
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      let body: string;
      try { body = await readBody(req); } catch {
        sendJson(res, 400, { error: "read error" });
        return;
      }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch {
        sendJson(res, 400, { error: "invalid json" });
        return;
      }

      const { email, trail_id, vault, role } = parsed;
      if (!email || (!trail_id && !vault)) {
        sendJson(res, 400, { error: "email and either trail_id or vault are required" });
        return;
      }

      try {
        if (vault) {
          // P8-B2 vault invite path. Gate by vault ownership: only
          // someone who is an `owner` in `vault_members` of the
          // target vault can add new members. Global `users.role`
          // alone is not enough — without this check any
          // globally-provisioned owner could add themselves or
          // anyone else to any vault they don't own.
          const db = getDb();
          const targetVault = db
            .prepare("SELECT id FROM vaults WHERE id = ? OR slug = ? LIMIT 1")
            .get(vault, vault) as { id: string } | undefined;
          if (!targetVault) {
            sendJson(res, 404, { error: "vault not found" });
            return;
          }
          if (!userCanWriteVault(admin.userId, targetVault.id)) {
            // 404 not 403 so we don't confirm the vault exists.
            sendJson(res, 404, { error: "vault not found" });
            return;
          }
          const vaultRole = role === "owner" || role === "member" || role === "viewer" ? role : "member";
          const result = await inviteUserToVault(email, vault, vaultRole, GROVE_URL);
          sendJson(res, 200, result);
        } else {
          // Trail invite: caller must own the trail's vault.
          const db = getDb();
          const trailRow = db
            .prepare("SELECT vault_id FROM trails WHERE id = ? LIMIT 1")
            .get(trail_id) as { vault_id: string } | undefined;
          if (!trailRow) {
            sendJson(res, 404, { error: "trail not found" });
            return;
          }
          if (!userCanWriteVault(admin.userId, trailRow.vault_id)) {
            sendJson(res, 404, { error: "trail not found" });
            return;
          }
          const result = await inviteUser(email, trail_id, role ?? "viewer", GROVE_URL);
          sendJson(res, 200, result);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          sendJson(res, 404, { error: msg });
        } else {
          sendJson(res, 500, { error: msg });
        }
      }
      return;
    }

    // ── Vault encryption lifecycle (admin only) ──
    // POST /v1/admin/vault/encrypt — enable encryption (generate + store wrapped key)
    if (restPath === "/v1/admin/vault/encrypt" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      let body: string;
      try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

      const passphrase = parsed.passphrase;
      if (typeof passphrase !== "string" || passphrase.length < 8) {
        sendJson(res, 400, { error: "passphrase must be a string of at least 8 characters" });
        return;
      }
      const vaultId = resolveAdminVaultId(admin.userId, parsed.vault_id);
      if (!vaultId) { sendJson(res, 404, { error: "vault not found" }); return; }

      try {
        encryptVault(vaultId, passphrase);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "already_encrypted") {
          sendJson(res, 409, { error: "already_encrypted" });
          return;
        }
        sendJson(res, 500, { error: msg });
        return;
      }
      sendJson(res, 200, { ok: true, vault_id: vaultId, status: getVaultStatus(vaultId) });
      return;
    }

    // POST /v1/admin/vault/unlock — provide passphrase, decrypt key into memory
    if (restPath === "/v1/admin/vault/unlock" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      let body: string;
      try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

      const passphrase = parsed.passphrase;
      if (typeof passphrase !== "string") { sendJson(res, 400, { error: "passphrase required" }); return; }
      const vaultId = resolveAdminVaultId(admin.userId, parsed.vault_id);
      if (!vaultId) { sendJson(res, 404, { error: "vault not found" }); return; }

      try {
        const ok = unlockVault(vaultId, passphrase);
        if (!ok) { sendJson(res, 401, { error: "invalid_passphrase" }); return; }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "not_encrypted") { sendJson(res, 409, { error: "not_encrypted" }); return; }
        sendJson(res, 500, { error: msg });
        return;
      }
      sendJson(res, 200, { ok: true, vault_id: vaultId, status: getVaultStatus(vaultId) });
      return;
    }

    // POST /v1/admin/vault/lock — purge the in-memory vault key
    if (restPath === "/v1/admin/vault/lock" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      let parsed: any = {};
      if (req.method === "POST") {
        try {
          const body = await readBody(req);
          if (body) parsed = JSON.parse(body);
        } catch {
          // Empty body is fine for lock
        }
      }
      const vaultId = resolveAdminVaultId(admin.userId, parsed.vault_id);
      if (!vaultId) { sendJson(res, 404, { error: "vault not found" }); return; }

      const wasCached = lockVault(vaultId);
      sendJson(res, 200, { ok: true, vault_id: vaultId, was_unlocked: wasCached, status: getVaultStatus(vaultId) });
      return;
    }

    // GET /v1/admin/vault/status — encryption + unlock state
    if (restPath === "/v1/admin/vault/status" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const overrideVault = url.searchParams.get("vault_id") ?? undefined;
      const vaultId = resolveAdminVaultId(admin.userId, overrideVault);
      if (!vaultId) { sendJson(res, 404, { error: "vault not found" }); return; }

      sendJson(res, 200, { vault_id: vaultId, ...getVaultStatus(vaultId) });
      return;
    }

    // POST /v1/admin/vault/change-passphrase — rewrap vault key under new passphrase
    if (restPath === "/v1/admin/vault/change-passphrase" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      let body: string;
      try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

      const oldPass = parsed.old_passphrase;
      const newPass = parsed.new_passphrase;
      if (typeof oldPass !== "string" || typeof newPass !== "string" || newPass.length < 8) {
        sendJson(res, 400, { error: "old_passphrase and new_passphrase (>= 8 chars) required" });
        return;
      }
      const vaultId = resolveAdminVaultId(admin.userId, parsed.vault_id);
      if (!vaultId) { sendJson(res, 404, { error: "vault not found" }); return; }

      try {
        const ok = changePassphrase(vaultId, oldPass, newPass);
        if (!ok) { sendJson(res, 401, { error: "invalid_passphrase" }); return; }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "not_encrypted") { sendJson(res, 409, { error: "not_encrypted" }); return; }
        sendJson(res, 500, { error: msg });
        return;
      }
      sendJson(res, 200, { ok: true, vault_id: vaultId, status: getVaultStatus(vaultId) });
      return;
    }

    // POST /v1/admin/share — create a share-a-note link (admin only)
    if (restPath === "/v1/admin/share" && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const mintCheck = shareMintLimiter.check(admin.userId, "write");
      if (!mintCheck.allowed) {
        sendJson(res, 429, { error: "rate_limited", retry_after_ms: mintCheck.retryAfterMs });
        return;
      }

      let body: string;
      try { body = await readBody(req); } catch {
        sendJson(res, 400, { error: "read error" });
        return;
      }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch {
        sendJson(res, 400, { error: "invalid json" });
        return;
      }

      const { note_path, ttl_days, max_views } = parsed;
      if (!note_path || typeof note_path !== "string") {
        sendJson(res, 400, { error: "note_path is required" });
        return;
      }

      // `max_views`: omitted → default 100; `null` → unlimited; number → cap.
      let maxViewsOpt: number | null | undefined;
      if (max_views === undefined) maxViewsOpt = undefined;
      else if (max_views === null) maxViewsOpt = null;
      else if (typeof max_views === "number" && Number.isFinite(max_views) && max_views > 0) maxViewsOpt = max_views;
      else {
        sendJson(res, 400, { error: "max_views must be a positive number or null" });
        return;
      }

      // Anchor the share to the current request's vault context. Without
      // this, share resolution falls back to the proxy's default context
      // and ends up serving the wrong vault's note (or worse, the wrong
      // vault's fuzzy-match via resolveNote's BM25 fallback).
      const result = createShareLink(note_path, admin.userId, restCtx.vaultId, GROVE_URL, {
        ttl_days: typeof ttl_days === "number" ? ttl_days : undefined,
        max_views: maxViewsOpt,
      });
      shareMintLimiter.record(admin.userId, "write");
      sendJson(res, 200, result);
      return;
    }

    // GET /v1/admin/share — list share links for the owner
    if (restPath === "/v1/admin/share" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const notePathFilter = url.searchParams.get("note_path") ?? undefined;
      const includeExpired = url.searchParams.get("include_expired") === "true";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Math.min(100, Number(limitParam) || 50)) : 50;

      // Scope to the URL's vault when we arrived via `/v/<slug>/v1/admin/share`
      // so a multi-vault owner sees only that vault's shares. The legacy
      // unscoped `/v1/admin/share` path still returns every share the
      // caller created (single-vault callers depend on that shape).
      const rows = listShareLinks(admin.userId, {
        note_path: notePathFilter,
        include_expired: includeExpired,
        vault_id: restIsVaultScoped ? restCtx.vaultId : undefined,
      });
      const owner = getUserById(admin.userId);
      const ownerHandle = owner?.username ?? null;
      const page = rows.slice(0, limit);

      sendJson(res, 200, {
        shares: page.map((row) => shareRowToApi(row, GROVE_URL, ownerHandle)),
        next_cursor: null,
      });
      return;
    }

    // DELETE /v1/admin/share/:id — soft-revoke a share link
    const adminShareDeleteMatch = restPath.match(/^\/v1\/admin\/share\/([^/]+)$/);
    if (adminShareDeleteMatch && req.method === "DELETE") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const shareId = decodeURIComponent(adminShareDeleteMatch[1]!);
      const existing = getShareLink(shareId);
      // 404 for both "missing" and "not yours" so we don't leak share
      // existence. Revoke authority is: the creator of the share, or a
      // member of the vault the share belongs to.
      if (!existing) { sendJson(res, 404, { error: "share not found" }); return; }
      const callerOwns = existing.created_by === admin.userId;
      const callerHasVaultMembership = existing.vault_id
        ? userIsVaultMember(admin.userId, existing.vault_id)
        : false;
      if (!callerOwns && !callerHasVaultMembership) {
        sendJson(res, 404, { error: "share not found" });
        return;
      }
      if (existing.revoked_at !== null) {
        sendJson(res, 409, { error: "already_revoked", revoked_at: existing.revoked_at, revoked_by: existing.revoked_by });
        return;
      }

      const ok = revokeShareLink(shareId, admin.userId);
      if (!ok) { sendJson(res, 409, { error: "already_revoked" }); return; }

      const updated = getShareLink(shareId);
      sendJson(res, 200, {
        id: shareId,
        revoked_at: updated?.revoked_at ?? null,
        revoked_by: updated?.revoked_by ?? null,
      });
      return;
    }

    // ── Graph health (admin only) ──
    // GET /v1/admin/health/current — latest metrics snapshot + score
    if (restPath === "/v1/admin/health/current" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const snapshot = getCurrentHealth(
        restIsVaultScoped ? restCtx.vaultId : undefined,
      );
      sendJson(res, 200, { snapshot });
      return;
    }

    // GET /v1/admin/health/history?days=30 — time series
    if (restPath === "/v1/admin/health/history" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const daysParam = url.searchParams.get("days");
      const days = daysParam ? Number(daysParam) : 30;
      if (!Number.isFinite(days) || days <= 0) {
        sendJson(res, 400, { error: "days must be a positive number" });
        return;
      }
      const snapshots = getHealthHistory(
        days,
        restIsVaultScoped ? restCtx.vaultId : undefined,
      );
      sendJson(res, 200, { snapshots });
      return;
    }

    // GET /v1/admin/health/flags — unresolved flags
    if (restPath === "/v1/admin/health/flags" && req.method === "GET") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const flags = getUnresolvedFlags(
        restIsVaultScoped ? restCtx.vaultId : undefined,
      );
      sendJson(res, 200, { flags });
      return;
    }

    // POST /v1/admin/health/flags/:id/resolve — dismiss a flag
    const resolveFlagMatch = restPath.match(/^\/v1\/admin\/health\/flags\/([^/]+)\/resolve$/);
    if (resolveFlagMatch && req.method === "POST") {
      const admin = adminAuth(req, restCtx.vaultId);
      if (!admin.ok) { sendJson(res, admin.status, { error: admin.status === 403 ? "forbidden" : "unauthorized" }); return; }

      const flagId = decodeURIComponent(resolveFlagMatch[1]);
      const updated = resolveFlag(flagId);
      if (!updated) { sendJson(res, 404, { error: "flag not found or already resolved" }); return; }
      sendJson(res, 200, { resolved: flagId });
      return;
    }

    // GET /v1/share/:id — resolve a share link (public, no auth required)
    // The share ID itself is the secret — anyone with the link can view.
    const shareMatch = restPath.match(/^\/v1\/share\/([^/]+)$/);
    if (shareMatch && req.method === "GET") {
      // CORS: allow any origin for public share links
      res.setHeader("Access-Control-Allow-Origin", "*");

      const ip = clientIp(req);
      const viewCheck = shareViewLimiter.check(ip, "read");
      if (!viewCheck.allowed) {
        sendJson(res, 429, { error: "rate_limited", retry_after_ms: viewCheck.retryAfterMs });
        return;
      }
      shareViewLimiter.record(ip, "read");

      const shareId = decodeURIComponent(shareMatch[1]);
      const result = resolveSharePublic(shareId);
      if (result.status === "not_found") {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      if (result.status === "gone") {
        sendJson(res, 410, {
          error: "gone",
          reason: result.reason,
          message: result.reason === "revoked"
            ? "This link has been revoked"
            : "This link has expired",
        });
        return;
      }

      const link = result.link;

      // Resolve the share's vault_id to a real filesystem context. Never
      // use `restCtx` here — a public /v1/share/:id request has no
      // bearer token, so restCtx is the proxy's default context (the
      // bound vault) and reading through it was serving vault B's share
      // from vault A's filesystem via fuzzy fallback.
      const shareVault = link.vault_id ? lookupVaultById(link.vault_id) : null;
      if (!shareVault) {
        // Legacy row whose backfill failed, or a manually-inserted row
        // with a bad vault_id. Fail closed.
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const shareCtx = contextFromRoute(shareVault);

      // Read the note content from disk. `exact: true` disables
      // resolveNote's BM25 / alias / basename fuzzy fallbacks — a share
      // URL encodes a specific note path, so fuzzy resolution is a
      // cross-boundary leak vector (wrong-vault notes that happen to
      // share a basename would otherwise be served publicly).
      let noteContent: string | null = null;
      let noteTitle: string | null = null;
      try {
        const note = await handleGetNote(shareCtx, link.note_path, null, { exact: true });
        if (note) {
          noteContent = note.content;
          noteTitle = (note.frontmatter?.title as string) ?? link.note_path.replace(/\.md$/, "").split("/").pop() ?? null;
        }
      } catch {
        // Note may have been deleted — still return the share metadata
      }

      // Resolve the owner's handle so legacy `/s/:id` pages can 301 to
      // the canonical `/@<handle>/s/:id` shape (P16-3).
      const owner = getUserById(link.created_by);
      const ownerHandle = owner?.username ?? null;

      sendJson(res, 200, {
        id: link.id,
        note_path: link.note_path,
        title: noteTitle,
        content: noteContent,
        expires_at: link.expires_at,
        view_count: link.view_count,
        max_views: link.max_views,
        owner_handle: ownerHandle,
      });
      return;
    }

    // GET /v1/trails/:id/info — public trail info (unauthenticated)
    const trailInfoMatch = restPath.match(/^\/v1\/trails\/([^/]+)\/info$/);
    if (trailInfoMatch && req.method === "GET") {
      const trailId = decodeURIComponent(trailInfoMatch[1]);
      // Scope to the TRAIL'S vault — not `restCtx` (which is the
      // proxy's default on this unauthenticated path). Otherwise the
      // trail's note_count is computed over the wrong vault's
      // filesystem and the trail-page preview shows the wrong
      // content.
      const db = getDb();
      const trailRow = db
        .prepare("SELECT vault_id FROM trails WHERE id = ? LIMIT 1")
        .get(trailId) as { vault_id: string } | undefined;
      let infoCtx: VaultContext = restCtx;
      if (trailRow?.vault_id) {
        const trailVault = lookupVaultById(trailRow.vault_id);
        if (trailVault) infoCtx = contextFromRoute(trailVault);
      }
      const info = handleTrailInfo(infoCtx, trailId);
      if (!info) {
        sendJson(res, 404, { error: "trail not found" });
        return;
      }
      sendJson(res, 200, info);
      return;
    }

    // GET /v1/residents/:handle — public resident profile (unauthenticated, P16-1)
    const residentMatch = restPath.match(/^\/v1\/residents\/([^/]+)$/);
    if (residentMatch && req.method === "GET") {
      // CORS: allow any origin — profile pages render signed-out too.
      res.setHeader("Access-Control-Allow-Origin", "*");
      const handle = decodeURIComponent(residentMatch[1]);
      const profile = handleResidentProfile(restCtx, handle);
      if (!profile) {
        sendJson(res, 404, { error: "resident not found" });
        return;
      }
      sendJson(res, 200, profile);
      return;
    }

    // Auth — Bearer token required
    const restAuth = req.headers.authorization;
    const restToken = restAuth?.startsWith("Bearer ") ? restAuth.slice(7) : null;
    if (!restToken) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const restKey = validateToken(restToken);
    if (!restKey) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Rate limit (REST bucket — write bucket for PUT/POST/DELETE/PATCH, read bucket otherwise)
    const restRateBucket = (req.method === "PUT" || req.method === "POST" || req.method === "DELETE" || req.method === "PATCH")
      ? "write" as const
      : "read" as const;
    const restRateResult = rateLimiter.check(restKey.id, restRateBucket);
    if (!restRateResult.allowed) {
      res.writeHead(429, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "rate_limited", retry_after_ms: restRateResult.retryAfterMs }));
      return;
    }
    rateLimiter.record(restKey.id, restRateBucket);

    const restHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN };

    // Resolve trail for this key (null = owner, full access)
    const restTrail = resolveTrail(restKey.id);

    // GET /v1/whoami — return identity for the current token
    if (restPath === "/v1/whoami" && req.method === "GET") {
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify({
        key_id: restKey.id,
        key_name: restKey.name,
        scopes: restKey.scopes.split(",").filter(Boolean),
        vault_id: restKey.vault_id,
        trail: restTrail ? { id: restTrail.id, name: restTrail.name } : null,
      }));
      return;
    }

    // GET /v1/me — current user profile (P15-1)
    if (restPath === "/v1/me" && req.method === "GET") {
      const user = getUserById(restKey.user_id);
      if (!user) {
        res.writeHead(404, restHeaders);
        res.end(JSON.stringify({ error: "user not found" }));
        return;
      }

      // Keys owned by this user
      const db = getDb();
      const keys = db
        .prepare(
          "SELECT id, name, scopes, vault_id, created_at, last_used_at, expires_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
        )
        .all(user.id) as Array<{
          id: string; name: string; scopes: string; vault_id: string;
          created_at: string; last_used_at: string | null; expires_at: string | null;
        }>;

      // Trails accessible to this user (via trail_grants → api_keys)
      const trailRows = db
        .prepare(
          `SELECT DISTINCT t.id, t.name, t.description, t.enabled
             FROM trails t
             JOIN trail_grants tg ON t.id = tg.trail_id
             JOIN api_keys ak ON tg.grantee_id = ak.id AND tg.grantee_type = 'token'
            WHERE ak.user_id = ?`,
        )
        .all(user.id) as Array<{ id: string; name: string; description: string; enabled: number }>;

      // Flag the session that minted the bearer key as the caller's current device.
      const currentSessionRow = db
        .prepare("SELECT session_id FROM api_keys WHERE id = ?")
        .get(restKey.id) as { session_id: string | null } | undefined;
      const currentSessionId = currentSessionRow?.session_id ?? null;

      // P8-B3/B4 — vaults the caller has access to (via vault_members). Each
      // entry carries the owner's handle so grove-www can build `@<handle>/
      // <slug>/...` URLs without a second round-trip.
      const vaults = db
        .prepare(
          `SELECT v.id, v.slug, v.display_name AS name, v.created_at,
                  vm.role, vm.joined_at, vm.last_active_at,
                  ou.username AS owner_handle
             FROM vault_members vm
             JOIN vaults v  ON v.id  = vm.vault_id
             JOIN users  ou ON ou.id = v.owner_id
            WHERE vm.user_id = ?
            ORDER BY vm.last_active_at DESC, vm.joined_at DESC`,
        )
        .all(user.id) as Array<{
          id: string; slug: string; name: string; created_at: string;
          role: string; joined_at: string; last_active_at: string | null;
          owner_handle: string;
        }>;

      res.writeHead(200, restHeaders);
      res.end(JSON.stringify({
        id: user.id,
        username: user.username,
        handle: user.username,
        email: user.email,
        role: user.role,
        display_name: user.display_name,
        bio: user.bio,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
        keys: keys.map((k) => ({
          ...k,
          scopes: k.scopes.split(",").filter(Boolean),
        })),
        trails: trailRows.map((t) => ({ id: t.id, name: t.name, description: t.description, enabled: !!t.enabled })),
        vaults,
        sessions: listUserSessions(user.id).map((s) => ({
          ...s,
          is_current: s.id === currentSessionId,
        })),
      }));
      return;
    }

    // PATCH /v1/me — update display name, handle, or bio (P15-1, P16-1)
    if (restPath === "/v1/me" && req.method === "PATCH") {
      let body: string;
      try { body = await readBody(req); } catch {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "read error" }));
        return;
      }
      let parsed: { display_name?: string; handle?: string; bio?: string | null };
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }

      const response: Record<string, unknown> = { ok: true };

      if (typeof parsed.display_name === "string") {
        if (parsed.display_name.length > 100) {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: "display_name too long (max 100 chars)" }));
          return;
        }
        const updated = updateUserDisplayName(restKey.user_id, parsed.display_name);
        if (!updated) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "user not found" }));
          return;
        }
        response.display_name = parsed.display_name;
      }

      if (typeof parsed.handle === "string") {
        let oldHandle: string | null = null;
        try {
          oldHandle = changeUserHandle(restKey.user_id, parsed.handle);
        } catch (err) {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }
        if (oldHandle !== null) {
          auditUserAction(rid, restKey.user_id, "handle_change", {
            old_handle: oldHandle,
            new_handle: parsed.handle,
          });
        }
        response.handle = parsed.handle;
      }

      if (parsed.bio !== undefined) {
        const value = parsed.bio === null ? null : String(parsed.bio);
        if (value !== null && value.length > 280) {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: "bio too long (max 280 chars)" }));
          return;
        }
        try {
          updateUserBio(restKey.user_id, value);
        } catch (err) {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }
        response.bio = value;
      }

      if (Object.keys(response).length === 1) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "no updatable fields provided (display_name, handle, bio)" }));
        return;
      }

      res.writeHead(200, restHeaders);
      res.end(JSON.stringify(response));
      return;
    }

    // DELETE /v1/me/sessions/:id — revoke a single session (P15-1)
    const sessionMatch = restPath.match(/^\/v1\/me\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "DELETE") {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const revoked = revokeUserSession(restKey.user_id, sessionId);
      if (!revoked) {
        res.writeHead(404, restHeaders);
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify({ ok: true, revoked: sessionId }));
      return;
    }

    // DELETE /v1/me/sessions — revoke all sessions except current (P15-1)
    if (restPath === "/v1/me/sessions" && req.method === "DELETE") {
      // Resolve the caller's current session via the bearer key's session_id so the
      // client doesn't have to supply it (and can't accidentally log itself out).
      const explicitKeep = (url.searchParams.get("keep") ?? "").trim();
      let keep = explicitKeep;
      if (!keep) {
        const row = getDb()
          .prepare("SELECT session_id FROM api_keys WHERE id = ?")
          .get(restKey.id) as { session_id: string | null } | undefined;
        keep = row?.session_id ?? "";
      }
      const removed = revokeAllOtherSessions(restKey.user_id, keep);
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify({ ok: true, revoked_count: removed }));
      return;
    }

    // Vault lock gate — data endpoints return 503 when vault is encrypted + locked
    if (isVaultLocked(restKey.vault_id)) {
      sendLocked(res);
      return;
    }

    // GET /v1/notes/* — fetch a single note with resolved links and backlinks
    if (restPath.startsWith("/v1/notes/") && req.method === "GET") {
      const notePath = decodeURIComponent(restPath.slice("/v1/notes/".length));
      if (!notePath || notePath.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }

      structuredLog("info", "rest.get_note", rid, { key_id: restKey.id, key_name: restKey.name, path: notePath });
      try {
        const note = await handleGetNote(restCtx, notePath, restTrail);
        if (!note) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        // ETag is source_hash (stable across discovery mutations) so
        // If-Match round-trips still validate after the worker has
        // rewritten wikilinks. content_hash is still present in the body
        // for clients that care about the on-disk form.
        res.writeHead(200, { ...restHeaders, "ETag": `"${note.source_hash}"` });
        res.end(JSON.stringify(note));
      } catch (err) {
        console.error("[rest] get_note error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // PUT /v1/notes/* — create or update a note
    if (restPath.startsWith("/v1/notes/") && req.method === "PUT") {
      const notePath = decodeURIComponent(restPath.slice("/v1/notes/".length));
      if (!notePath || notePath.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }

      // Read and parse JSON body
      let body: string;
      try { body = await readBody(req); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") {
          res.writeHead(413, restHeaders);
          res.end(JSON.stringify({ error: "payload too large" }));
          return;
        }
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "read error" }));
        return;
      }
      let parsed: { frontmatter?: Record<string, unknown>; content?: string };
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!parsed.frontmatter || typeof parsed.frontmatter !== "object" || typeof parsed.content !== "string") {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "body must have frontmatter (object) and content (string)" }));
        return;
      }

      // If-Match header → optimistic concurrency (strip quotes per HTTP ETag spec)
      const ifMatchRaw = req.headers["if-match"];
      const ifMatch = typeof ifMatchRaw === "string" ? ifMatchRaw.replace(/^"|"$/g, "") : undefined;

      structuredLog("info", "rest.put_note", rid, { key_id: restKey.id, key_name: restKey.name, path: notePath });
      try {
        const result = await handleWriteNote(restCtx, notePath, parsed.frontmatter, parsed.content, {
          ifHash: ifMatch,
          trail: restTrail,
          keyName: restKey.name,
        });
        const status = result.action === "create" ? 201 : 200;
        res.writeHead(status, { ...restHeaders, "ETag": `"${result.source_hash}"` });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        if (err.code === "TRAIL_DENIED") {
          res.writeHead(403, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "CONFLICT") {
          res.writeHead(409, restHeaders);
          res.end(JSON.stringify({ error: err.message, current_hash: err.currentHash }));
        } else if (err.code === "VALIDATION") {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: err.message, errors: err.errors }));
        } else {
          console.error("[rest] put_note error:", err);
          res.writeHead(500, restHeaders);
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
      return;
    }

    // DELETE /v1/notes/* — soft delete (archive) by default, hard delete with ?hard=true
    if (restPath.startsWith("/v1/notes/") && req.method === "DELETE") {
      const notePath = decodeURIComponent(restPath.slice("/v1/notes/".length));
      if (!notePath || notePath.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }

      const hard = url.searchParams.get("hard") === "true";
      const ifMatchRaw = req.headers["if-match"];
      const ifMatch = typeof ifMatchRaw === "string" ? ifMatchRaw.replace(/^"|"$/g, "") : undefined;

      structuredLog("info", "rest.delete_note", rid, { key_id: restKey.id, key_name: restKey.name, path: notePath, hard });
      try {
        const result = await handleDeleteNote(restCtx, notePath, {
          hard,
          ifHash: ifMatch,
          trail: restTrail,
          keyName: restKey.name,
        });
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify(result));
      } catch (err: any) {
        if (err.code === "NOT_FOUND") {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "TRAIL_DENIED") {
          res.writeHead(403, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "CONFLICT") {
          res.writeHead(409, restHeaders);
          res.end(JSON.stringify({ error: err.message, current_hash: err.currentHash }));
        } else if (err.code === "VALIDATION") {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: err.message, errors: err.errors }));
        } else {
          console.error("[rest] delete_note error:", err);
          res.writeHead(500, restHeaders);
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
      return;
    }

    // PATCH /v1/notes/* — currently only supports { move_to: <new-path> }
    if (restPath.startsWith("/v1/notes/") && req.method === "PATCH") {
      const notePath = decodeURIComponent(restPath.slice("/v1/notes/".length));
      if (!notePath || notePath.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }

      let body: string;
      try { body = await readBody(req); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") {
          res.writeHead(413, restHeaders);
          res.end(JSON.stringify({ error: "payload too large" }));
          return;
        }
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "read error" }));
        return;
      }
      let parsed: { move_to?: string };
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (typeof parsed.move_to !== "string" || !parsed.move_to) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "body must have move_to (string)" }));
        return;
      }

      const ifMatchRaw = req.headers["if-match"];
      const ifMatch = typeof ifMatchRaw === "string" ? ifMatchRaw.replace(/^"|"$/g, "") : undefined;

      structuredLog("info", "rest.move_note", rid, { key_id: restKey.id, key_name: restKey.name, from: notePath, to: parsed.move_to });
      try {
        const result = await handleMoveNote(restCtx, notePath, parsed.move_to, {
          ifHash: ifMatch,
          trail: restTrail,
          keyName: restKey.name,
        });
        res.writeHead(200, { ...restHeaders, "ETag": `"${result.source_hash}"` });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        if (err.code === "NOT_FOUND") {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "TRAIL_DENIED") {
          res.writeHead(403, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "CONFLICT") {
          res.writeHead(409, restHeaders);
          res.end(JSON.stringify({ error: err.message, current_hash: err.currentHash }));
        } else if (err.code === "VALIDATION") {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: err.message, errors: err.errors }));
        } else {
          console.error("[rest] move_note error:", err);
          res.writeHead(500, restHeaders);
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
      return;
    }

    // POST /v1/images — upload an image + companion note
    if (restPath === "/v1/images" && req.method === "POST") {
      const boundary = parseBoundary(req.headers["content-type"]);
      if (!boundary) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "expected multipart/form-data with boundary" }));
        return;
      }

      let raw: Buffer;
      try { raw = await readBodyBuffer(req, MAX_IMAGE_BODY); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") {
          res.writeHead(413, restHeaders);
          res.end(JSON.stringify({ error: "payload too large (max 10MB)" }));
          return;
        }
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "read error" }));
        return;
      }

      let fields;
      try { fields = parseMultipart(raw, boundary); } catch (err: unknown) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: `invalid multipart: ${(err as Error).message}` }));
        return;
      }

      const fileField = fields.find((f) => f.name === "file");
      if (!fileField || !fileField.contentType) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "missing 'file' field" }));
        return;
      }
      const pathField = fields.find((f) => f.name === "path");
      const tagsField = fields.find((f) => f.name === "tags");
      const pathValue = pathField?.data.toString("utf-8").trim();
      const tagsValue = tagsField?.data.toString("utf-8").trim();

      structuredLog("info", "rest.image_upload", rid, {
        key_id: restKey.id,
        key_name: restKey.name,
        content_type: fileField.contentType,
        size: fileField.data.length,
      });

      try {
        const result = await handleImageUpload(
          restCtx,
          {
            file: fileField.data,
            contentType: fileField.contentType,
            filename: fileField.filename,
            path: pathValue || undefined,
            tags: tagsValue ? tagsValue.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          },
          { trail: restTrail, keyName: restKey.name },
        );
        res.writeHead(201, restHeaders);
        res.end(JSON.stringify(result));
      } catch (err: any) {
        if (err.code === "TRAIL_DENIED") {
          res.writeHead(403, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else if (err.code === "VALIDATION") {
          res.writeHead(400, restHeaders);
          res.end(JSON.stringify({ error: err.message, errors: err.errors }));
        } else if (err.code === "PAYLOAD_TOO_LARGE") {
          res.writeHead(413, restHeaders);
          res.end(JSON.stringify({ error: err.message }));
        } else {
          console.error("[rest] image_upload error:", err);
          res.writeHead(500, restHeaders);
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
      return;
    }

    // GET /v1/search?q=...&limit=N — hybrid search
    if (restPath === "/v1/search" && req.method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 50);
      if (!query) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "missing q parameter" }));
        return;
      }

      structuredLog("info", "rest.search", rid, { key_id: restKey.id, key_name: restKey.name, query, limit });
      try {
        const results = await handleSearch(restCtx, query, limit, restTrail);
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ results }));
      } catch (err) {
        if (err instanceof VaultLockedError) {
          res.writeHead(503, restHeaders);
          res.end(JSON.stringify({ error: "vault_locked", message: err.message }));
          return;
        }
        console.error("[rest] search error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // GET /v1/list?prefix=&type=... — list notes under a path prefix, optionally filtered by frontmatter type
    if (restPath === "/v1/list" && req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const type = url.searchParams.get("type");
      if (prefix.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid prefix" }));
        return;
      }

      structuredLog("info", "rest.list", rid, { key_id: restKey.id, key_name: restKey.name, prefix, type: type ?? undefined });
      try {
        const entries = handleListNotes(restCtx, prefix, restTrail, type);
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ prefix, type: type ?? null, entries }));
      } catch (err) {
        console.error("[rest] list error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // GET /v1/stats?sections=vault,graph — vault analytics
    if (restPath === "/v1/stats" && req.method === "GET") {
      const sectionsParam = url.searchParams.get("sections");
      const sections = sectionsParam ? sectionsParam.split(",").map(s => s.trim()) : undefined;

      // Admin check: owner keys (no trail) get search stats
      const isAdmin = !restTrail;

      structuredLog("info", "rest.stats", rid, { key_id: restKey.id, key_name: restKey.name, sections: sections?.join(",") });

      const stats = handleStats(restCtx, sections, restTrail, isAdmin);
      if (!stats) {
        res.writeHead(503, restHeaders);
        res.end(JSON.stringify({ error: "stats not yet computed, try again shortly" }));
        return;
      }
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify(stats));
      return;
    }

    // GET /v1/status/:mode — vault status endpoints
    const statusMatch = restPath.match(/^\/v1\/status\/([a-z]+)$/);
    if (statusMatch && req.method === "GET") {
      const mode = statusMatch[1] as StatusMode;
      if (!VALID_STATUS_MODES.has(mode)) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: `invalid mode: ${mode}`, valid: [...VALID_STATUS_MODES] }));
        return;
      }

      structuredLog("info", "rest.status", rid, { key_id: restKey.id, key_name: restKey.name, mode });

      try {
        let result: Record<string, unknown> | null;

        switch (mode) {
          case "health":
            result = handleStatusHealth(restCtx, restTrail);
            if (!result) {
              res.writeHead(503, restHeaders);
              res.end(JSON.stringify({ error: "stats not yet computed, try again shortly" }));
              return;
            }
            break;
          case "history": {
            const since = url.searchParams.get("since") ?? undefined;
            const pathPrefix = url.searchParams.get("path_prefix") ?? undefined;
            result = await handleStatusHistory(restCtx, since, pathPrefix);
            break;
          }
          case "diagnostics":
            result = handleStatusDiagnostics(restCtx, );
            break;
          case "digest":
            result = await handleStatusDigest(restCtx, );
            break;
        }

        res.writeHead(200, restHeaders);
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[rest] status/${mode} error:`, err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // POST /v1/admin/trails — list, create, update, delete (admin only)
    if (restPath === "/v1/admin/trails" && req.method === "POST") {
      if (restTrail || getUserRole(restKey.user_id) !== "owner") {
        // Trail-scoped keys and non-owners cannot manage trails
        res.writeHead(403, restHeaders);
        res.end(JSON.stringify({ error: "admin access required" }));
        return;
      }

      let body: string;
      try { body = await readBody(req); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") {
          res.writeHead(413, restHeaders);
          res.end(JSON.stringify({ error: "payload too large" }));
          return;
        }
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "read error" }));
        return;
      }
      let parsed: any;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }

      if (parsed.action === "list") {
        // Scope to the URL's vault when we arrived via
        // `/v/<slug>/v1/admin/trails` so a multi-vault owner sees only
        // that vault's trails. Legacy unscoped `/v1/admin/trails` still
        // returns every trail.
        const trails = loadTrails(restIsVaultScoped ? restCtx.vaultId : undefined);
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ trails }));
        return;
      }

      if (parsed.action === "create" && parsed.name) {
        // Bind the new trail (and its read key) to the request's vault.
        // When the caller arrived via `/v/<slug>/v1/admin/trails`,
        // `restCtx.vaultId` is that vault. On the legacy unscoped
        // path, we still fall back to the proxy's default so the
        // legacy CLI flow keeps working.
        const result = createTrail({
          name: parsed.name,
          description: parsed.description,
          allow_tags: parsed.allow_tags,
          deny_tags: parsed.deny_tags,
          allow_types: parsed.allow_types,
          deny_types: parsed.deny_types,
          allow_paths: parsed.allow_paths,
          deny_paths: parsed.deny_paths,
          rate_limit_reads: parsed.rate_limit_reads,
          rate_limit_writes: parsed.rate_limit_writes,
          vault_id: restCtx.vaultId,
        });
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ trail: result.trail, token: result.token }));
        return;
      }

      if (parsed.action === "update" && parsed.id) {
        const { id, action, ...updates } = parsed;
        const ok = updateTrail(id, updates);
        if (!ok) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "trail not found" }));
          return;
        }
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ updated: id }));
        return;
      }

      if (parsed.action === "delete" && parsed.id) {
        const ok = deleteTrail(parsed.id);
        if (!ok) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "trail not found" }));
          return;
        }
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ deleted: parsed.id }));
        return;
      }

      res.writeHead(400, restHeaders);
      res.end(JSON.stringify({ error: "invalid action" }));
      return;
    }

    // GET /v1/admin/trails/:id/preview — live preview of notes matching a proposed scope (admin only)
    // :id is for context only; the scope comes from query params so new trails can be previewed too.
    const trailPreviewMatch = restPath.match(/^\/v1\/admin\/trails\/([^/]+)\/preview$/);
    if (trailPreviewMatch && req.method === "GET") {
      if (restTrail || getUserRole(restKey.user_id) !== "owner") {
        res.writeHead(403, restHeaders);
        res.end(JSON.stringify({ error: "admin access required" }));
        return;
      }

      const parseCsv = (v: string | null): string[] => {
        if (!v) return [];
        return v.split(",").map((s) => s.trim()).filter(Boolean);
      };

      const scope = {
        allow_tags: parseCsv(url.searchParams.get("allow_tags")),
        deny_tags: parseCsv(url.searchParams.get("deny_tags")),
        allow_types: parseCsv(url.searchParams.get("allow_types")),
        deny_types: parseCsv(url.searchParams.get("deny_types")),
        allow_paths: parseCsv(url.searchParams.get("allow_paths")),
        deny_paths: parseCsv(url.searchParams.get("deny_paths")),
      };

      const testPath = url.searchParams.get("test_path");
      if (testPath) {
        const result = handleTrailPreviewTest(restCtx, testPath, scope);
        if (!result) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "note not found" }));
          return;
        }
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify(result));
        return;
      }

      const sampleLimitRaw = url.searchParams.get("sample_limit");
      const sampleLimit = sampleLimitRaw ? Math.max(0, Math.min(100, parseInt(sampleLimitRaw, 10) || 10)) : 10;
      const result = handleTrailPreview(restCtx, scope, sampleLimit);
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /v1/admin/trails/:id/usage — per-trail usage metrics (admin only)
    const trailUsageMatch = restPath.match(/^\/v1\/admin\/trails\/([^/]+)\/usage$/);
    if (trailUsageMatch && req.method === "GET") {
      const auth = adminAuth(req, restCtx.vaultId);
      if (!auth.ok) {
        res.writeHead(auth.status, restHeaders);
        res.end(JSON.stringify({ error: auth.status === 403 ? "forbidden" : "unauthorized" }));
        return;
      }
      const trailId = decodeURIComponent(trailUsageMatch[1]!);
      const trails = loadTrails();
      const trail = trails.find((t) => t.id === trailId);
      if (!trail) {
        res.writeHead(404, restHeaders);
        res.end(JSON.stringify({ error: "trail not found" }));
        return;
      }
      const trailMetrics = metrics.getTrailMetrics(trailId);
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify({
        trail_id: trailId,
        name: trail.name,
        requests: trailMetrics?.requests ?? 0,
        reads: trailMetrics?.reads ?? 0,
        writes: trailMetrics?.writes ?? 0,
        last_request_at: trailMetrics?.last_request_at ?? null,
      }));
      return;
    }

    // Unknown /v1/ route
    res.writeHead(404, restHeaders);
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // Auth check for MCP and other endpoints
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    structuredLog("warn", "auth.missing", rid, { method: req.method, path: req.url, status: 401 });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${GROVE_URL}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const key = validateToken(token);
  if (!key) {
    structuredLog("warn", "auth.invalid", rid, { method: req.method, path: req.url, status: 401 });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${GROVE_URL}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const reqStart = Date.now();
  const sessionId = req.headers["mcp-session-id"];
  const sessionStr = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // Trail resolution — look up if this key is associated with a trail
  const trail = resolveTrail(key.id);

  // P8-A2: vault routing. Parse the URL into (slug, rest, isLegacy) and
  // decide which backend to forward to. `/v/<slug>/mcp` routes to the
  // matching vault's server_port; legacy `/mcp` and `/v1/*` route to the
  // token's bound vault with a Sunset header. Unknown slugs or token/slug
  // mismatches both return 403 (never 404 — 404 would leak which vault
  // slugs exist).
  const vaultParsed = parseVaultPath(url.pathname);
  const routeDecision = decideRoute(vaultParsed, key.vault_id, key.user_id);

  // Vault-scoped URLs (/v/<slug>/*) MUST decide to "route" — anything else
  // is a 403. For legacy paths (no /v/<slug>/) the decision comes back as
  // "legacy" and we add a Sunset header on the way out.
  if (vaultParsed.slug !== null && routeDecision.kind !== "route") {
    structuredLog("warn", "vault.route_denied", rid, {
      key_id: key.id,
      key_name: key.name,
      url_slug: vaultParsed.slug,
      token_vault_id: key.vault_id,
      reason: routeDecision.reason,
      status: 403,
    });
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  // Pick the backend port for this request:
  // - /v/<slug>/mcp → decision.vault.server_port (vault-scoped)
  // - /mcp legacy → decision.vault.server_port (the token's vault)
  // - fallback (decision.vault missing somehow) → GROVE_SERVER_PORT env default
  const routedVault =
    routeDecision.kind === "route" || routeDecision.kind === "legacy"
      ? routeDecision.vault ?? null
      : null;
  const backendPort = routedVault?.server_port ?? GROVE_SERVER_PORT;
  const backendPath = vaultParsed.rest; // strips /v/<slug>/ prefix
  const isLegacyVaultPath = routeDecision.kind === "legacy";
  const vaultSunsetHeader = isLegacyVaultPath ? sunsetDate() : null;

  // Vault-scoped URLs (/v/<slug>/*) only support /mcp today. REST handlers
  // in this proxy read a single VAULT_PATH at module load — they aren't
  // request-scoped yet. Reject /v/<slug>/v1/* etc. so callers don't hit a
  // confusing QMD fallback; 404 is honest about "not implemented for this
  // scope". Legacy (non-slug) paths fall through to the existing handlers
  // unchanged.
  if (vaultParsed.slug !== null && backendPath !== "/mcp") {
    // /v/<slug>/v1/* and /v/<slug>/health are handled in earlier blocks
    // (the REST preprocessing + the pre-auth health route). Anything else
    // under /v/<slug>/ is unrecognized — 404 to avoid leaking it through
    // to the legacy QMD fallback below.
    structuredLog("info", "vault.scoped_path_not_recognized", rid, {
      key_id: key.id,
      key_name: key.name,
      url_slug: vaultParsed.slug,
      rest_path: backendPath,
      status: 404,
    });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // Forward ALL MCP requests to the Grove server (which owns all 6 tools)
  if (backendPath === "/mcp") {
    let body = "";
    if (req.method === "POST") {
      try { body = await readBody(req); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") { sendJson(res, 413, { error: "payload too large" }); return; }
        sendJson(res, 400, { error: "read error" }); return;
      }
    }
    let parsed: any = null;
    if (body) try { parsed = JSON.parse(body); } catch {
      // Non-JSON body is fine — we only parse for logging metadata extraction
    }

    const mcpMethod = parsed?.method ?? req.method;
    const toolName = parsed?.params?.name ?? null;
    structuredLog("info", "mcp.request", rid, { key_id: key.id, key_name: key.name, method: req.method, path: "/mcp", mcp_method: mcpMethod, tool: toolName });

    // Per-trail rate limits
    if (trail) {
      const isTrailWrite = mcpMethod === "tools/call" && toolName === "write_note";
      const trailLimit = isTrailWrite
        ? (trail.rate_limit_writes ?? 20)
        : (trail.rate_limit_reads ?? 60);
      const trailRateResult = rateLimiter.checkWithLimit(
        `trail:${trail.id}`,
        isTrailWrite ? "write" : "read",
        trailLimit,
      );
      if (!trailRateResult.allowed) {
        structuredLog("warn", "trail.rate_limited", rid, { trail_id: trail.id, trail_name: trail.name, type: isTrailWrite ? "write" : "read" });
        sendJson(res, 429, { error: "trail rate limit exceeded", retry_after_ms: trailRateResult.retryAfterMs });
        return;
      }
      rateLimiter.record(`trail:${trail.id}`, isTrailWrite ? "write" : "read");
    }

    // Audit read/write tool calls
    if (mcpMethod === "tools/call" && toolName) {
      const toolArgs = parsed?.params?.arguments;
      if (toolName === "write_note") {
        auditWrite(rid, key.id, key.name, toolName, toolArgs, null);
      } else {
        auditRead(rid, key.id, key.name, toolName, toolArgs);
      }
    }

    // Vault lock gate — reject data tool calls when vault is encrypted + locked
    if (mcpMethod === "tools/call" && isVaultLocked(key.vault_id)) {
      sendLocked(res);
      return;
    }

    // Scope enforcement — reject write tools if key lacks 'write' scope
    if (mcpMethod === "tools/call" && toolName === "write_note") {
      const keyScopes = key.scopes.split(",");
      if (!keyScopes.includes("write")) {
        structuredLog("warn", "auth.scope_denied", rid, { key_id: key.id, key_name: key.name, tool: toolName });
        sendJson(res, 403, { error: "scope_denied", detail: "key lacks 'write' scope" });
        return;
      }
    }

    // Rate limit tool calls
    const isMcpWrite = mcpMethod === "tools/call" && toolName === "write_note";
    if (mcpMethod === "tools/call" && toolName) {
      const { allowed, retryAfterMs } = rateLimiter.check(key.id, isMcpWrite ? "write" : "read");
      if (!allowed) {
        sendJson(res, 429, { error: "rate_limited", retry_after_ms: retryAfterMs });
        return;
      }
      rateLimiter.record(key.id, isMcpWrite ? "write" : "read");
    }

    // P8-A6: bump per-vault request + write counters. Flushed to
    // vault_usage_daily every 60s by the startup timer below.
    try {
      const vu = await import("./vault-usage.js");
      vu.bumpRequest(key.vault_id);
      if (isMcpWrite) vu.bumpWrite(key.vault_id);
    } catch {
      // counter failure must never block the request path
    }

    // P8-A3: capture vault_id outside the closure so TypeScript's narrowing
    // holds — inside groveHeaders, `key` is through a closure and narrowing
    // would be lost otherwise.
    //
    // Use the ROUTED vault's id when a vault route was resolved (both
    // `/v/<slug>/...` and legacy paths produce a routed vault). The
    // backend process is pinned to one `GROVE_VAULT_ID` and rejects
    // requests whose `X-Grove-Vault-Id` doesn't match — sending the
    // token's bound vault would 403 when a session key on its primary
    // vault authenticates into one of the user's other vaults via
    // `userIsVaultMember`.
    const authedVaultId = routedVault?.id ?? key.vault_id;

    // Build headers for Grove server (strip auth, add Accept, pass correlation ID + trail info, optionally strip stale session)
    function groveHeaders(stripSession = false): Record<string, string> {
      const h: Record<string, string> = {
        "Accept": "application/json, text/event-stream",
        "X-Request-Id": rid,
        // tell the backend which vault the authenticated token is bound to.
        // grove-server compares this to its pinned GROVE_VAULT_ID env and
        // refuses cross-vault requests.
        "X-Grove-Vault-Id": authedVaultId,
      };
      if (trail) {
        h["X-Trail-Id"] = trail.id;
        h["X-Trail-Config"] = JSON.stringify({
          id: trail.id,
          name: trail.name,
          allow_tags: trail.allow_tags,
          deny_tags: trail.deny_tags,
          allow_types: trail.allow_types,
          deny_types: trail.deny_types,
          allow_paths: trail.allow_paths,
          deny_paths: trail.deny_paths,
          rate_limit_writes: trail.rate_limit_writes,
        });
      }
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "authorization" || k === "host") continue;
        if (stripSession && k === "mcp-session-id") continue;
        if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      return h;
    }

    // Proxy to Grove server, piping response headers and body through
    // If Grove returns 400 (invalid/stale session), retry without session ID to create a new one
    const groveReq = httpRequest(
      { hostname: "127.0.0.1", port: backendPort, path: "/mcp", method: req.method, headers: groveHeaders() },
      (groveRes) => {
        // If stale session → initialize a new session, then replay the request
        if (groveRes.statusCode === 400 && sessionStr && req.method === "POST") {
          groveRes.resume();
          console.log("[proxy] stale session, initializing new Grove session");

          // Step 1: send initialize to get a new session.
          // MUST forward X-Grove-Vault-Id — since P8 (PR #26) grove-server
          // refuses any request without it when GROVE_VAULT_ID is pinned,
          // which is the default in prod. Prior to this, init silently got
          // a 403 with no mcp-session-id header and every claude.ai query
          // errored "Error occurred during tool execution" until the user
          // disconnected and reconnected. See project_stale_mcp_session.md.
          const initBody = JSON.stringify({
            jsonrpc: "2.0", id: "proxy-init",
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "grove-proxy", version: "1" } },
          });
          const initReq = httpRequest(
            { hostname: "127.0.0.1", port: backendPort, path: "/mcp", method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": String(Buffer.byteLength(initBody)),
                "X-Grove-Vault-Id": authedVaultId,
                "X-Request-Id": rid,
              } },
            (initRes) => {
              let initData = "";
              const newSession = initRes.headers["mcp-session-id"] as string | undefined;
              initRes.on("data", (c) => initData += c);
              initRes.on("end", () => {
                if (!newSession) {
                  // Surface status + body snippet so future failures are
                  // diagnosable from logs alone. Without this, every failure
                  // looks identical regardless of root cause.
                  console.error(
                    `[proxy] failed to get new session from Grove: status=${initRes.statusCode} body=${initData.slice(0, 200)}`,
                  );
                  pipeGroveResponse(groveRes); // fall back to original error
                  return;
                }
                console.log("[proxy] new session:", newSession);
                // Step 2: replay original request with new session
                const replayHeaders = groveHeaders(true);
                replayHeaders["mcp-session-id"] = newSession;
                const retryReq = httpRequest(
                  { hostname: "127.0.0.1", port: backendPort, path: "/mcp", method: "POST", headers: replayHeaders },
                  (retryRes) => pipeGroveResponse(retryRes),
                );
                retryReq.on("error", () => { if (!res.headersSent) sendJson(res, 502, { error: "Grove server unreachable" }); });
                if (body) retryReq.write(body);
                retryReq.end();
              });
            },
          );
          initReq.on("error", () => { if (!res.headersSent) sendJson(res, 502, { error: "Grove init failed" }); });
          initReq.write(initBody);
          initReq.end();
          return;
        }
        pipeGroveResponse(groveRes);
      }
    );

    function pipeGroveResponse(groveRes: import("node:http").IncomingMessage) {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(groveRes.headers)) { if (v) resHeaders[k] = v; }
      resHeaders["access-control-allow-origin"] = "*";
      resHeaders["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
      resHeaders["access-control-allow-headers"] = "Content-Type, Authorization, mcp-session-id";
      resHeaders["access-control-expose-headers"] = "mcp-session-id";
      // P8-A2: legacy `/mcp` callers get a Sunset header (RFC 8594, 90 days
      // out) so they know to migrate to `/v/<slug>/mcp`. Non-legacy paths
      // get no Sunset header.
      if (vaultSunsetHeader) {
        resHeaders["Sunset"] = vaultSunsetHeader;
        resHeaders["Deprecation"] = "true";
      }
      res.writeHead(groveRes.statusCode ?? 200, resHeaders);

      if (parsed?.method === "tools/call" && toolName) {
        let resBody = "";
        groveRes.on("data", (c) => { resBody += c; res.write(c); });
        groveRes.on("end", () => {
          res.end();
          const latency = Date.now() - reqStart;
          // Record per-trail metrics for this tool call
          const trailId = trail ? trail.id : "none";
          const isWrite = toolName === "write_note";
          metrics.recordTrailRequest(trailId, isWrite);
          try {
            logMcp(key?.name ?? "unknown", sessionStr, toolName, parsed.params.arguments, JSON.parse(resBody), latency, groveRes.statusCode ?? 200);
          } catch {
            // Response isn't valid JSON — log raw length instead for diagnostics
            logMcp(key?.name ?? "unknown", sessionStr, toolName, parsed.params.arguments, { raw_length: resBody.length }, latency, groveRes.statusCode ?? 200);
          }
        });
      } else {
        groveRes.pipe(res);
        if (mcpMethod !== "unknown") {
          groveRes.on("end", () => {
            log(key?.name ?? "unknown", req.method ?? "", "/mcp", groveRes.statusCode ?? 200, { mcp_method: mcpMethod, latency_ms: Date.now() - reqStart });
          });
        }
      }
    }

    groveReq.on("error", (err: NodeJS.ErrnoException) => {
      console.error("[proxy] Grove server error:", err.message);
      if (res.headersSent) return;
      // P8-A2: backend unreachable gets 503 + Retry-After: 5 so clients
      // don't hammer us during a grove-server restart. Other errors (e.g.
      // connection reset mid-stream) fall through to 502.
      if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "EHOSTUNREACH") {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
        res.end(JSON.stringify({ error: "vault backend unavailable", retry_after_s: 5 }));
        return;
      }
      sendJson(res, 502, { error: "Grove server unreachable" });
    });
    if (body) groveReq.write(body);
    groveReq.end();
    return;
  }

  structuredLog("info", "proxy.qmd", rid, { key_id: key.id, key_name: key.name, method: req.method, path: req.url, status: 200 });
  proxyToQmd(req, res);
});

runMigration();
seedAdminEmail();
cleanupExpiredAuth();

const VAULT_PATH_PROXY = process.env.GROVE_VAULT ?? join(homedir(), "life");
// Refresh stats for every registered vault, not just the proxy's bound
// vault — otherwise `/v/<slug>/v1/stats` for any non-primary vault
// returns the primary's numbers. Uses a thunk so newly-provisioned
// vaults picked up by SIGHUP start refreshing on the next tick without
// bouncing the timer.
startStatsTimer(() => {
  const db = getDb();
  const rows = db.prepare(`SELECT git_repo_path FROM vaults`).all() as { git_repo_path: string }[];
  const paths = new Set<string>(rows.map((r) => r.git_repo_path).filter(Boolean));
  paths.add(VAULT_PATH_PROXY);
  return [...paths];
});

const keyCount = getDb().prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };

// P8-A2: load the vault slug→port map on startup. SIGHUP below reloads it
// so operators can provision new vaults without restarting the proxy.
// Loaded synchronously so the very first request can route correctly — a
// dynamic import leaves the map empty during the async window, and any
// request that lands then would get a 403 from decideRoute.
try {
  const n = loadVaultMap();
  console.log(`[grove] vault-router loaded ${n} vault(s)`);
} catch (err) {
  console.error(`[grove] vault-router load failed: ${(err as Error).message}`);
}

// P8-A6: start the vault-usage flush timer (60s). Counts bump at request
// time; this timer upserts the accumulated state into vault_usage_daily.
import("./vault-usage.js")
  .then((vu) => {
    vu.startFlushTimer();
    console.log(`[grove] vault-usage flush timer started (60s interval)`);
  })
  .catch((err) => console.error(`[grove] vault-usage start failed: ${(err as Error).message}`));

process.on("SIGHUP", () => {
  try {
    const n = loadVaultMap();
    console.log(`[grove] vault-router reloaded on SIGHUP (${n} vault(s))`);
  } catch (err) {
    console.error(`[grove] SIGHUP reload failed: ${(err as Error).message}`);
  }
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`Grove proxy listening on http://0.0.0.0:${PROXY_PORT}`);
  console.log(`Proxying authenticated requests to QMD at http://[::1]:${QMD_PORT}`);
  console.log(`OAuth authorize: ${GROVE_URL}/oauth/authorize`);
  console.log(`Loaded ${keyCount.count} API key(s) from SQLite`);
});

// ── Graceful shutdown ────────────────────────────────────────────
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[grove-proxy] ${signal} received, shutting down...`);
    closeDb();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000);
  });
}
