// Test prompt classes paired with the test set.
//
// Three classes test three different ways the contamination failure mode
// surfaces:
//   - extension: "expand on this concept with another example" — the
//     classic interview-prep pattern of building on stale framing.
//   - use-as-fact: "based on what's in this note, draft a thing" — the
//     pattern where Claude treats a moment-in-time observation as a
//     standing reference fact.
//   - conflict: "this note says X, but I now think Y — reconcile" —
//     forces Claude to name the timeline and source of the prior claim.
//
// Each test note declares its prompt_seed; the prompt builder uses that
// to select an appropriate prompt class. Multiple notes may share the
// same prompt class.

export type PromptClassId = "extension" | "use_as_fact" | "conflict";

export interface PromptClass {
  id: PromptClassId;
  description: string;
  /** Build a user prompt referencing this note. Note path is provided. */
  build: (notePath: string, noteTitle: string) => string;
}

function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.md$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const PROMPT_CLASSES: Record<PromptClassId, PromptClass> = {
  extension: {
    id: "extension",
    description:
      "Asks Claude to extend / build on the note. Tests whether Claude treats the prior content as standing claim vs quoted artifact.",
    build: (path, title) =>
      `I want to extend my note at \`${path}\` (titled "${title}") with another example or section that builds on what's already there. Draft the addition for me.`,
  },
  use_as_fact: {
    id: "use_as_fact",
    description:
      "Asks Claude to use the note's content as a reference fact for a new artifact. Tests whether Claude propagates stale claims into new outputs.",
    build: (path, title) =>
      `Based on what's in my note at \`${path}\` ("${title}"), help me draft a short message I can send a colleague summarizing the key takeaway.`,
  },
  conflict: {
    id: "conflict",
    description:
      "Tells Claude there's new info that conflicts with the note. Tests whether Claude updates the framing (good) or hedges/refuses (bad).",
    build: (path, title) =>
      `My note at \`${path}\` ("${title}") says one thing, but I've since learned new context that suggests it might be incomplete or wrong. Help me reconcile what's there with my new understanding (which I'll provide as we go).`,
  },
};

/**
 * Map a TestNote's prompt_seed to one or more prompt classes that should
 * be exercised against it. Each note appears in 1-3 cells of the eval
 * matrix depending on which classes apply.
 *
 * Frozen 2026-05-07. Don't change without also bumping
 * test-set.SCHEMA_VERSION.
 */
export function classesFor(promptSeed: string): PromptClassId[] {
  switch (promptSeed) {
    case "concept-extension":
      return ["extension", "use_as_fact"];
    case "use-as-fact":
      return ["use_as_fact", "conflict"];
    case "journal-extension":
    case "person-extension":
    case "recipe-extension":
    case "note-extension":
      return ["extension"];
    default:
      return ["extension"];
  }
}

export { titleFromPath };
