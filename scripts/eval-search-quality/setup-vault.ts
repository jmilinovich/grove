// Materialize the small VAULT_NOTES set into a tmp git-backed vault, with
// real Provenance-* trailers via composeCommitMessage. Used by the
// end-to-end layer (latency + envelope) — not by the ranking-unit layer,
// which works on synthetic candidate lists alone.
//
// Mirrors scripts/eval-provenance/setup-vault.ts intentionally. Two
// near-identical materializers are easier to maintain than a parameterized
// shared one, given the small note counts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  composeCommitMessage,
  provenanceToTrailers,
  type Provenance,
} from "../../src/provenance.js";
import { VAULT_NOTES, type VaultTestNote } from "./test-set.js";

export interface PreparedVault {
  vaultPath: string;
  notes: { test: VaultTestNote; commit_sha: string }[];
  cleanup: () => void;
}

function sh(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function serializeNote(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body.trimStart()}`;
}

export function prepareE2EVault(): PreparedVault {
  const vaultPath = mkdtempSync(join(tmpdir(), "grove-search-eval-vault-"));

  sh(["init", "-q", "-b", "main"], vaultPath);
  sh(["config", "user.email", "search-eval@grove.local"], vaultPath);
  sh(["config", "user.name", "Grove Search Eval"], vaultPath);
  sh(["config", "commit.gpgsign", "false"], vaultPath);

  const prepared: PreparedVault["notes"] = [];

  for (const note of VAULT_NOTES) {
    const fullPath = join(vaultPath, note.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, serializeNote(note.frontmatter, note.body));

    const prov: Provenance = {
      voice: note.voice,
      by: note.by,
      written_at: note.written_at,
      ...(note.basis && { basis: note.basis }),
      ...(note.reason && { reason: note.reason }),
      source: "search-eval-fixture:vault@v1",
    };

    sh(["add", note.path], vaultPath);
    const subject = `eval: create ${note.path}`;
    const msg = composeCommitMessage(subject, provenanceToTrailers(prov));
    sh(["commit", "-q", "-m", msg], vaultPath);
    const sha = sh(["rev-parse", "HEAD"], vaultPath);

    prepared.push({ test: note, commit_sha: sha });
  }

  return {
    vaultPath,
    notes: prepared,
    cleanup: () => rmSync(vaultPath, { recursive: true, force: true }),
  };
}
