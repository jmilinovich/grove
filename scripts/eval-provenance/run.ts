#!/usr/bin/env tsx
//
// Eval runner — the kill-switch for Phase A of the provenance project.
//
// Usage:
//   tsx scripts/eval-provenance/run.ts --dry-run [--out=DIR]
//   tsx scripts/eval-provenance/run.ts --execute [--out=DIR] [--model=MODEL] [--limit=N]
//
// --dry-run:    Materializes the synthetic vault, computes blame for every
//               test note, builds every (note × prompt × condition) cell,
//               and writes the assembled prompts to ./eval-out/cells/.
//               No Claude API calls. Cheap, deterministic, reviewable.
//
// --execute:    Same as --dry-run, then calls Claude (default Opus 4.7) for
//               every cell + the judge (Sonnet 4.6) for every response.
//               Aggregates results and prints a go/no-go summary. Requires
//               ANTHROPIC_API_KEY in env.
//
// --limit=N     Only run the first N cells. Useful for sanity-checking on
//               cheap iterations before committing to the full sweep.
//
// Pass bar (Phase A go/no-go):
//   - condition D: acknowledged_perishable >= 0.85 on perishable notes
//   - condition D: false_positive <= 0.10 on durable notes
//   - condition D: mean drift_score <= 2.0 on perishable notes
//   - condition D - condition A: acknowledgment lift >= 0.40 absolute
//
// On pass: ship Phase A; proceed to Phase B (classifier + bulk backfill).
// On fail: stop, iterate prompt-side, do not scale backfill.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { recomputeProvenanceBlame, type BlameSegment } from "../../src/blame.js";
import { prepareTestVault, type PreparedNote } from "./setup-vault.js";
import { CONDITIONS, type ConditionId, type ConditionSpec } from "./conditions.js";
import { PROMPT_CLASSES, classesFor, titleFromPath, type PromptClassId } from "./prompts.js";
import {
  buildJudgePrompt,
  parseJudgment,
  JUDGE_MODEL,
  type Judgment,
} from "./judge.js";

interface CellInput {
  cell_id: string;
  note: PreparedNote;
  blame: BlameSegment[];
  prompt_class: PromptClassId;
  condition: ConditionSpec;
  user_prompt: string;
  system_prompt: string;
  /** The shaped tool response (what Claude "sees" back from get) */
  tool_response: Record<string, unknown>;
}

interface CellResult {
  cell_id: string;
  note_path: string;
  voice: "perishable" | "durable";
  prompt_class: PromptClassId;
  condition: ConditionId;
  user_prompt: string;
  assistant_response?: string;
  judgment?: Judgment;
  error?: string;
}

interface Aggregate {
  per_condition: Record<
    ConditionId,
    {
      perishable_count: number;
      durable_count: number;
      acknowledged_perishable_rate: number;
      asked_before_extending_rate: number;
      false_positive_rate_durable: number;
      drift_mean_perishable: number;
    }
  >;
  pass: boolean;
  fail_reasons: string[];
  lift_D_vs_A_acknowledgment: number;
}

const DEFAULT_MODEL = "claude-opus-4-7";

function parseArgs(argv: string[]): {
  mode: "dry-run" | "execute";
  out: string;
  model: string;
  limit: number;
} {
  const opts = {
    mode: "dry-run" as "dry-run" | "execute",
    out: "./eval-out",
    model: DEFAULT_MODEL,
    limit: Number.MAX_SAFE_INTEGER,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.mode = "dry-run";
    else if (arg === "--execute") opts.mode = "execute";
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg.startsWith("--model=")) opts.model = arg.slice(8);
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice(8));
  }
  return opts;
}

async function buildCells(vaultPath: string, notes: PreparedNote[]): Promise<CellInput[]> {
  const cells: CellInput[] = [];
  for (const note of notes) {
    const blame = await recomputeProvenanceBlame(vaultPath, note.test.path);
    const classes = classesFor(note.test.prompt_seed);
    for (const promptClass of classes) {
      const promptDef = PROMPT_CLASSES[promptClass];
      const userPrompt = promptDef.build(note.test.path, titleFromPath(note.test.path));
      for (const condition of CONDITIONS) {
        const tool_response = condition.shapeResponse(note, blame);
        const system = buildSystemPrompt(condition, tool_response);
        cells.push({
          cell_id: `${note.test.path.replace(/[/.]/g, "_")}__${promptClass}__${condition.id}`,
          note,
          blame,
          prompt_class: promptClass,
          condition,
          user_prompt: userPrompt,
          system_prompt: system,
          tool_response,
        });
      }
    }
  }
  return cells;
}

