import { describe, expect, it } from "vitest";
import {
  composeCommitMessage,
  parseTrailers,
  provenanceToTrailers,
  trailersToProvenance,
  validateCallerProvenance,
  type Provenance,
} from "../src/provenance.js";

describe("composeCommitMessage", () => {
  it("returns just the subject when no trailers", () => {
    expect(composeCommitMessage("grove (api): create Foo.md")).toBe(
      "grove (api): create Foo.md",
    );
    expect(composeCommitMessage("grove (api): create Foo.md", {})).toBe(
      "grove (api): create Foo.md",
    );
  });

  it("composes a canonical message with provenance trailers", () => {
    const trailers = provenanceToTrailers({
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: "2026-05-07T18:55:00Z",
      basis: ["Resources/People/Reid.md"],
      source: "conversation:test",
      reason: "synthesis from 2-data-point sequence",
    });
    const msg = composeCommitMessage("grove (claude): update Foo.md", trailers);
    expect(msg).toBe(
      [
        "grove (claude): update Foo.md",
        "",
        "Provenance-Voice: perishable",
        "Provenance-By: claude-opus-4-7",
        "Provenance-Written-At: 2026-05-07T18:55:00Z",
        "Provenance-Basis: Resources/People/Reid.md",
        "Provenance-Source: conversation:test",
        "Provenance-Reason: synthesis from 2-data-point sequence",
      ].join("\n"),
    );
  });

  it("emits repeated tokens for multi-value basis", () => {
    const trailers = provenanceToTrailers({
      voice: "perishable",
      by: "human",
      written_at: "2026-05-07T18:55:00Z",
      basis: ["A.md", "B.md", "C.md"],
    });
    const msg = composeCommitMessage("grove: update", trailers);
    const lines = msg.split("\n");
    const basisLines = lines.filter((l) => l.startsWith("Provenance-Basis:"));
    expect(basisLines).toEqual([
      "Provenance-Basis: A.md",
      "Provenance-Basis: B.md",
      "Provenance-Basis: C.md",
    ]);
  });

  it("rejects multi-line trailer values", () => {
    expect(() =>
      composeCommitMessage("subj", { "X-Foo": ["line1\nline2"] }),
    ).toThrow(/single-line/);
  });

  it("rejects malformed trailer tokens", () => {
    expect(() =>
      composeCommitMessage("subj", { "bad token": ["v"] }),
    ).toThrow(/Invalid trailer token/);
  });

  it("preserves canonical trailer ordering even when input is shuffled", () => {
    const msg = composeCommitMessage("subj", {
      "Provenance-Reason": ["r"],
      "Provenance-By": ["claude"],
      "Provenance-Voice": ["perishable"],
      "Provenance-Written-At": ["2026-05-07T18:55:00Z"],
    });
    const trailerLines = msg.split("\n").slice(2);
    expect(trailerLines).toEqual([
      "Provenance-Voice: perishable",
      "Provenance-By: claude",
      "Provenance-Written-At: 2026-05-07T18:55:00Z",
      "Provenance-Reason: r",
    ]);
  });
});

describe("parseTrailers", () => {
  it("returns empty for messages with no trailer block", () => {
    expect(parseTrailers("simple subject")).toEqual({});
    expect(parseTrailers("")).toEqual({});
    expect(parseTrailers("subj\n\nsome body text\nno trailers here")).toEqual({});
  });

  it("round-trips compose → parse", () => {
    const original: Provenance = {
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: "2026-05-07T18:55:00Z",
      basis: ["Resources/People/Reid.md", "Notes/draft.md"],
      source: "conversation:test",
      reason: "test",
    };
    const trailers = provenanceToTrailers(original);
    const msg = composeCommitMessage("grove: update", trailers);
    const parsed = parseTrailers(msg);
    const back = trailersToProvenance(parsed);
    expect(back).toEqual(original);
  });

  it("returns empty if trailer block butts against subject without blank line", () => {
    const msg = "subject\nProvenance-Voice: perishable";
    expect(parseTrailers(msg)).toEqual({});
  });

  it("ignores commits with body text before trailers", () => {
    const msg =
      "grove: update\n\nsome explanatory body\nProvenance-Voice: perishable\nProvenance-By: human\nProvenance-Written-At: 2026-05-07T18:55:00Z";
    expect(parseTrailers(msg)).toEqual({});
  });

  it("collects repeated tokens into arrays", () => {
    const msg =
      "grove: update\n\nProvenance-Voice: perishable\nProvenance-By: claude\nProvenance-Written-At: 2026-05-07T18:55:00Z\nProvenance-Basis: A\nProvenance-Basis: B\nProvenance-Basis: C";
    expect(parseTrailers(msg)["Provenance-Basis"]).toEqual(["A", "B", "C"]);
  });

  it("strips trailing blank lines", () => {
    const msg =
      "grove: update\n\nProvenance-Voice: durable\nProvenance-By: human\nProvenance-Written-At: 2026-05-07T18:55:00Z\n\n\n";
    const parsed = parseTrailers(msg);
    expect(parsed["Provenance-Voice"]).toEqual(["durable"]);
  });
});

