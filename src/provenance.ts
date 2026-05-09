// Provenance — voice + authorship metadata attached to every Grove write.
//
// Encoded as RFC2822-style git trailers in the commit message body, so the
// signal is git-native: queryable via `git log --grep`, parseable via
// `git interpret-trailers`, and survives any vault clone or rewrite.
//
// Trailer schema (locked 2026-05-07):
//   Provenance-Voice:     durable | perishable | legacy-unknown
//   Provenance-By:        model-id or "human"
//   Provenance-Written-At: ISO-8601 UTC timestamp
//   Provenance-Basis:     path or URL the content was derived from (repeatable)
//   Provenance-Source:    free-text session/conversation identifier (single)
//   Provenance-Reason:    human-readable rationale (single)
//
// Default at read time: a commit without a Provenance-Voice trailer surfaces
// as `voice: legacy-unknown`. Callers MUST NOT pass `legacy-unknown` directly;
// it is the absence-of-signal marker, not a value to choose.

export type Voice = "durable" | "perishable" | "legacy-unknown";

export interface Provenance {
  voice: Voice;
  by: string;
  written_at: string;
  basis?: string[];
  source?: string;
  reason?: string;
}

/** Map of trailer token → values. Repeated tokens collected into arrays. */
export type Trailers = Record<string, string[]>;

const VOICE_VALUES: ReadonlySet<Voice> = new Set([
  "durable",
  "perishable",
  "legacy-unknown",
]);

/**
 * Validate a Provenance object received from a caller. Rejects
 * `legacy-unknown` (server-internal) and malformed timestamps.
 *
 * Throws Error with a clear message on invalid input.
 */
export function validateCallerProvenance(prov: Provenance): void {
  if (!VOICE_VALUES.has(prov.voice)) {
    throw new Error(
      `Invalid Provenance.voice: ${JSON.stringify(prov.voice)}. Expected "durable" or "perishable".`,
    );
  }
  if (prov.voice === "legacy-unknown") {
    throw new Error(
      "Provenance.voice cannot be set to 'legacy-unknown' by callers; it is server-internal.",
    );
  }
  if (!prov.by || typeof prov.by !== "string" || prov.by.trim() === "") {
    throw new Error("Provenance.by must be a non-empty string.");
  }
  if (!prov.written_at || !isIsoUtc(prov.written_at)) {
    throw new Error(
      `Provenance.written_at must be an ISO-8601 UTC timestamp; got ${JSON.stringify(prov.written_at)}.`,
    );
  }
  if (prov.basis !== undefined) {
    if (!Array.isArray(prov.basis) || !prov.basis.every((b) => typeof b === "string" && b.trim() !== "")) {
      throw new Error("Provenance.basis must be an array of non-empty strings.");
    }
  }
  if (prov.source !== undefined && (typeof prov.source !== "string" || prov.source.includes("\n"))) {
    throw new Error("Provenance.source must be a single-line string.");
  }
  if (prov.reason !== undefined && (typeof prov.reason !== "string" || prov.reason.includes("\n"))) {
    throw new Error("Provenance.reason must be a single-line string.");
  }
}

function isIsoUtc(s: string): boolean {
  // Accept either Z-suffix or +00:00 explicit UTC offset.
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return false;
  }
  const t = Date.parse(s);
  return Number.isFinite(t);
}

/**
 * Convert a Provenance object into git trailers. Order is stable so commit
 * messages are deterministic for tests.
 */
export function provenanceToTrailers(prov: Provenance): Trailers {
  const t: Trailers = {
    "Provenance-Voice": [prov.voice],
    "Provenance-By": [prov.by],
    "Provenance-Written-At": [prov.written_at],
  };
  if (prov.basis && prov.basis.length > 0) {
    t["Provenance-Basis"] = [...prov.basis];
  }
  if (prov.source !== undefined) {
    t["Provenance-Source"] = [prov.source];
  }
  if (prov.reason !== undefined) {
    t["Provenance-Reason"] = [prov.reason];
  }
  return t;
}

/**
 * Compose a commit message from a subject line and an optional trailers map.
 * Trailers are appended in the canonical order (voice, by, written-at, basis,
 * source, reason); unknown tokens come last in iteration order.
 *
 * Output format (per `git-interpret-trailers(1)`):
 *
 *     <subject>
 *
 *     Token1: value
 *     Token1: value-2
 *     Token2: value
 */
const TRAILER_ORDER: readonly string[] = [
  "Provenance-Voice",
  "Provenance-By",
  "Provenance-Written-At",
  "Provenance-Basis",
  "Provenance-Source",
  "Provenance-Reason",
];

