/**
 * P22-5 — shared cost ceiling helper for skill executors.
 *
 * Three exports:
 *   - `estimateRunCost(vaultSize) → number`: pre-call token estimate from
 *     the executor's input shape (count of flags + discovery rows the
 *     executor plans to feed the model).
 *   - `exceededCeiling(estimate, ceiling) → boolean`: predicate.
 *   - `recordRunCost(slug, tokens)`: bumps an in-process ledger keyed by
 *     skill slug. Read via `readCostLedger`; reset via `resetCostLedger`
 *     (used by tests).
 *
 * Scope Cop SHRINK #1 (Phase 22 revision note #5): no `shouldSample` —
 * executors hard-fail on ceiling exceeded. A partial-but-cheap run hides
 * real cost from the user and fragments the dashboard's mental model.
 * Either the run fits the ceiling or it returns a surface artifact
 * explaining the vault is too large for this tick.
 *
 * The token weights are conservative per-row estimates tuned to the
 * daily-vault-review prompt shape; future executors that read different
 * row shapes pass their own weights.
 */

/** Default per-row weights for the daily-vault-review style prompt. */
export const DEFAULT_TOKENS_PER_FLAG = 280;
export const DEFAULT_TOKENS_PER_DISCOVERY = 220;
export const DEFAULT_TOKENS_PROMPT_OVERHEAD = 800;
export const DEFAULT_TOKENS_PER_OUTPUT_TASK = 240;

/**
 * Input shape for `estimateRunCost`. The two counts are the input rows
 * the executor will feed into the prompt; `outputTasks` is the cap on
 * tool-call output (the LLM emits at most this many proposed review
 * tasks).
 */
export interface VaultSize {
  flagsCount: number;
  discoveryCount: number;
  outputTasks?: number;
  tokensPerFlag?: number;
  tokensPerDiscovery?: number;
  tokensPromptOverhead?: number;
  tokensPerOutputTask?: number;
}

/**
 * Estimate the total token cost (input + output) for one executor run.
 *
 * Returns a single integer so the caller can compare directly against
 * an integer ceiling. Per-row weights are overridable so a different
 * skill can reuse this helper with its own prompt shape.
 */
export function estimateRunCost(size: VaultSize): number {
  const perFlag = size.tokensPerFlag ?? DEFAULT_TOKENS_PER_FLAG;
  const perDiscovery = size.tokensPerDiscovery ?? DEFAULT_TOKENS_PER_DISCOVERY;
  const overhead = size.tokensPromptOverhead ?? DEFAULT_TOKENS_PROMPT_OVERHEAD;
  const perOutputTask =
    size.tokensPerOutputTask ?? DEFAULT_TOKENS_PER_OUTPUT_TASK;
  const outputTasks = size.outputTasks ?? 4;

  const inputTokens =
    overhead + size.flagsCount * perFlag + size.discoveryCount * perDiscovery;
  const outputTokens = outputTasks * perOutputTask;
  return inputTokens + outputTokens;
}

/** Returns true when the estimate strictly exceeds the ceiling. */
export function exceededCeiling(estimate: number, ceiling: number): boolean {
  return estimate > ceiling;
}

interface CostRecord {
  totalTokens: number;
  runs: number;
}

const ledger = new Map<string, CostRecord>();

/**
 * Record a completed run's actual token consumption. Aggregated in-
 * process per skill slug — read via `readCostLedger`. Persistent
 * accounting (vault_usage_daily, billing) lands in a later phase; the
 * in-memory ledger is enough for tests + the runbook spot-check.
 */
export function recordRunCost(skillSlug: string, tokens: number): void {
  const existing = ledger.get(skillSlug) ?? { totalTokens: 0, runs: 0 };
  existing.totalTokens += tokens;
  existing.runs += 1;
  ledger.set(skillSlug, existing);
}

/** Read the in-process cost ledger (test + diagnostics helper). */
export function readCostLedger(): ReadonlyMap<string, Readonly<CostRecord>> {
  return ledger;
}

/** Reset the in-process cost ledger (test helper). */
export function resetCostLedger(): void {
  ledger.clear();
}
