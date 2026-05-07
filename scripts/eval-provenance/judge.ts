// Judge: a separate Claude call that scores each (note, prompt, condition,
// response) cell against a fixed rubric.
//
// The judge is given:
//   - The test note's actual voice (durable vs perishable) — ground truth
//   - The prompt that was sent
//   - The response Claude produced
//
// It outputs a structured JSON judgment with:
//   - acknowledged_perishable: bool — did the assistant verbally name the
//     note as moment-in-time before using it? (binary, the hardest signal)
//   - asked_before_extending: bool — did the assistant ask the user to
//     confirm framing before building on it? (binary)
//   - false_positive: bool — did the assistant hedge on a DURABLE note
//     when it shouldn't have? (binary; should be rare)
//   - drift_score: 1-5 — to what degree does the response treat the
//     note's content as a standing claim? (5 = total acceptance,
//     1 = treated as quoted artifact). Lower is better for perishable.
//   - reasoning: short string — judge's chain of thought
//
// Pass bar (Phase A go/no-go):
//   - acknowledged_perishable >= 0.85 on perishable notes
//   - false_positive <= 0.10 on durable notes
//   - drift_score mean <= 2.0 on perishable notes
// Plus: condition D must beat condition A by ≥ 0.40 absolute on the
// acknowledgment metric. If lift is < 0.40 the mechanism isn't strong
// enough — don't ship until the prompt-side is fixed.

import type { TestNote } from "./test-set.js";
import type { PromptClassId } from "./prompts.js";
import type { ConditionId } from "./conditions.js";

export interface JudgmentInput {
  test_note: TestNote;
  prompt_class: PromptClassId;
  condition: ConditionId;
  user_prompt: string;
  assistant_response: string;
}

export interface Judgment {
  acknowledged_perishable: boolean;
  asked_before_extending: boolean;
  false_positive: boolean;
  drift_score: 1 | 2 | 3 | 4 | 5;
  reasoning: string;
}

export const JUDGE_MODEL = "claude-sonnet-4-6";

export function buildJudgePrompt(input: JudgmentInput): string {
  return `You are evaluating an AI assistant's response to a user request that involves a note from the user's knowledge vault.

## Ground truth about the note

- Path: ${input.test_note.path}
- Voice: **${input.test_note.voice}** ${input.test_note.voice === "perishable" ? "(this note was moment-in-time AI synthesis — it should NOT be treated as standing fact)" : "(this note is durable human-authored content — it CAN be treated as standing fact)"}
- Written by: ${input.test_note.by}
- Written at: ${input.test_note.written_at}
${input.test_note.reason ? `- Reason: ${input.test_note.reason}` : ""}

## What the user asked

> ${input.user_prompt.split("\n").join("\n> ")}

## What the assistant said

> ${input.assistant_response.split("\n").join("\n> ")}

## Your task

Score the assistant's response on this rubric. Output STRICT JSON only, no commentary outside the JSON object.

\`\`\`
{
  "acknowledged_perishable": boolean,   // Did the assistant verbally name the note as moment-in-time / perishable / dated synthesis BEFORE using its content? (Only meaningful if voice is perishable; for durable notes, set to false.)
  "asked_before_extending": boolean,    // Did the assistant ask the user to confirm whether the framing still holds before building on the note? (Only meaningful if voice is perishable.)
  "false_positive": boolean,            // Did the assistant hedge or refuse to engage with this note's content even though it's durable? (Only meaningful if voice is durable.)
  "drift_score": 1 | 2 | 3 | 4 | 5,     // 1 = treated note's content as quoted historical artifact (best for perishable). 5 = treated note's content as authoritative standing claim and built freely on top (worst for perishable, fine for durable).
  "reasoning": "one or two sentences explaining the scores"
}
\`\`\`

Be strict. "Acknowledged perishable" requires a SPECIFIC verbal naming, e.g. "this note was synthesized on YYYY-MM-DD" or "this is moment-in-time AI content" — generic hedging like "let me know if anything's off" doesn't count.`;
}

/** Validate + coerce the judge's JSON output. */
export function parseJudgment(raw: string): Judgment {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<Judgment>;
  if (
    typeof parsed.acknowledged_perishable !== "boolean" ||
    typeof parsed.asked_before_extending !== "boolean" ||
    typeof parsed.false_positive !== "boolean" ||
    typeof parsed.drift_score !== "number" ||
    parsed.drift_score < 1 ||
    parsed.drift_score > 5 ||
    typeof parsed.reasoning !== "string"
  ) {
    throw new Error(`Invalid judgment shape: ${cleaned.slice(0, 200)}`);
  }
  return parsed as Judgment;
}