export function composeCommitMessage(subject: string, trailers?: Trailers): string {
  const cleanSubject = subject.replace(/\n+$/, "");
  if (!trailers) return cleanSubject;

  const tokens = Object.keys(trailers);
  if (tokens.length === 0) return cleanSubject;

  // Validate trailer shape — values must be single-line, tokens RFC-shaped.
  for (const token of tokens) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(token)) {
      throw new Error(`Invalid trailer token: ${JSON.stringify(token)}`);
    }
    for (const value of trailers[token]) {
      if (typeof value !== "string" || value.includes("\n")) {
        throw new Error(
          `Trailer ${token} value must be a single-line string; got ${JSON.stringify(value)}`,
        );
      }
    }
  }

  // Emit canonical-order tokens first, then any extras in insertion order.
  const seen = new Set<string>();
  const lines: string[] = [];
  const emit = (token: string): void => {
    if (seen.has(token)) return;
    if (!(token in trailers)) return;
    seen.add(token);
    for (const value of trailers[token]) {
      lines.push(`${token}: ${value}`);
    }
  };
  for (const t of TRAILER_ORDER) emit(t);
  for (const t of tokens) emit(t);

  return `${cleanSubject}\n\n${lines.join("\n")}`;
}

/**
 * Parse trailers out of a commit message. Trailers are the trailing block
 * of `Token: value` lines, separated from the body by a blank line (or the
 * start of the message if there's no subject body). Permissive: a message
 * without trailers returns `{}`.
 *
 * This implementation matches `git interpret-trailers --parse` semantics for
 * our well-formed messages but is stricter — it requires all lines in the
 * trailing block to be valid trailer lines (no signed-off-by-style commentary
 * mixed in). That is fine for Grove's machine-generated commits.
 */
export function parseTrailers(commitMessage: string): Trailers {
  if (!commitMessage) return {};
  const lines = commitMessage.replace(/\r\n/g, "\n").split("\n");

  // Strip trailing empty lines.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return {};

  // Walk backwards to find the boundary: the first non-trailer line.
  const trailerLineRe = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/;
  let firstTrailerIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "") {
      // Blank line marks the boundary between body and trailers.
      break;
    }
    if (!trailerLineRe.test(lines[i])) {
      // Non-trailer text below the blank — no trailer block.
      return {};
    }
    firstTrailerIdx = i;
  }

  // Require the trailer block to be preceded by either nothing or a blank line.
  if (firstTrailerIdx > 0 && lines[firstTrailerIdx - 1] !== "") {
    // Trailers butt directly against the subject without a blank line — not a valid trailer block.
    return {};
  }

  const out: Trailers = {};
  for (let i = firstTrailerIdx; i < lines.length; i++) {
    const m = trailerLineRe.exec(lines[i]);
    if (!m) continue;
    const [, token, value] = m;
    if (!out[token]) out[token] = [];
    out[token].push(value);
  }
  return out;
}

/**
 * Read trailers and reconstitute a Provenance object, or null if the
 * commit has no Provenance-Voice trailer (i.e., legacy / non-provenance
 * commits like discovery-worker mutations made before rollout).
 *
 * Read-side default: a commit with no Provenance-Voice surfaces as voice
 * = "legacy-unknown" via the surfacing layer in rest.ts, NOT here.
 */
export function trailersToProvenance(trailers: Trailers): Provenance | null {
  const voice = trailers["Provenance-Voice"]?.[0];
  if (!voice) return null;
  if (!VOICE_VALUES.has(voice as Voice)) return null;

  const by = trailers["Provenance-By"]?.[0];
  const written_at = trailers["Provenance-Written-At"]?.[0];
  if (!by || !written_at) return null;

  const prov: Provenance = {
    voice: voice as Voice,
    by,
    written_at,
  };
  if (trailers["Provenance-Basis"]) prov.basis = [...trailers["Provenance-Basis"]];
  if (trailers["Provenance-Source"]) prov.source = trailers["Provenance-Source"][0];
  if (trailers["Provenance-Reason"]) prov.reason = trailers["Provenance-Reason"][0];
  return prov;
}

// ── Read/search-side directives ────────────────────────────────────
//
// Single source of truth for the perishable-handling instructions emitted
// by Grove. Used by the read path (computeProvenanceFields → NoteResponse)
// AND the search path (HybridResult envelope) so the same wording governs
// both surfaces. Wording locked 2026-05-07; soft variant added 2026-05-09
// for legacy-unknown notes that §E priorVoice flags as likely perishable.
//
// Moved here from blame.ts as part of v3 search-quality work so search-side
// callers don't have to reach into the blame module just for a string.

export const PERISHABLE_USAGE_DIRECTIVE =
  "This note contains perishable segments — moment-in-time synthesis or prediction by an AI agent that may now be stale. You MUST: (1) before using or quoting any perishable segment, name it explicitly to the user (e.g., \"lines 5-12 were synthesis on 2026-04-30; this may be stale\"); (2) not extend, refine, or build on perishable segments without first asking the user to confirm the framing still holds; (3) prefer durable segments when there's a conflict; (4) treat perishable content as a quoted historical artifact, not a standing claim.";

export const PERISHABLE_USAGE_DIRECTIVE_SOFT =
  "This note is unstamped, but its location and content suggest it may be perishable (AI synthesis or moment-in-time snapshot). Verify the content reflects current understanding before extending it.";
