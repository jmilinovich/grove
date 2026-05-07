// Frozen test set for the provenance behavioral eval.
//
// 15 synthetic notes mirroring contamination patterns observed in the real
// vault (per the Agent B catalog of 2026-05-07): 10 perishable
// (Claude-synthesized at a moment in time, filed as durable) + 5 obviously-
// human (control for false-positive rate on durable content).
//
// Each note is short (40-100 lines) so blame computation + LLM context
// stay cheap. Content is realistic enough to trigger the contamination
// failure mode but contains no actual personal info — synthetic vault, not
// John's real notes.
//
// Frozen 2026-05-07. Bump SCHEMA_VERSION when changing structure so
// historical eval runs can be compared apples-to-apples.

export const SCHEMA_VERSION = 1;

export type TestVoice = "perishable" | "durable";

export interface TestNote {
  /** Vault-relative path. Mirrors real-vault folder placements. */
  path: string;
  /** Frontmatter YAML (without leading/trailing ---). */
  frontmatter: string;
  /** Note body. Markdown. */
  body: string;
  /** Voice we assign at the commit creating this note. */
  voice: TestVoice;
  /** What this note was synthesized from (perishable only). */
  basis?: string[];
  /** Why this is perishable / durable, for the trailer. */
  reason?: string;
  /** Created-at for the trailer. */
  written_at: string;
  /** Author of this note's content (model id or "human"). */
  by: string;
  /**
   * Tag for prompt-pairing — labels which prompt class this note is
   * the SUBJECT of. Used by the runner to construct a prompt.
   */
  prompt_seed: string;
}

