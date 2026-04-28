import { describe, it, expect } from "vitest";
import { HELP, printCommandHelp } from "../../src/cli.js";

// ── HELP system: contract over the whole map ────────────────────────

describe("HELP", () => {
  const expectedCommands = [
    "search", "read", "list", "write", "delete", "move", "init",
    "graph", "digest", "health", "metrics",
    "status", "history", "diagnostics",
    "keys", "trails", "vault", "sync", "ingest", "import", "lint", "snapshot", "rollback",
    "whoami", "tag-backfill",
  ];

  it("has entries for all commands", () => {
    for (const cmd of expectedCommands) {
      expect(HELP[cmd], `missing HELP entry for '${cmd}'`).toBeDefined();
    }
  });

  it("every entry has usage, description, and json_schema", () => {
    for (const [cmd, h] of Object.entries(HELP)) {
      expect(h.usage, `${cmd}.usage`).toContain("grove");
      expect(h.description, `${cmd}.description`).toBeTruthy();
      expect(h.json_schema, `${cmd}.json_schema`).toBeTruthy();
    }
  });

  it("every entry has exit codes", () => {
    for (const [cmd, h] of Object.entries(HELP)) {
      expect(h.exit_codes, `${cmd}.exit_codes`).toContain("0=success");
    }
  });
});

describe("printCommandHelp", () => {
  it("formats known command help", () => {
    const out = printCommandHelp("search");
    expect(out).toContain("grove search");
    expect(out).toContain("JSON:");
    expect(out).toContain("Exit:");
  });

  it("returns error for unknown command", () => {
    const out = printCommandHelp("nonexistent");
    expect(out).toContain("Unknown command");
  });

  it("renders a real help block for `import` (not 'Unknown command')", () => {
    // Regression for the bug Sumon hit on 2026-04-28: the dispatcher routed
    // `grove import` correctly but the HELP table had no entry, so
    // `grove import --help` printed "Unknown command: import."
    const out = printCommandHelp("import");
    expect(out).not.toContain("Unknown command");
    expect(out).toContain("grove import");
    expect(out).toContain("--source");
  });

  it("includes flags section when flags exist", () => {
    const out = printCommandHelp("write");
    expect(out).toContain("Flags:");
    expect(out).toContain("--content");
    expect(out).toContain("--type");
  });

  it("includes examples when present", () => {
    const out = printCommandHelp("search");
    expect(out).toContain("Examples:");
    expect(out).toContain("taste graph");
  });
});

// ── HELP: per-command entries (ingest, vault, delete, move) ───────
// Per-command HELP shape contract — same for each command, parametrized.
// Each row asserts: the HELP entry exists with expected usage/description/
// json_schema bits, declares the listed flags, and that printCommandHelp
// renders the listed substrings.

interface HelpExpectations {
  usageContains: string[];
  descriptionMatches?: RegExp;
  jsonSchemaMatches: RegExp;
  flagSubstrings?: string[];
  exampleSubstring?: string;
  printContains: string[];
}

const HELP_CASES: [string, HelpExpectations][] = [
  ["ingest", {
    usageContains: ["grove ingest"],
    descriptionMatches: /Import/i,
    jsonSchemaMatches: /imported/,
    flagSubstrings: ["dry-run"],
    printContains: ["grove ingest", "dry-run", "Examples:"],
  }],
  ["import", {
    usageContains: ["grove import", "--source"],
    descriptionMatches: /fs|sources|bookmarks/,
    jsonSchemaMatches: /imported/,
    flagSubstrings: ["--source", "--apply", "--plan"],
    exampleSubstring: "--source=fs",
    printContains: ["grove import", "--source", "Examples:"],
  }],
  ["vault", {
    usageContains: ["grove vault", "status", "encrypt", "unlock", "lock"],
    descriptionMatches: /encrypt/i,
    jsonSchemaMatches: /encrypted/,
    exampleSubstring: "GROVE_VAULT_PASSPHRASE",
    printContains: ["grove vault", "Examples:", "GROVE_VAULT_PASSPHRASE"],
  }],
  ["delete", {
    usageContains: ["grove delete"],
    jsonSchemaMatches: /action.*archived.*deleted/s,
    flagSubstrings: ["--hard", "--yes"],
    printContains: ["grove delete", "--hard", "Examples:"],
  }],
  ["move", {
    usageContains: ["grove move", "<from>", "<to>"],
    jsonSchemaMatches: /links_updated/,
    printContains: ["grove move", "Examples:"],
  }],
];

describe.each(HELP_CASES)("HELP %s", (cmd, expectations) => {
  it("entry meets the per-command shape contract", () => {
    const help = HELP[cmd];
    expect(help, `HELP.${cmd}`).toBeDefined();
    for (const fragment of expectations.usageContains) {
      expect(help.usage).toContain(fragment);
    }
    if (expectations.descriptionMatches) {
      expect(help.description).toMatch(expectations.descriptionMatches);
    }
    expect(help.json_schema).toMatch(expectations.jsonSchemaMatches);
    expect(help.exit_codes).toContain("0=success");
    if (expectations.flagSubstrings) {
      const flags = help.flags?.join("\n") ?? "";
      for (const f of expectations.flagSubstrings) expect(flags).toContain(f);
    }
    if (expectations.exampleSubstring) {
      expect(help.examples?.some((e) => e.includes(expectations.exampleSubstring!))).toBe(true);
    }
  });

  it("printCommandHelp renders the entry", () => {
    const out = printCommandHelp(cmd);
    for (const fragment of expectations.printContains) {
      expect(out).toContain(fragment);
    }
  });
});