describe("trailersToProvenance", () => {
  it("returns null when Provenance-Voice is missing", () => {
    expect(trailersToProvenance({})).toBeNull();
    expect(trailersToProvenance({ "Some-Other": ["x"] })).toBeNull();
  });

  it("returns null when required fields (by, written_at) are missing", () => {
    expect(
      trailersToProvenance({
        "Provenance-Voice": ["perishable"],
      }),
    ).toBeNull();
    expect(
      trailersToProvenance({
        "Provenance-Voice": ["perishable"],
        "Provenance-By": ["claude"],
      }),
    ).toBeNull();
  });

  it("returns null on unknown voice values", () => {
    expect(
      trailersToProvenance({
        "Provenance-Voice": ["mystery"],
        "Provenance-By": ["claude"],
        "Provenance-Written-At": ["2026-05-07T18:55:00Z"],
      }),
    ).toBeNull();
  });

  it("accepts legacy-unknown when present (server-emitted only)", () => {
    const prov = trailersToProvenance({
      "Provenance-Voice": ["legacy-unknown"],
      "Provenance-By": ["legacy"],
      "Provenance-Written-At": ["2026-05-07T18:55:00Z"],
    });
    expect(prov?.voice).toBe("legacy-unknown");
  });
});

describe("validateCallerProvenance", () => {
  const ok: Provenance = {
    voice: "perishable",
    by: "claude-opus-4-7",
    written_at: "2026-05-07T18:55:00Z",
  };

  it("accepts well-formed durable + perishable", () => {
    expect(() => validateCallerProvenance(ok)).not.toThrow();
    expect(() => validateCallerProvenance({ ...ok, voice: "durable" })).not.toThrow();
  });

  it("rejects legacy-unknown from callers", () => {
    expect(() =>
      validateCallerProvenance({ ...ok, voice: "legacy-unknown" as never }),
    ).toThrow(/server-internal/);
  });

  it("rejects unknown voices", () => {
    expect(() =>
      validateCallerProvenance({ ...ok, voice: "speculation" as never }),
    ).toThrow(/Invalid Provenance.voice/);
  });

  it("rejects missing/empty by", () => {
    expect(() => validateCallerProvenance({ ...ok, by: "" })).toThrow();
    expect(() => validateCallerProvenance({ ...ok, by: "   " })).toThrow();
  });

  it("rejects malformed timestamps", () => {
    expect(() => validateCallerProvenance({ ...ok, written_at: "yesterday" })).toThrow();
    expect(() => validateCallerProvenance({ ...ok, written_at: "2026-05-07" })).toThrow();
    expect(() =>
      validateCallerProvenance({ ...ok, written_at: "2026-13-99T99:99:99Z" }),
    ).toThrow();
  });

  it("accepts both Z and explicit UTC offset", () => {
    expect(() =>
      validateCallerProvenance({ ...ok, written_at: "2026-05-07T18:55:00+00:00" }),
    ).not.toThrow();
    expect(() =>
      validateCallerProvenance({ ...ok, written_at: "2026-05-07T18:55:00.123Z" }),
    ).not.toThrow();
  });

  it("rejects non-array or empty-string basis entries", () => {
    expect(() =>
      validateCallerProvenance({ ...ok, basis: "string" as never }),
    ).toThrow();
    expect(() => validateCallerProvenance({ ...ok, basis: [""] })).toThrow();
  });

  it("rejects multi-line source/reason", () => {
    expect(() =>
      validateCallerProvenance({ ...ok, source: "line1\nline2" }),
    ).toThrow();
    expect(() =>
      validateCallerProvenance({ ...ok, reason: "two\nlines" }),
    ).toThrow();
  });
});
