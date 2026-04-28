/**
 * Stateful stub Grove server for agent-task evals. In-memory vault that
 * supports:
 *   GET  /v1/whoami                       → key info
 *   GET  /health                          → ok:true
 *   GET  /v1/search?q=...                 → substring search over content+titles
 *   GET  /v1/list?prefix=...              → prefix list with type + mod time
 *   GET  /v1/notes/<path>                 → single note with content_hash
 *   PUT  /v1/notes/<path>                 → create/update, requires If-Match on update
 *   GET  /v1/stats                        → small health snapshot
 *
 * Writes mutate the in-memory map and recompute content hashes. Deterministic:
 * same inputs → same content_hashes.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubNote {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface StubState {
  notes: Map<string, StubNote>;
}

export interface StubServer {
  baseUrl: string;
  configDir: string;
  state: StubState;
  requests: { method: string; path: string; status: number }[];
  close(): Promise<void>;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function matchesSearch(note: StubNote, q: string): boolean {
  const needle = q.toLowerCase();
  const hay = (note.path + " " + note.content + " " + JSON.stringify(note.frontmatter)).toLowerCase();
  return hay.includes(needle);
}

export async function startStatefulStub(seed: StubNote[] = []): Promise<StubServer> {
  const state: StubState = { notes: new Map() };
  for (const n of seed) state.notes.set(n.path, { ...n });
  const requests: StubServer["requests"] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url || "/", "http://stub");
      const method = req.method || "GET";
      let status = 200;
      let payload: unknown = null;

      try {
        // Auth: any bearer starting with grove_live_ is accepted.
        const auth = req.headers["authorization"] || "";
        if (!/^Bearer grove_live_/.test(auth as string)) {
          status = 401;
          payload = { error: "unauthorized" };
        } else if (method === "GET" && url.pathname === "/health") {
          payload = { ok: true, checks: { proxy: true, "grove-server": true, embed: true } };
        } else if (method === "GET" && url.pathname === "/v1/whoami") {
          payload = { key_id: "key_eval", key_name: "eval-key", scopes: ["read", "write"], vault_id: "life" };
        } else if (method === "GET" && url.pathname === "/v1/stats") {
          payload = {
            vault: { total_notes: state.notes.size },
            freshness: { fresh: true },
            graph: { total_nodes: state.notes.size, total_edges: 0 },
          };
        } else if (method === "GET" && url.pathname === "/v1/search") {
          const q = url.searchParams.get("q") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? "10");
          const results = Array.from(state.notes.values())
            .filter((n) => matchesSearch(n, q))
            .slice(0, limit)
            .map((n) => ({
              path: n.path,
              title: n.path.split("/").pop()?.replace(/\.md$/, "") ?? "",
              score: 0.9,
              snippet: n.content.slice(0, 120),
            }));
          payload = { results, count: results.length };
        } else if (method === "GET" && url.pathname === "/v1/list") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const entries = Array.from(state.notes.values())
            .filter((n) => n.path.startsWith(prefix))
            .map((n) => ({
              path: n.path,
              type: (n.frontmatter.type as string) ?? null,
              modified_at: "2026-04-20T00:00:00Z",
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
          payload = { entries, count: entries.length };
        } else if (method === "GET" && url.pathname.startsWith("/v1/notes/")) {
          const path = decodeURIComponent(url.pathname.slice("/v1/notes/".length));
          const n = state.notes.get(path);
          if (!n) {
            status = 404;
            payload = { error: `note not found: ${path}` };
          } else {
            payload = { path: n.path, frontmatter: n.frontmatter, content: n.content, content_hash: hashContent(n.content) };
          }
        } else if (method === "PUT" && url.pathname.startsWith("/v1/notes/")) {
          const path = decodeURIComponent(url.pathname.slice("/v1/notes/".length));
          const parsed = JSON.parse(body || "{}") as { frontmatter?: Record<string, unknown>; content?: string };
          const existing = state.notes.get(path);
          // If-Match check for updates.
          const ifMatch = (req.headers["if-match"] as string | undefined)?.replace(/"/g, "");
          if (existing && ifMatch) {
            const currentHash = hashContent(existing.content);
            if (ifMatch !== currentHash) {
              status = 409;
              payload = { error: "content_hash mismatch", expected: currentHash, got: ifMatch };
              return end(res, status, payload);
            }
          }
          const n: StubNote = {
            path,
            frontmatter: parsed.frontmatter ?? {},
            content: parsed.content ?? "",
          };
          state.notes.set(path, n);
          payload = {
            path,
            action: existing ? "update" : "create",
            content_hash: hashContent(n.content),
          };
        } else {
          status = 404;
          payload = { error: `no route for ${method} ${url.pathname}` };
        }
      } catch (e) {
        status = 500;
        payload = { error: String(e) };
      }

      end(res, status, payload);
      requests.push({ method, path: url.pathname + url.search, status });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("bind failed");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const configDir = mkdtempSync(join(tmpdir(), "grove-eval-"));
  chmodSync(configDir, 0o700);
  const cfgPath = join(configDir, "cli.json");
  writeFileSync(cfgPath, JSON.stringify({ server: baseUrl, token: "grove_live_evaltoken_abcdefg" }));
  chmodSync(cfgPath, 0o600);

  return {
    baseUrl,
    configDir,
    state,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        rmSync(configDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function end(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
