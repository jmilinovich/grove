/**
 * `grove edit <path>` — TTY-only interactive editor with conflict recovery.
 *
 * Flow:
 *   1. GET the note (path + source_hash).
 *   2. Write content to a tempfile, spawn $EDITOR.
 *   3. On editor save, read new content and PUT with If-Match: <source_hash>.
 *   4. On 409 conflict: GET latest, show three-way context
 *      (their edits, latest on server, merged preview) and prompt:
 *        [r]etry   — re-fetch latest, re-launch editor with latest content
 *        [o]verwrite — force-write with latest hash (discards server change)
 *        [a]bort   — exit 1, leave tempfile for recovery
 *
 * We use source_hash (not content_hash) for If-Match because the Grove
 * discovery worker may mutate the file on disk (wikilink wiring). source_hash
 * is pinned to what the caller last wrote, so it stays stable across that.
 *
 * Refuses headless (non-TTY) invocation — agents should use `grove patch`.
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GroveCliError } from "./lib/errors.js";

export interface EditDeps {
  getNote: (path: string) => Promise<{ content: string; source_hash: string; frontmatter?: Record<string, unknown> }>;
  putNote: (path: string, content: string, ifHash: string) => Promise<{ status: number; data: Record<string, unknown> }>;
  /** Editor binary — defaults to $EDITOR, $VISUAL, then vi. */
  editor?: string;
  /** Readline promise factory (override for tests). */
  promptChar?: (question: string) => Promise<string>;
  /** For tests — if set, skip spawning editor and directly use this content. */
  simulatedEdit?: (original: string) => string;
}

function defaultEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}

export function simpleDiff(a: string, b: string, contextLines = 3): string {
  // Minimal line-oriented diff — good enough for conflict prompts.
  // Not a real Myers diff, but shows "- a-line" / "+ b-line" for changed segments.
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLen = Math.max(aLines.length, bLines.length);
  const out: string[] = [];
  let i = 0;
  while (i < maxLen) {
    const al = aLines[i] ?? null;
    const bl = bLines[i] ?? null;
    if (al === bl) {
      // Unchanged — show in context window.
      if (out.length > 0 && out.length < contextLines * 20) out.push(`  ${al ?? ""}`);
    } else {
      if (al != null) out.push(`- ${al}`);
      if (bl != null) out.push(`+ ${bl}`);
    }
    i++;
  }
  return out.slice(0, 40).join("\n") + (out.length > 40 ? `\n  ... (${out.length - 40} more diff lines)` : "");
}

function spawnEditor(editor: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`editor exited ${code}`))));
  });
}

async function defaultPromptChar(question: string): Promise<string> {
  process.stderr.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ans = await new Promise<string>((r) => rl.question("", (a) => { rl.close(); r(a); }));
  return ans.trim().toLowerCase();
}

export interface EditOutcome {
  status: "unchanged" | "written" | "overwritten" | "aborted";
  path: string;
  new_source_hash?: string;
  tempfile?: string; // present on abort, for recovery
}

/**
 * Run the edit flow. Returns an outcome describing what happened.
 * All prompts go to stderr; tempfile location is printed on abort.
 */
export async function runEdit(path: string, deps: EditDeps): Promise<EditOutcome> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (process.env.GROVE_FORCE_TTY !== "1") {
      throw new GroveCliError(
        "HEADLESS_EDITOR",
        "`grove edit` requires an interactive terminal. For agent/headless use, `grove patch` is the idempotent alternative.",
        {
          hint: `Use \`grove patch ${path} --if-hash <hash> --content <text>\` (get the hash with \`grove get ${path}\`).`,
          suggestions: [`grove get ${path}`, `grove patch ${path} --if-hash <hash> --content <text>`],
        },
      );
    }
  }

  const original = await deps.getNote(path);
  const tmpDir = mkdtempSync(join(tmpdir(), "grove-edit-"));
  chmodSync(tmpDir, 0o700);
  const tempPath = join(tmpDir, path.replace(/[\/]/g, "__"));
  writeFileSync(tempPath, original.content, { mode: 0o600 });

  // Launch editor (or simulate in tests).
  if (deps.simulatedEdit) {
    writeFileSync(tempPath, deps.simulatedEdit(original.content), { mode: 0o600 });
  } else {
    const editor = deps.editor ?? defaultEditor();
    await spawnEditor(editor, tempPath);
  }

  // Read back edited content.
  const edited = readFileSync(tempPath, "utf8");
  if (edited === original.content) {
    return { status: "unchanged", path, new_source_hash: original.source_hash };
  }

  // Try the PUT with If-Match (using source_hash — stable across discovery mutations).
  let baseHash = original.source_hash;
  let contentToPut = edited;

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await deps.putNote(path, contentToPut, baseHash);
    if (res.status < 400) {
      // Prefer source_hash from response; fall back to content_hash for
      // servers that haven't been upgraded yet (pre-2026-04 builds).
      const data = res.data as { source_hash?: string; content_hash?: string };
      const newHash = data.source_hash ?? data.content_hash;
      return { status: attempt === 0 ? "written" : "overwritten", path, new_source_hash: newHash };
    }
    if (res.status !== 409) {
      throw new GroveCliError("SERVER_ERROR", `PUT failed with status ${res.status}: ${JSON.stringify(res.data)}`, {
        details: { status: res.status, tempfile: tempPath },
      });
    }

    // Conflict. Fetch latest, show diff, prompt.
    const latest = await deps.getNote(path);
    const yourChanges = simpleDiff(original.content, contentToPut);
    const serverChanges = simpleDiff(original.content, latest.content);
    process.stderr.write(`\n⚠  Conflict: ${path} was modified on the server since you opened it.\n\n`);
    process.stderr.write(`Your changes (vs your starting version):\n${yourChanges}\n\n`);
    process.stderr.write(`Server changes (vs your starting version):\n${serverChanges}\n\n`);

    const ask = deps.promptChar ?? defaultPromptChar;
    const answer = await ask("[r]etry with latest / [o]verwrite server / [a]bort: ");
    if (answer === "r" || answer === "retry") {
      // Re-launch editor with latest server content as the new starting point.
      writeFileSync(tempPath, latest.content, { mode: 0o600 });
      if (deps.simulatedEdit) {
        writeFileSync(tempPath, deps.simulatedEdit(latest.content), { mode: 0o600 });
      } else {
        const editor = deps.editor ?? defaultEditor();
        await spawnEditor(editor, tempPath);
      }
      contentToPut = readFileSync(tempPath, "utf8");
      baseHash = latest.source_hash;
      continue;
    } else if (answer === "o" || answer === "overwrite") {
      // Force-write using the latest hash (intentional clobber of server change).
      baseHash = latest.source_hash;
      continue;
    } else {
      // Abort. Tempfile left in place for user recovery.
      process.stderr.write(`aborted — your edits are preserved at ${tempPath}\n`);
      return { status: "aborted", path, tempfile: tempPath };
    }
  }

  throw new GroveCliError("CONFLICT", "Too many conflict-recovery attempts; aborting.", {
    details: { tempfile: tempPath },
  });
}
