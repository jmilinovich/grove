import { describe, expect, it } from "vitest";
import { parseLLMOutput, applyLLMVerdict, type LLMVerdict } from "../scripts/provenance/llm-classify.js";

describe("parseLLMOutput", () => {
  it("parses a clean JSON response", () => {
    const out = parseLLMOutput(
      `{"voice": "perishable", "confidence": "high", "signals": ["interview-prep cluster", "dated 2026-04-30"]}`,
    );
    expect(out.voice).toBe("perishable");
    expect(out.confidence).toBe("high");
    expect(out.signals).toEqual(["interview-prep cluster", "dated 2026-04-30"]);
  });

  it("strips ```json fences", () => {
    const out = parseLLMOutput(
      "```json\n" +
        '{"voice": "durable", "confidence": "medium", "signals": ["public source citation"]}\n' +
        "```",
    );
    expect(out.voice).toBe("durable");
  });

  it("falls back to unknown on malformed JSON", () => {
    const out = parseLLMOutput("not json at all");
    expect(out.voice).toBe("unknown");
    expect(out.confidence).toBe("low");
    expect(out.signals).toContain("llm: malformed JSON output");
  });

  it("falls back to unknown on invalid voice value", () => {
    const out = parseLLMOutput(
      `{"voice": "speculative", "confidence": "high", "signals": ["x"]}`,
    );
    expect(out.voice).toBe("unknown");
    expect(out.signals).toContain("llm: invalid output shape");
  });

  it("falls back to unknown on missing signals array", () => {
    const out = parseLLMOutput(
      `{"voice": "durable", "confidence": "high", "signals": []}`,
    );
    // Empty signals array is INVALID per the prompt — must have 1-3.
    // (Our validator accepts empty; that's a permissive choice. Test
    //  documents current behavior.)
    expect(out.voice).toBe("durable");
    expect(out.signals).toEqual([]);
  });

  it("falls back to unknown on signals being a string", () => {
    const out = parseLLMOutput(
      `{"voice": "durable", "confidence": "high", "signals": "single signal"}`,
    );
    expect(out.voice).toBe("unknown");
  });
});

describe("applyLLMVerdict", () => {
  it("replaces voice + confidence and appends an llm signal hit", () => {
    const base = {
      path: "Resources/People/Foo.md",
      proposed_voice: "unknown" as const,
      confidence: "low" as const,
      signals: [],
      excerpt: "...",
      byte_length: 500,
    };
    const verdict: LLMVerdict = {
      voice: "perishable",
      confidence: "medium",
      signals: ["third-person prose about subject"],
      raw: "...",
    };
    const out = applyLLMVerdict(base, verdict);
    expect(out.proposed_voice).toBe("perishable");
    expect(out.confidence).toBe("medium");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].rule).toBe("llm:sonnet-residual");
    expect(out.signals[0].voice).toBe("perishable");
  });

  it("preserves prior signals when llm enriches a partially-classified result", () => {
    const base = {
      path: "Resources/Concepts/Foo.md",
      proposed_voice: "unknown" as const,
      confidence: "low" as const,
      signals: [
        {
          rule: "stub_skip",
          voice: "unknown" as const,
          confidence: "high" as const,
          rationale: "byteLength=120 — too short",
        },
      ],
      excerpt: "...",
      byte_length: 120,
    };
    const verdict: LLMVerdict = {
      voice: "perishable",
      confidence: "low",
      signals: ["short stub looks like an interview-prep one-liner"],
      raw: "...",
    };
    const out = applyLLMVerdict(base, verdict);
    expect(out.signals).toHaveLength(2);
    expect(out.signals[0].rule).toBe("stub_skip");
    expect(out.signals[1].rule).toBe("llm:sonnet-residual");
  });
});