function buildSystemPrompt(condition: ConditionSpec, toolResponse: Record<string, unknown>): string {
  // Simulate the calling environment: a system prompt that sets up Claude
  // as a knowledge-vault assistant, with the get tool description spliced
  // in (per condition), then the tool response payload as if a get call
  // had just returned it.
  const baseSystem =
    "You are an AI assistant helping the user work with their personal knowledge vault. The user just asked a question that involves a specific note. Below is the response from the `get` tool that returned that note.";
  const directive = condition.systemAddendum
    ? `\n\nNOTE-USAGE DIRECTIVE: ${condition.systemAddendum}`
    : "";
  const toolBlock = `\n\n--- get tool response ---\n${JSON.stringify(toolResponse, null, 2)}\n--- end of get response ---`;
  return baseSystem + directive + toolBlock;
}

async function executeCell(client: Anthropic, model: string, cell: CellInput): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: cell.system_prompt,
    messages: [{ role: "user", content: cell.user_prompt }],
  });
  return response.content[0]?.type === "text" ? response.content[0].text : "";
}

async function judgeCell(
  client: Anthropic,
  cell: CellInput,
  assistantResponse: string,
): Promise<Judgment> {
  const prompt = buildJudgePrompt({
    test_note: cell.note.test,
    prompt_class: cell.prompt_class,
    condition: cell.condition.id,
    user_prompt: cell.user_prompt,
    assistant_response: assistantResponse,
  });
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  return parseJudgment(text);
}

function aggregate(results: CellResult[]): Aggregate {
  const byCondition = new Map<ConditionId, CellResult[]>();
  for (const r of results) {
    if (!r.judgment) continue;
    const arr = byCondition.get(r.condition) ?? [];
    arr.push(r);
    byCondition.set(r.condition, arr);
  }

  const perCondition = {} as Aggregate["per_condition"];
  for (const [cond, rs] of byCondition) {
    const perishable = rs.filter((r) => r.voice === "perishable");
    const durable = rs.filter((r) => r.voice === "durable");
    perCondition[cond] = {
      perishable_count: perishable.length,
      durable_count: durable.length,
      acknowledged_perishable_rate:
        perishable.length === 0
          ? 0
          : perishable.filter((r) => r.judgment?.acknowledged_perishable).length / perishable.length,
      asked_before_extending_rate:
        perishable.length === 0
          ? 0
          : perishable.filter((r) => r.judgment?.asked_before_extending).length / perishable.length,
      false_positive_rate_durable:
        durable.length === 0
          ? 0
          : durable.filter((r) => r.judgment?.false_positive).length / durable.length,
      drift_mean_perishable:
        perishable.length === 0
          ? 0
          : perishable.reduce((sum, r) => sum + (r.judgment?.drift_score ?? 0), 0) / perishable.length,
    };
  }

  const D = perCondition.D;
  const A = perCondition.A;
  const lift = D && A ? D.acknowledged_perishable_rate - A.acknowledged_perishable_rate : 0;

  const reasons: string[] = [];
  if (!D) reasons.push("no condition-D results");
  else {
    if (D.acknowledged_perishable_rate < 0.85)
      reasons.push(
        `D.acknowledged_perishable_rate=${D.acknowledged_perishable_rate.toFixed(2)} < 0.85`,
      );
    if (D.false_positive_rate_durable > 0.1)
      reasons.push(
        `D.false_positive_rate_durable=${D.false_positive_rate_durable.toFixed(2)} > 0.10`,
      );
    if (D.drift_mean_perishable > 2.0)
      reasons.push(`D.drift_mean_perishable=${D.drift_mean_perishable.toFixed(2)} > 2.0`);
    if (lift < 0.4)
      reasons.push(`lift D-A on acknowledgment=${lift.toFixed(2)} < 0.40`);
  }

  return {
    per_condition: perCondition,
    pass: reasons.length === 0,
    fail_reasons: reasons,
    lift_D_vs_A_acknowledgment: lift,
  };
}

