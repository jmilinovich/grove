/**
 * Integration test harness — spawns a stub HTTP server + the CLI as a
 * subprocess so we can assert the full argv → exit-code contract.
 *
 * Usage:
 *   const h = await harness({ routes: { "GET /v1/whoami": ... } });
 *   const r = await h.runCli(["whoami", "--format", "json"]);
 *   expect(r.exit).toBe(0);
 *   expect(JSON.parse(r.stdout).ok).toBe(true);
 *   await h.close();
 *
 * ── In-process migration plan ──
 * `npx tsx` cold-start dominates the four integration test files
 * (~22s of total test time). The audit recommends invoking the CLI
 * in-process: import a programmatic `runCli(argv, env)` from
 * src/cli.ts that returns { exit, stdout, stderr } without calling
 * process.exit, then keep one subprocess test as a "binary boots"
 * smoke.
 *
 * The blocker is that src/cli.ts:main() reads process.argv directly
 * and sprinkles process.exit(...) throughout. Refactoring to return
 * a result envelope is a bigger change than a single PR — it touches
 * every command path. Until that lands, we eat the subprocess cost.
 *
 * If you're picking this up: extract main() into runCli(argv) that
 * captures stdout/stderr writes and returns the exit code instead
 * of calling process.exit. The subprocess path stays for the
 * "binary boots" smoke. Expect the migration to cut int-test wall
 * time by ~20s.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..", "..");
const CLI_ENTRY = join(ROOT, "src/cli.ts");

export type RouteHandler = (req: IncomingMessage, body: string) => { status: number; body: unknown; headers?: Record<string, string> };
export type RouteMap = Record<string, RouteHandler | { status: number; body: unknown; headers?: Record<string, string> }>;

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface Harness {
  baseUrl: string;
  port: number;
  configDir: string;
  requests: { method: string; path: string; body: string }[];
  runCli(args: string[], opts?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
  close(): Promise<void>;
}

export async function harness(opts: { routes?: RouteMap } = {}): Promise<Harness> {
  const routes = opts.routes ?? {};
  const requests: { method: string; path: string; body: string }[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url || "/", "http://stub");
      requests.push({ method: req.method || "GET", path: url.pathname + url.search, body });

      const key = `${req.method} ${url.pathname}`;
      const matched = routes[key] ?? routes[`${req.method} ${url.pathname}${url.search}`];

      let resp: { status: number; body: unknown; headers?: Record<string, string> };
      if (!matched) {
        resp = { status: 404, body: { error: "not routed" } };
      } else if (typeof matched === "function") {
        resp = matched(req, body);
      } else {
        resp = matched;
      }

      res.statusCode = resp.status;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(resp.headers ?? {}),
      };
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("failed to bind");
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Make a temp config dir with cli.json (mode 0600) pointing at our stub.
  const configDir = mkdtempSync(join(tmpdir(), "grove-int-"));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const cliJsonPath = join(configDir, "cli.json");
  writeFileSync(
    cliJsonPath,
    JSON.stringify({ server: baseUrl, token: "grove_live_testtoken_abcdefg" }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(cliJsonPath, 0o600);

  const runCli: Harness["runCli"] = (args, runOpts = {}) => {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GROVE_CONFIG_DIR: configDir,
        GROVE_TEST_SEED: "42",
        // Deterministic idempotency.
        ...(runOpts.env ?? {}),
      };
      const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], {
        cwd: ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));

      if (runOpts.stdin != null) {
        child.stdin.write(runOpts.stdin);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      const timer = setTimeout(() => child.kill("SIGKILL"), runOpts.timeoutMs ?? 20_000);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exit: code ?? 0, stdout, stderr, duration_ms: Date.now() - t0 });
      });
    });
  };

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {}
  };

  return { baseUrl, port, configDir, requests, runCli, close };
}
