// Materialize the frozen test set into a real git-backed vault on disk,
// using the actual Provenance-trailer plumbing from src/provenance.ts.
//
// Each test note becomes one git commit with the canonical Provenance-*
// trailers. The result is a vault that exercises the read path
// (computeProvenanceBlame) end-to-end — same machinery the prod server
// uses, no mocks.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  composeCommitMessage,
  provenanceToTrailers,
  type Provenance,
} from "../../src/provenance.js";
import { TEST_NOTES, type TestNote } from "./test-set.js";

export interface PreparedVault {
  vaultPath: string;
  notes: PreparedNote[];
  cleanup: () => void;
}

export interface PreparedNote {
  test: TestNote;
  /** SHA of the commit that introduced this note. */
  commit_sha: string;
  /** Disk hash of the serialized note. */
  source_hash: string;
}

function sh(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function serializeNote(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body.trimStart()}`;
}

function hash(s: string): string {
  // Cheap deterministic hash — not cryptographic, just for cache key parity.
  // We don't need to match the server's exact hash here; setup-vault only
  // exists to populate a vault for the eval runner to read against.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `synthetic-${(h >>> 0).toString(16)}`;
}

/**
 * Materialize the frozen test set. Returns the temp vault path and a
 * cleanup() that removes it. Caller is responsible for cleanup.
 */
export function prepareTestVault(): PreparedVault {
  const vaultPath = mkdtempSync(join(tmpdir(), "grove-eval-vault-"));

  sh(["init", "-q", "-b", "main"], vaultPath);
  sh(["config", "user.email", "eval@grove.local"], vaultPath);
  sh(["config", "user.name", "Grove Eval"], vaultPath);
  sh(["config", "commit.gpgsign", "false"], vaultPath);

  const prepared: PreparedNote[] = [];

  for (const note of TEST_NOTES) {
    const fullPath = join(vaultPath, note.path);
    mkdirSync(dirname(fullPath), { recursive: true });

    const serialized = serializeNote(note.frontmatter, note.body);
    writeFileSync(fullPath, serialized);

    const prov: Provenance = {
      voice: note.voice,
      by: note.by,
      written_at: note.written_at,
      ...(note.basis && { basis: note.basis }),
      ...(note.reason && { reason: note.reason }),
      source: "eval-fixture:test-set@v1",
    };

    sh(["add", note.path], vaultPath);
    const subject = `eval: create ${note.path}`;
    const msg = composeCommitMessage(subject, provenanceToTrailers(prov));
    sh(["commit", "-q", "-m", msg], vaultPath);
    const sha = sh(["rev-parse", "HEAD"], vaultPath);

    prepared.push({
      test: note,
      commit_sha: sha,
      source_hash: hash(serialized),
    });
  }

  const cleanup = () => {
    rmSync(vaultPath, { recursive: true, force: true });
  };

  return { vaultPath, notes: prepared, cleanup };
}
