#!/usr/bin/env tsx
/**
 * Fails the build if a PR changes anything that affects `discovery_cache`
 * cache keys without bumping `DISCOVERY_CACHE_VERSION` in
 * `src/discovery-extract.ts`. The cache key is
 * `(vault_id, path, content_sha256, cache_version)` — if the call shape,
 * the tool schema, the prompt prefix, or the extraction-result type
 * changes but cache_version doesn't, stale results will leak into new
 * deployments.
 *
 * Surfaces watched (any change → must bump):
 *   - `EXTRACTION_MODEL` constant
 *   - `EXTRACT_TOOL` schema definition
 *   - `buildPrompt` function body (the static prefix sent to Anthropic)
 *   - `ExtractionResult` interface (the cached row's shape)
 *
 * Base branch defaults to `origin/main`. CI passes `GITHUB_BASE_REF`.
 * Run locally: `npm run check:cache-version`.
 */
import { execSync } from "node:child_process";

const TARGET_FILE = "src/discovery-extract.ts";
const VERSION_RE = /export\s+const\s+DISCOVERY_CACHE_VERSION\s*=\s*(\d+)/;

// Each watched surface: name + a regex that captures the full text span
// whose change should require a cache version bump. Regexes are anchored
// to start-of-line and use `m` flag so they don't false-match comments
// or strings elsewhere. The DOTALL `s` flag lets `.` cross newlines.
const SURFACES: Array<{ name: string; re: RegExp }> = [
  {
    name: "EXTRACTION_MODEL",
    re: /^(?:export\s+)?const\s+EXTRACTION_MODEL\s*=\s*"[^"]+";/m,
  },
  {
    name: "EXTRACT_TOOL",
    re: /^(?:export\s+)?const\s+EXTRACT_TOOL[^=]*=\s*\{[\s\S]*?\n\};/m,
  },
  {
    name: "buildPrompt",
    re: /^(?:export\s+)?function\s+buildPrompt\s*\([\s\S]*?\n\}/m,
  },
  {
    name: "ExtractionResult",
    re: /^export\s+interface\s+ExtractionResult\s*\{[\s\S]*?\n\}/m,
  },
];

const base = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : "origin/main";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" });
}

function fileAtRef(ref: string, path: string): string | null {
  try {
    return sh(`git show ${ref}:${path}`);
  } catch {
    return null;
  }
}

function version(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(VERSION_RE);
  return m ? Number.parseInt(m[1], 10) : null;
}

function surface(text: string, name: string): string | null {
  const def = SURFACES.find((s) => s.name === name);
  if (!def) return null;
  const m = text.match(def.re);
  return m ? m[0] : null;
}

const headText = fileAtRef("HEAD", TARGET_FILE);
if (!headText) {
  console.error(
    `[cache-version] ${TARGET_FILE} not found at HEAD — repository state corrupt?`,
  );
  process.exit(2);
}

const baseText = fileAtRef(base, TARGET_FILE);
if (!baseText) {
  console.log(
    `[cache-version] ${base}:${TARGET_FILE} unreachable — first-time check or missing fetch, skipping.`,
  );
  process.exit(0);
}

const headVersion = version(headText);
const baseVersion = version(baseText);

if (headVersion === null) {
  console.error(
    `[cache-version] could not parse DISCOVERY_CACHE_VERSION in HEAD's ${TARGET_FILE}`,
  );
  process.exit(2);
}

const drifted: string[] = [];
for (const def of SURFACES) {
  const baseSurface = surface(baseText, def.name);
  const headSurface = surface(headText, def.name);
  if (baseSurface === null || headSurface === null) {
    // Surface missing on one side — either added or removed in this PR.
    // Treat as drift; the reviewer needs to weigh it.
    if (baseSurface !== headSurface) drifted.push(def.name);
    continue;
  }
  if (baseSurface !== headSurface) drifted.push(def.name);
}

if (drifted.length === 0) {
  console.log(
    `[cache-version] OK — no watched surfaces changed (DISCOVERY_CACHE_VERSION=${headVersion}).`,
  );
  process.exit(0);
}

if (baseVersion !== null && headVersion > baseVersion) {
  console.log(
    `[cache-version] OK — surfaces changed (${drifted.join(", ")}), ` +
      `DISCOVERY_CACHE_VERSION bumped ${baseVersion} → ${headVersion}.`,
  );
  process.exit(0);
}

console.error(
  `[cache-version] FAIL — ${TARGET_FILE} surfaces changed but ` +
    `DISCOVERY_CACHE_VERSION did not bump.`,
);
console.error(``);
console.error(`Changed surfaces (any one bumps the version):`);
for (const name of drifted) console.error(`  - ${name}`);
console.error(``);
console.error(
  `Current DISCOVERY_CACHE_VERSION = ${headVersion}` +
    (baseVersion !== null ? ` (base ${base} = ${baseVersion})` : ""),
);
console.error(``);
console.error(
  `Fix: bump the constant in ${TARGET_FILE} in the same PR. Without a bump, ` +
    `old cached extractions (P7-COST-3) will be served against a new prompt/` +
    `schema/model and silently return stale results.`,
);
process.exit(1);