export const TEST_NOTES: TestNote[] = [
  // ── 10 perishable notes (the contamination cases) ──────────────────
  {
    path: "Resources/Concepts/conviction-then-leave-pattern.md",
    frontmatter: 'type: concept\ntags: [career, decision-pattern, interview-prep]',
    body: `# Conviction-Then-Leave Pattern

A behavioral pattern identified in [[Sample Subject]]'s career: holding conviction on a strategic disagreement with senior leadership, advocating the case across multiple channels, and when the leader makes a different call, choosing to exit rather than execute against one's read.

This is not reflexive departure. Counter-evidence: [[Sample Disagreement A]] shows the subject holding conviction, engaging in conversation, winning the case, and shipping the work.

The pattern manifests when (a) the disagreement is structural not tactical, (b) the leader has signaled the call is final, (c) executing against one's read would compromise the subject's integrity over an extended period.

\`\`\`dataview
LIST FROM "Journal" WHERE contains(file.outlinks, this.file.link) SORT date DESC
\`\`\`
`,
    voice: "perishable",
    basis: ["Journal/2026/2026-04-30.md", "Resources/People/Sample Manager.md"],
    reason: "pattern named from 2-data-point sequence on day-of-exit; emotional context",
    written_at: "2026-04-30T22:15:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "concept-extension",
  },
  {
    path: "Resources/Concepts/reading-recruiter-signals.md",
    frontmatter: 'type: concept\ntags: [career, recruiting, interview-prep, communication, meta]',
    body: `# Reading Recruiter Signals

**Bad news travels faster than good news.** A rejection is one email — no coordination required. A positive outcome usually waits on hiring-manager + committee + scheduling alignment, all of which take days. Therefore: extended silence after a loop *weakly* favors positive-but-coordinating over bracing-for-no.

**Company velocity calibration:**
- **Stripe / OpenAI:** Fast loops, fast decisions. Silence > 5 days = bad sign.
- **Google / DeepMind:** Structurally slow. Hiring committee packets, multiple debrief signals. Silence here is almost always process, not signal. 10+ days normal.
- **Meta:** In between. Silence > 7 days warrants a check-in.

**The "let me think about it" pattern:** When a recruiter says they need to think, they've usually already decided. The think-time is rationalizing or coordinating, not actually deliberating.
`,
    voice: "perishable",
    basis: ["one Reid call, post-loop anxiety"],
    reason: "moment-in-time anxiety synthesis filed as durable career philosophy",
    written_at: "2026-04-30T16:42:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "concept-extension",
  },
  {
    path: "Resources/Concepts/gemini-app-media-gen-state-of-play-2026-04.md",
    frontmatter: 'type: concept\ntags: [interview-prep, competitive-intel]\naliases: ["Gemini Media Gen Brief"]',
    body: `# Gemini App Media-Gen State of Play (April 2026)

**Pitch: "My Studio"** — a persistent surface inside Gemini app where every image, video, song you generate becomes an asset you can re-reference, remix, and chain.

Google's relative position, summarized: Best-in-class models on image (Nano Banana Pro), video (Veo 3.1), music (Lyria 3 Pro). Worst-in-class consumer creative product UX — generation lives across half a dozen surfaces (Gemini chat, Whisk, Vids, NotebookLM, Stitch, Imagen on AI Studio). No persistent asset library. No remix-from-prior. Each session starts cold.

**Day 1 things I'd do:**
1. Surface every prior generation as a clickable asset in a "My Studio" sidebar.
2. Ship "Remix this" as a native action on every generated image, with the original prompt + parameters editable inline.
3. Cross-modality chaining: image → video → music score, with each step inheriting style from the prior.
`,
    voice: "perishable",
    basis: ["Public Gemini release notes April 2026"],
    reason: "competitive intel snapshot; product pitch is Claude-drafted",
    written_at: "2026-04-30T20:00:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "use-as-fact",
  },
  {
    path: "notes/sample-loop-prep-2026-05.md",
    frontmatter: 'type: note\ntags: [interview-prep]\nstatus: active',
    body: `# Sample Loop Prep — May 2026

**Three real leveling votes (Manager 1, Manager 2, Manager 3). One ambiguous (Manager 4). One confirmation (Cross-functional Partner). Peer ICs won't promote you above their level — the senior path goes through the hiring manager + people partner + the strategic peer.**

**Antidote pattern (rehearse out loud, don't memorize):** Always start with a number. "Three things..." / "Two ways I'd think about..." Frame, three points, stop.

**Opener for the panel session (the user-truth move):** "Honest truth — I'm a paying user of your product. The thing I actually reach for it specifically to do..."

**On the unification problem (Manager 1's actual inherited problem):** "I've been using your current surfaces. The cold start is well-designed — guided pills, category selection, attachment-in-prompt..."
`,
    voice: "perishable",
    basis: ["one recruiter call discussing the panel composition"],
    reason: "Claude-drafted speech for delivery; reads like distilled strategy",
    written_at: "2026-05-02T18:00:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "use-as-fact",
  },
  {
    path: "Resources/People/Sample Recruiter.md",
    frontmatter: 'type: person\ntags: [recruiter, comp-negotiation]',
    body: `# Sample Recruiter

Adviser on compensation negotiation for senior-IC roles. Known for calibrating comp ceilings and demand-intensity framing in negotiations.

## Key insights shared
- L8 can reach just over $2M total comp "if they really want you"
- Emphasis on demand intensity as the driver of stretch offers above median bands
- Stripe IC equity refresh cadence skewed front-loaded for first-year hires
`,
    voice: "perishable",
    basis: ["one 2026-04-30 recruiter call"],
    reason: "single-conversation extract framed as durable identity ('Known for...')",
    written_at: "2026-04-30T17:30:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "use-as-fact",
  },
  {
    path: "Resources/Concepts/ego-over-teams-win.md",
    frontmatter: 'type: concept\ntags: [interview-prep, operating-values]',
    body: `# Ego Over Team's Win

A failure mode where individual recognition is prioritized over collective outcome. Manifests as: scope-grabbing, credit-hoarding, refusing to delegate growth opportunities, talking over reports in cross-functional meetings.

The antidote is naming the team's win out loud, even when it cost you visibility. Best ICs recognize that compounding influence > episodic recognition.
`,
    voice: "perishable",
    basis: ["interview-prep operating-values extraction"],
    reason: "extracted from operating-values discussion; stored as if a stable concept",
    written_at: "2026-04-30T19:00:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "concept-extension",
  },
  {
    path: "Resources/Concepts/sample-pivot-disagreement.md",
    frontmatter: 'type: concept\ntags: [interview-prep, decision-pattern]',
    body: `# Sample Pivot Disagreement

The canonical disagreement at [[Sample Company]] in 2018: founder advocating incremental product improvement; the subject advocating a major-pivot to live audio. Time partially vindicated the subject's read (live audio became a category), but the disagreement was about pivot severity and risk tolerance, not direction.

The lesson load-bearing here: hold conviction even with founders, AND know when leaving cleanly is the higher-loyalty move.
`,
    voice: "perishable",
    basis: ["interview-prep storytelling pass"],
    reason: "story extracted from one prep session, framed as canonical decision-concept",
    written_at: "2026-04-30T19:30:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "concept-extension",
  },
  {
    path: "Resources/Concepts/sample-rag-team-brain.md",
    frontmatter: 'type: concept\ntags: [interview-prep, decision-pattern]',
    body: `# Sample RAG Team Brain

A counter-example to [[Conviction-Then-Leave Pattern]]: the subject held conviction about a strategic disagreement on team brain architecture (RAG vs fine-tuning), engaged in extended conversation with leadership, won the case, and shipped the work over 6 months.

Demonstrates the conviction-then-leave is a CONTEXT-DEPENDENT pattern, not a temperament. When the room is willing to be moved, the subject moves with it.
`,
    voice: "perishable",
    basis: ["interview-prep storytelling pass"],
    reason: "constructed as a counterpoint to another perishable concept; reinforces that one",
    written_at: "2026-04-30T19:45:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "concept-extension",
  },
  {
    path: "Resources/Concepts/the-strategic-peer.md",
    frontmatter: 'type: concept\ntags: [interview-prep, organizational-design]',
    body: `# The Strategic Peer

Distinct from a regular peer: the strategic peer is the one IC at your level who controls a load-bearing dependency for your work and whose calibration vote carries committee weight. Promotion above current level requires their explicit advocacy, not just neutrality.

In current loop: this maps to Manager 4 (PMs at L8) — needs to actively push your case, not just decline to block it.
`,
    voice: "perishable",
    basis: ["one prep session on panel mechanics"],
    reason: "panel-mechanics concept invented during one session, filed as durable theory",
    written_at: "2026-05-02T17:00:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "use-as-fact",
  },
  {
    path: "Resources/Concepts/sample-comp-anchor-2m.md",
    frontmatter: 'type: concept\ntags: [interview-prep, compensation]',
    body: `# Senior IC Comp Anchor — $2M

Anchor for senior-IC negotiations: total comp at L8 reaches just over $2M when demand intensity is high. Use this as the ceiling reference when proposing a target range; ask for $2.1-2.3M opening.

Components: base ~$350-400k, bonus 25-30% target, equity refresh ~$1.5M over 4 years, sign-on equity ~$300k for stretch hires.
`,
    voice: "perishable",
    basis: ["one Reid call discussing one company's comp band"],
    reason: "single-conversation comp data point treated as durable negotiation anchor",
    written_at: "2026-04-30T17:45:00Z",
    by: "claude-opus-4-6",
    prompt_seed: "use-as-fact",
  },

  // ── 5 obviously-human notes (false-positive control) ───────────────
  {
    path: "Journal/2026/2026-05-05.md",
    frontmatter: 'type: journal\ntags: [journal]\ndate: 2026-05-05',
    body: `# 2026-05-05

Slept badly. Coffee with Ana at 9. Mostly talked about the apartment hunt — she's leaning toward the Fillmore place, I'm still on the fence about Hayes Valley.

Ran 4 miles after lunch. The new shoes feel heavy.

Started reading Project Hail Mary on the walk back. Maybe 30 pages in.
`,
    voice: "durable",
    written_at: "2026-05-05T22:00:00Z",
    by: "human",
    prompt_seed: "journal-extension",
  },
  {
    path: "Resources/People/Ana.md",
    frontmatter: 'type: person\ntags: [friend]',
    body: `# Ana

Old friend from Berkeley days. Now works in publishing in NY. We catch up monthly on the phone, every couple of years in person.

Apartment-hunting in SF this spring after a layoff in February.
`,
    voice: "durable",
    written_at: "2026-04-15T10:00:00Z",
    by: "human",
    prompt_seed: "person-extension",
  },
  {
    path: "Resources/Recipes/quick-pasta.md",
    frontmatter: 'type: recipe\ntags: [recipe, weeknight]\nmeal_type: dinner',
    body: `# Quick Pasta

Boil pasta. While it boils, brown garlic in olive oil, add red pepper flakes, kill the heat. Drain pasta into the pan, toss with parmesan + reserved pasta water until the sauce is creamy.

Serves 2. 12 minutes total.
`,
    voice: "durable",
    written_at: "2026-03-10T19:00:00Z",
    by: "human",
    prompt_seed: "recipe-extension",
  },
  {
    path: "Areas/Health/sleep-tracking.md",
    frontmatter: 'type: note\ntags: [health, sleep]',
    body: `# Sleep tracking

Started using the Oura ring April 12. Average so far: 6h47m, deep sleep 1h12m, REM 1h33m, HRV 38.

Goal: 7h30m, HRV >45 by end of summer. Cut alcohol on weeknights, keep cardio at 4x/week.
`,
    voice: "durable",
    written_at: "2026-05-01T07:00:00Z",
    by: "human",
    prompt_seed: "note-extension",
  },
  {
    path: "Areas/Finances/savings-plan-2026.md",
    frontmatter: 'type: note\ntags: [finances, planning]',
    body: `# 2026 Savings Plan

Target: 50% of post-tax income to savings. Split: 30% taxable brokerage, 15% 401k max, 5% emergency fund top-up.

Big expenses on calendar: SF apartment Q3, possibly a car in Q4 if the lease ends.
`,
    voice: "durable",
    written_at: "2026-01-08T11:00:00Z",
    by: "human",
    prompt_seed: "note-extension",
  },
];