function printSummary(agg: Aggregate, results: CellResult[]): void {
  console.log("\n=== EVAL RESULTS ===\n");
  for (const id of ["A", "B", "C", "D", "E"] as ConditionId[]) {
    const c = agg.per_condition[id];
    if (!c) continue;
    console.log(`Condition ${id}:`);
    console.log(`  perishable_n=${c.perishable_count}, durable_n=${c.durable_count}`);
    console.log(`  acknowledged_perishable: ${(c.acknowledged_perishable_rate * 100).toFixed(1)}%`);
    console.log(`  asked_before_extending:  ${(c.asked_before_extending_rate * 100).toFixed(1)}%`);
    console.log(`  false_positive (durable):${(c.false_positive_rate_durable * 100).toFixed(1)}%`);
    console.log(`  drift_mean (perishable): ${c.drift_mean_perishable.toFixed(2)}`);
    console.log("");
  }
  console.log(`LIFT (D - A) on acknowledgment: ${(agg.lift_D_vs_A_acknowledgment * 100).toFixed(1)}%`);
  console.log("");
  if (agg.pass) {
    console.log("PASS — Phase A go-criteria met. Proceed to Phase B (classifier + backfill).");
  } else {
    console.log("FAIL — DO NOT scale backfill. Iterate prompt-side first.");
    for (const r of agg.fail_reasons) console.log(`  - ${r}`);
  }
  console.log(`\nCells run: ${results.length}`);
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) console.log(`Cells errored: ${errors.length}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (existsSync(opts.out)) rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  mkdirSync(join(opts.out, "cells"), { recursive: true });

  const vault = prepareTestVault();
  console.log(`Vault: ${vault.vaultPath}`);
  console.log(`Notes: ${vault.notes.length}`);

  const cells = await buildCells(vault.vaultPath, vault.notes);
  const limited = cells.slice(0, opts.limit);
  console.log(`Cells: ${cells.length} (running ${limited.length})`);
  console.log(`Mode: ${opts.mode}`);
  if (opts.mode === "execute") console.log(`Model: ${opts.model}`);

  // Always write cell prompts to disk for inspection.
  for (const cell of limited) {
    writeFileSync(
      join(opts.out, "cells", `${cell.cell_id}.json`),
      JSON.stringify(
        {
          cell_id: cell.cell_id,
          note_path: cell.note.test.path,
          voice: cell.note.test.voice,
          prompt_class: cell.prompt_class,
          condition: cell.condition.id,
          system_prompt: cell.system_prompt,
          user_prompt: cell.user_prompt,
        },
        null,
        2,
      ),
    );
  }
  console.log(`Wrote ${limited.length} cell prompts to ${opts.out}/cells/`);

  if (opts.mode === "dry-run") {
    console.log("\nDry-run complete. To execute, re-run with --execute (requires ANTHROPIC_API_KEY).");
    vault.cleanup();
    return;
  }

  // Execute mode: call Claude + judge for every cell.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("--execute requires ANTHROPIC_API_KEY in env");
    vault.cleanup();
    process.exit(1);
  }

  const client = new Anthropic();
  const results: CellResult[] = [];

  for (const [i, cell] of limited.entries()) {
    process.stdout.write(`[${i + 1}/${limited.length}] ${cell.cell_id} ... `);
    const result: CellResult = {
      cell_id: cell.cell_id,
      note_path: cell.note.test.path,
      voice: cell.note.test.voice,
      prompt_class: cell.prompt_class,
      condition: cell.condition.id,
      user_prompt: cell.user_prompt,
    };
    try {
      const response = await executeCell(client, opts.model, cell);
      result.assistant_response = response;
      writeFileSync(
        join(opts.out, "cells", `${cell.cell_id}.response.txt`),
        response,
      );
      const judgment = await judgeCell(client, cell, response);
      result.judgment = judgment;
      writeFileSync(
        join(opts.out, "cells", `${cell.cell_id}.judgment.json`),
        JSON.stringify(judgment, null, 2),
      );
      console.log(
        `${cell.note.test.voice} | ack=${judgment.acknowledged_perishable} | drift=${judgment.drift_score}`,
      );
    } catch (err) {
      result.error = (err as Error).message;
      console.log(`ERROR: ${result.error}`);
    }
    results.push(result);
  }

  writeFileSync(join(opts.out, "results.json"), JSON.stringify(results, null, 2));

  const agg = aggregate(results);
  writeFileSync(join(opts.out, "aggregate.json"), JSON.stringify(agg, null, 2));
  printSummary(agg, results);

  vault.cleanup();

  process.exit(agg.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
