// Sonnet-as-classifier residual pass — the long-tail half of the
// hybrid classifier (B1.4 per the annotation panel design).
//
// Pipeline placement:
//   classify.ts  →  rules + folder heuristics  →  manifest with most
//                   notes labeled durable/perishable + ~20% unknown
//   llm-classify.ts → Sonnet labels the unknown residual
//   report.ts    →  reviewable markdown
//
// Why Sonnet not Opus: 4-class is well within Sonnet's calibration
// envelope, and at 1500-char prompts × ~350 unknown notes ≈ $0.35
// total. Single-pass, no chain-of-thought, no retry.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ClassifierResult, ClassifierVoice, Confidence, RuleHit } from "./rules.js";

const MODEL = "claude-sonnet-4-6";
const MAX_BODY_CHARS = 1500;
const MAX_TOKENS = 256;

export interface LLMClassifyInput {
  vaultPath: string;
  notePath: string;
}

export interface LLMVerdict {
  voice: ClassifierVoice;
  confidence: Confidence;
  signals: string[];
  /** Raw model response, for audit. */
  raw: string;
}

const SYSTEM_PROMPT = `You're labeling content provenance for notes in a personal knowledge vault.

There are two voices:
- DURABLE: content that's the user's own thinking, an extract from the user's input, or cited public research. Treated as standing fact at read time.
- PERISHABLE: moment-in-time AI synthesis or prediction. Could become stale; treated as a quoted historical artifact.

Asymmetric default: when uncertain between durable and perishable, prefer perishable. False-perishable hurts less than false-durable, because future readers will name perishable content as moment-in-time and ask before extending — exactly what you want for ambiguous cases.

If you genuinely can't tell from the available context, return "unknown" rather than guessing.

Output STRICT JSON only, no commentary:
{
  "voice": "durable" | "perishable" | "unknown",
  "confidence": "low" | "medium" | "high",
  "signals": ["short signal 1", "short signal 2", ...]
}

Signals are 5-15 word fragments naming what made you decide (e.g. "third-person prose about subject", "cited public release notes", "single-call extraction framed as durable identity"). 1-3 signals. Don't fabricate.`;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Inject a mock client for tests. */
export function setClient(mock: Anthropic): void {
  _client = mock;
}

export async function classifyNoteWithLLM(input: LLMClassifyInput): Promise<LLMVerdict> {
  const full = join(input.vaultPath, input.notePath);
  const raw = readFileSync(full, "utf8");
  const stat = statSync(full);

  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).slice(0, MAX_BODY_CHARS);

  const userPrompt = `Path: ${input.notePath}
Modified: ${stat.mtime.toISOString()}

Frontmatter:
${frontmatter}

Body (first ${MAX_BODY_CHARS} chars):
${body}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  return {
    ...parseLLMOutput(rawText),
    raw: rawText,
  };
}

/**
 * Parse the LLM's strict-JSON output. Defensive — falls back to
 * "unknown" if the response is malformed rather than throwing.
 */
export function parseLLMOutput(rawText: string): Omit<LLMVerdict, "raw"> {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      voice: "unknown",
      confidence: "low",
      signals: ["llm: malformed JSON output"],
    };
  }

  const obj = parsed as Record<string, unknown>;
  const voice = obj.voice;
  const confidence = obj.confidence;
  const signals = obj.signals;

  const validVoice =
    voice === "durable" || voice === "perishable" || voice === "unknown";
  const validConfidence =
    confidence === "low" || confidence === "medium" || confidence === "high";
  const validSignals =
    Array.isArray(signals) &&
    signals.every((s) => typeof s === "string" && s.length > 0);

  if (!validVoice || !validConfidence || !validSignals) {
    return {
      voice: "unknown",
      confidence: "low",
      signals: ["llm: invalid output shape"],
    };
  }

  return {
    voice: voice as ClassifierVoice,
    confidence: confidence as Confidence,
    signals: signals as string[],
  };
}

/**
 * Enrich a ClassifierResult with an LLM verdict. The LLM's signals are
 * appended as a synthetic RuleHit with `rule="llm:sonnet-residual"` so
 * the audit trail in the manifest is complete.
 */
export function applyLLMVerdict(
  base: ClassifierResult,
  verdict: LLMVerdict,
): ClassifierResult {
  const llmHit: RuleHit = {
    rule: "llm:sonnet-residual",
    voice: verdict.voice,
    confidence: verdict.confidence,
    rationale: `Sonnet residual: ${verdict.signals.join("; ")}`,
  };
  return {
    ...base,
    proposed_voice: verdict.voice,
    confidence: verdict.confidence,
    signals: [...base.signals, llmHit],
  };
}
