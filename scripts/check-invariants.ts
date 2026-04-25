#!/usr/bin/env tsx
/**
 * Static invariant drift check.
 *
 * Encodes a small set of anti-patterns whose presence in the codebase must
 * be tracked explicitly. Each entry is a filename:line:pattern that the
 * maintainer has acknowledged. If the grep result set differs — new
 * occurrences OR the allowlisted ones have drifted to new lines — the
 * check fails so the author has to look at the new site before it ships.
 *
 * Why drift instead of zero-tolerance: some of these patterns are
 * intentional fallbacks that are fine today (env is pinned in PM2
 * ecosystem config) but become lethal if the env disappears. The right
 * fix is to make them fail-closed; until that refactor lands, freeze the
 * set so new ones can't sneak in.
 *
 * Add a new rule by appending to INVARIANTS below, then running this
 * script locally. On hit, it prints the current snapshot — paste those
 * into the rule's `allowlist`. Document any new entry with a one-line
 * `reason`.
 */
import { execSync } from "node:child_process";

interface Invariant {
  name: string;
  reason: string;
  // ripgrep pattern; checked against src/ excluding .d.ts
  pattern: string;
  // expected `file:line:text` entries. Exact match required.
  allowlist: string[];
}

const INVARIANTS: Invariant[] = [
  {
    name: "no-new-tenant-default-strings",
    reason:
      "Hardcoded `?? \"personal\"` / `?? \"life\"` fallbacks produced the " +
      "URL-slug cross-vault leak fixed in PR #66. They work today only " +
      "because PM2 ecosystem pins the env var — if that pin slips, every " +
      "URL silently routes to the wrong vault. Freeze the set.",
    pattern: '\\?\\? "(personal|life)"',
    allowlist: [
      'src/proxy.ts:1297:        boundVaultId = membership?.vault_id ?? "life";',
      'src/rest.ts:65:    vaultSlug: process.env.GROVE_VAULT_SLUG ?? "personal",',
      'src/rest.ts:1793:let vaultIdResolver: VaultIdResolver = () => process.env.GROVE_VAULT_ID ?? "life";',
      'src/discovery.ts:57:    vaultSlug: process.env.GROVE_VAULT_SLUG ?? "personal",',
      'src/server.ts:91:  vaultSlug: process.env.GROVE_VAULT_SLUG ?? "personal",',
    ],
  },
];

function ripgrep(pattern: string): string[] {
  try {
    const out = execSync(
      `git grep -nE ${JSON.stringify(pattern)} -- 'src/*.ts' ':!src/*.d.ts'`,
      { encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (err: unknown) {
    // exit 1 from git grep = no matches, which is a valid result
    const code = (err as { status?: number }).status;
    if (code === 1) return [];
    throw err;
  }
}

let failed = false;

for (const inv of INVARIANTS) {
  const actual = ripgrep(inv.pattern).sort();
  const expected = [...inv.allowlist].sort();

  const missing = expected.filter((e) => !actual.includes(e));
  const extra = actual.filter((a) => !expected.includes(a));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`[invariants] ${inv.name}: ok (${actual.length} known site${actual.length === 1 ? "" : "s"})`);
    continue;
  }

  failed = true;
  console.error(`\n[invariants] ${inv.name}: DRIFT`);
  console.error(`  reason: ${inv.reason}`);
  if (extra.length > 0) {
    console.error(`  new occurrences (must fix or allowlist):`);
    for (const e of extra) console.error(`    + ${e}`);
  }
  if (missing.length > 0) {
    console.error(`  allowlisted sites no longer present (remove from allowlist):`);
    for (const m of missing) console.error(`    - ${m}`);
  }
}

if (failed) {
  console.error(
    "\n[invariants] one or more invariants drifted. Edit scripts/check-invariants.ts " +
      "after you've reviewed each new site, or fix the underlying issue.",
  );
  process.exit(1);
}
