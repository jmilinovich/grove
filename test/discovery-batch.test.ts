import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock vault-ops so wireLinks doesn't need a real git repo (mirrors
// the pattern used in test/discovery-link.test.ts).
vi.mock("../src/vault-ops.js", () => ({
  gitCommit: vi.fn().mockResolvedValue("abc1234"),
  qmdReindex: vi.fn().mockResolvedValue(undefined),
  // listNotes is read by buildVocabulary -> _vocabInternals.buildVocabulary.
  // Return an empty vocab so the batch builder has predictable input.
  listNotes: vi.fn().mockReturnValue([]),
}));

import {
  closeDb,
  createSchema,
  dequeueDiscoveryUrgent,
  discoveryQueueDepth,
  enqueueDiscovery,
  finalizeBatch,
  getBatchedRows,
  getDb,
  insertDiscoveryBatch,
  listOpenBatches,
  markRowsBatched,
  recoverStaleBatched as dbRecoverStaleBatched,
  resetDb,
  type DiscoveryQueueEntry,
} from "../src/db.js";
import {
  _httpInternals,
  pollBatches,
  recoverStaleBatched,
  submitBatch,
  submitBatchTick,
} from "../src/discovery-batch.js";
import { tick, runDiscoveryCycle } from "../src/discovery.js";

const VAULT_ID = "vault_test_p7c5";
const TEST_API_KEY = "sk-ant-test";

/**
 * Build a tool_use Anthropic message shape. The batch results JSONL
 * format mirrors the realtime path's response: `result.message` is
 * exactly what `messages.create` returns.
 */
function mkToolUseMessage(input: object): any {
  return {
    id: "msg_test_01",
    type: "message",
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test_01",
        name: "extract_entities",
        input,
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function mkResponse(status: number, jsonBody: object | string, headers?: Record<string, string>): Response {
  const body = typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

describe("P7-COST-5: trigger classification (urgent vs batch-eligible)", () => {
  let tempDir: string;
  let vaultDir: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-batch-trigger-"));
    vaultDir = mkdtempSync(join(tmpdir(), "grove-batch-vault-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    process.env.ANTHROPIC_API_KEY = TEST_API_KEY;
    process.env.GROVE_DISCOVERY_COOLDOWN_MIN = "0";
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    delete process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("dequeueDiscoveryUrgent skips commit triggers", () => {
    enqueueDiscovery("a.md", "commit", VAULT_ID);
    enqueueDiscovery("b.md", "write", VAULT_ID);
    enqueueDiscovery("c.md", "ingest", VAULT_ID);
    enqueueDiscovery("d.md", "commit", VAULT_ID);
    enqueueDiscovery("e.md", "image_enrich", VAULT_ID);

    const claimed: string[] = [];
    while (true) {
      const row = dequeueDiscoveryUrgent(VAULT_ID);
      if (!row) break;
      claimed.push(row.path);
    }
    // Only urgent triggers are drained — both commits stay pending.
    expect(claimed.sort()).toEqual(["b.md", "c.md", "e.md"]);

    const stillPending = getDb()
      .prepare(
        "SELECT path FROM discovery_queue WHERE status = 'pending' AND vault_id = ? ORDER BY path",
      )
      .all(VAULT_ID) as { path: string }[];
    expect(stillPending.map((r) => r.path)).toEqual(["a.md", "d.md"]);
  });

  it("after a full discovery cycle, only commit rows are batched", async () => {
    // Set up vault files for the commit rows so the batch builder can
    // read them. Urgent triggers also need files because the default
    // processor reads them — but we'll use a stub processor.
    writeFileSync(join(vaultDir, "c1.md"), "Commit note 1");
    writeFileSync(join(vaultDir, "c2.md"), "Commit note 2");
    writeFileSync(join(vaultDir, "w1.md"), "Write note 1");
    process.env.GROVE_VAULT = vaultDir;

    enqueueDiscovery("c1.md", "commit", VAULT_ID);
    enqueueDiscovery("w1.md", "write", VAULT_ID);
    enqueueDiscovery("c2.md", "commit", VAULT_ID);

    // Mock the Anthropic submit endpoint.
    const fetchSpy = vi
      .spyOn(_httpInternals, "fetch")
      .mockImplementation(async (url) => {
        if (
          typeof url === "string" &&
          url.startsWith("https://api.anthropic.com/v1/messages/batches")
        ) {
          return mkResponse(200, { id: "msgbatch_xyz", processing_status: "in_progress" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

    const processed: string[] = [];
    await runDiscoveryCycle(async (entry) => {
      processed.push(entry.path);
    }, VAULT_ID);

    expect(processed).toEqual(["w1.md"]); // only urgent was drained
    expect(fetchSpy).toHaveBeenCalledTimes(1); // one batch POST

    // Both commit rows should now be batched
    const batched = getDb()
      .prepare(
        "SELECT path, status, batch_id FROM discovery_queue WHERE trigger = 'commit' ORDER BY path",
      )
      .all() as Array<{ path: string; status: string; batch_id: string | null }>;
    expect(batched).toHaveLength(2);
    expect(batched.every((r) => r.status === "batched")).toBe(true);
    expect(batched.every((r) => r.batch_id === "msgbatch_xyz")).toBe(true);

    const open = listOpenBatches(VAULT_ID);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe("msgbatch_xyz");
    expect(open[0].row_count).toBe(2);
  });
});

describe("P7-COST-5: phase A submission", () => {
  let tempDir: string;
  let vaultDir: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-batch-submit-"));
    vaultDir = mkdtempSync(join(tmpdir(), "grove-batch-submit-vault-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    process.env.ANTHROPIC_API_KEY = TEST_API_KEY;
    process.env.GROVE_DISCOVERY_COOLDOWN_MIN = "0";
    delete process.env.GROVE_DISCOVERY_DAILY_CAP;
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    delete process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
    delete process.env.GROVE_DISCOVERY_DAILY_CAP;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("submitBatch builds requests + marks rows batched + writes discovery_batches", async () => {
    const paths = ["n1.md", "n2.md", "n3.md"];
    for (const p of paths) {
      writeFileSync(join(vaultDir, p), `content for ${p}`);
      enqueueDiscovery(p, "commit", VAULT_ID);
    }

    let postBody: any = null;
    const fetchSpy = vi
      .spyOn(_httpInternals, "fetch")
      .mockImplementation(async (url, init) => {
        expect(url).toBe("https://api.anthropic.com/v1/messages/batches");
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-api-key"]).toBe(TEST_API_KEY);
        expect(headers["anthropic-version"]).toBe("2023-06-01");
        postBody = JSON.parse(init?.body as string);
        return mkResponse(200, { id: "msgbatch_abc", processing_status: "in_progress" });
      });

    const rows = getDb()
      .prepare("SELECT * FROM discovery_queue WHERE vault_id = ? ORDER BY id")
      .all(VAULT_ID) as DiscoveryQueueEntry[];

    const result = await submitBatch(vaultDir, VAULT_ID, rows);
    expect(result).toEqual({ batch_id: "msgbatch_abc", row_count: 3 });
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Custom IDs follow the row-<id> pattern so the poller can decode.
    expect(postBody.requests).toHaveLength(3);
    for (const req of postBody.requests) {
      expect(req.custom_id).toMatch(/^row-\d+$/);
      expect(req.params.model).toBe("claude-haiku-4-5-20251001");
      expect(req.params.tool_choice.name).toBe("extract_entities");
    }

    // Rows flipped to batched + carry batch_id.
    const dbRows = getDb()
      .prepare("SELECT path, status, batch_id FROM discovery_queue ORDER BY path")
      .all() as Array<{ path: string; status: string; batch_id: string | null }>;
    expect(dbRows.every((r) => r.status === "batched")).toBe(true);
    expect(dbRows.every((r) => r.batch_id === "msgbatch_abc")).toBe(true);

    // discovery_batches row written
    const batchRow = getDb()
      .prepare("SELECT * FROM discovery_batches WHERE id = ?")
      .get("msgbatch_abc") as { id: string; vault_id: string; row_count: number; status: string };
    expect(batchRow.vault_id).toBe(VAULT_ID);
    expect(batchRow.row_count).toBe(3);
    expect(batchRow.status).toBe("submitted");
  });

  it("submitBatchTick respects GROVE_DISCOVERY_BATCH_MAX_ROWS", async () => {
    process.env.GROVE_DISCOVERY_BATCH_MAX_ROWS = "2";
    try {
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(vaultDir, `n${i}.md`), `content ${i}`);
        enqueueDiscovery(`n${i}.md`, "commit", VAULT_ID);
      }

      let postBody: any = null;
      vi.spyOn(_httpInternals, "fetch").mockImplementation(async (url, init) => {
        if (typeof url === "string" && url.endsWith("/batches")) {
          postBody = JSON.parse(init?.body as string);
          return mkResponse(200, { id: "msgbatch_cap" });
        }
        throw new Error("unexpected");
      });

      const submitted = await submitBatchTick(vaultDir, VAULT_ID);
      expect(submitted).toBe(2);
      expect(postBody.requests).toHaveLength(2);

      // Three remaining commit rows still pending (no batch_id).
      const stillPending = getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM discovery_queue WHERE status = 'pending' AND trigger = 'commit'",
        )
        .get() as { n: number };
      expect(stillPending.n).toBe(3);
    } finally {
      delete process.env.GROVE_DISCOVERY_BATCH_MAX_ROWS;
    }
  });

  it("daily cap gates batch submission", async () => {
    process.env.GROVE_DISCOVERY_DAILY_CAP = "2";
    try {
      // Backfill one row as "already processed today" so remaining cap = 1.
      enqueueDiscovery("done-today.md", "write", VAULT_ID);
      const done = dequeueDiscoveryUrgent(VAULT_ID)!;
      getDb()
        .prepare(
          "UPDATE discovery_queue SET status='done', processed_at=datetime('now') WHERE id=?",
        )
        .run(done.id);

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(vaultDir, `c${i}.md`), `c${i}`);
        enqueueDiscovery(`c${i}.md`, "commit", VAULT_ID);
      }

      let postBody: any = null;
      vi.spyOn(_httpInternals, "fetch").mockImplementation(async (url, init) => {
        if (typeof url === "string" && url.endsWith("/batches")) {
          postBody = JSON.parse(init?.body as string);
          return mkResponse(200, { id: "msgbatch_cap2" });
        }
        throw new Error("unexpected");
      });

      const submitted = await submitBatchTick(vaultDir, VAULT_ID);
      // Only 1 of the daily cap is left — cap limits submission to 1.
      expect(submitted).toBe(1);
      expect(postBody.requests).toHaveLength(1);
    } finally {
      delete process.env.GROVE_DISCOVERY_DAILY_CAP;
    }
  });

  it("submitBatchTick is a no-op when no commit rows are eligible", async () => {
    enqueueDiscovery("urgent.md", "write", VAULT_ID);
    const fetchSpy = vi.spyOn(_httpInternals, "fetch");
    const submitted = await submitBatchTick(vaultDir, VAULT_ID);
    expect(submitted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submitBatchTick skips when ANTHROPIC_API_KEY is missing — rows stay pending", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    writeFileSync(join(vaultDir, "x.md"), "x");
    enqueueDiscovery("x.md", "commit", VAULT_ID);

    const fetchSpy = vi.spyOn(_httpInternals, "fetch");
    const submitted = await submitBatchTick(vaultDir, VAULT_ID);
    expect(submitted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Row still pending — it'll be re-tried once the key is set.
    const row = getDb()
      .prepare("SELECT status FROM discovery_queue WHERE path = 'x.md'")
      .get() as { status: string };
    expect(row.status).toBe("pending");
  });
});

describe("P7-COST-5: phase B polling", () => {
  let tempDir: string;
  let vaultDir: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-batch-poll-"));
    vaultDir = mkdtempSync(join(tmpdir(), "grove-batch-poll-vault-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    process.env.ANTHROPIC_API_KEY = TEST_API_KEY;
    process.env.GROVE_DISCOVERY_COOLDOWN_MIN = "0";
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    delete process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedBatchedRows(rowPaths: string[], batchId: string): number[] {
    const rowIds: number[] = [];
    for (const p of rowPaths) {
      writeFileSync(join(vaultDir, p), `content for ${p}`);
      enqueueDiscovery(p, "commit", VAULT_ID);
      const row = getDb()
        .prepare("SELECT id FROM discovery_queue WHERE path = ? AND vault_id = ?")
        .get(p, VAULT_ID) as { id: number };
      rowIds.push(row.id);
    }
    markRowsBatched(rowIds, batchId);
    insertDiscoveryBatch(batchId, VAULT_ID, rowIds.length);
    return rowIds;
  }

  it("does nothing when no batches are open", async () => {
    const fetchSpy = vi.spyOn(_httpInternals, "fetch");
    await pollBatches(vaultDir, VAULT_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves batch alone when still in_progress", async () => {
    seedBatchedRows(["p1.md"], "msgbatch_pending");

    vi.spyOn(_httpInternals, "fetch").mockImplementation(async (url) => {
      expect(typeof url === "string" && url.includes("msgbatch_pending")).toBe(true);
      return mkResponse(200, { id: "msgbatch_pending", processing_status: "in_progress" });
    });

    await pollBatches(vaultDir, VAULT_ID);

    // Row still batched, batch still submitted.
    const row = getDb()
      .prepare("SELECT status FROM discovery_queue WHERE path = 'p1.md'")
      .get() as { status: string };
    expect(row.status).toBe("batched");

    const batch = getDb()
      .prepare("SELECT status FROM discovery_batches WHERE id = 'msgbatch_pending'")
      .get() as { status: string };
    expect(batch.status).toBe("submitted");
  });

  it("resolves an ended batch: wires links + marks rows done + finalizes batch", async () => {
    const ids = seedBatchedRows(["e1.md", "e2.md"], "msgbatch_ended");
    const resultsUrl = "https://results.example.com/msgbatch_ended.jsonl";

    const jsonl = ids
      .map((id) => ({
        custom_id: `row-${id}`,
        result: {
          type: "succeeded",
          message: mkToolUseMessage({
            entities: [],
            suggested_links: [],
            new_notes: [],
          }),
        },
      }))
      .map((o) => JSON.stringify(o))
      .join("\n");

    const fetchSpy = vi
      .spyOn(_httpInternals, "fetch")
      .mockImplementation(async (url) => {
        if (typeof url === "string" && url.endsWith("/msgbatch_ended")) {
          return mkResponse(200, {
            id: "msgbatch_ended",
            processing_status: "ended",
            results_url: resultsUrl,
          });
        }
        if (url === resultsUrl) {
          return mkResponse(200, jsonl);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

    await pollBatches(vaultDir, VAULT_ID);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // status + results

    const rows = getDb()
      .prepare(
        "SELECT path, status FROM discovery_queue WHERE vault_id = ? ORDER BY path",
      )
      .all(VAULT_ID) as Array<{ path: string; status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);

    const batch = getDb()
      .prepare("SELECT status, completed_at FROM discovery_batches WHERE id = ?")
      .get("msgbatch_ended") as { status: string; completed_at: string | null };
    expect(batch.status).toBe("ended");
    expect(batch.completed_at).not.toBeNull();

    // Open-batches list now empty.
    expect(listOpenBatches(VAULT_ID)).toHaveLength(0);
  });

  it("per-row failure does not fail siblings", async () => {
    const ids = seedBatchedRows(["ok.md", "bad.md"], "msgbatch_mixed");
    const resultsUrl = "https://results.example.com/mixed.jsonl";

    // First row succeeds, second row errored.
    const lines = [
      JSON.stringify({
        custom_id: `row-${ids[0]}`,
        result: {
          type: "succeeded",
          message: mkToolUseMessage({
            entities: [],
            suggested_links: [],
            new_notes: [],
          }),
        },
      }),
      JSON.stringify({
        custom_id: `row-${ids[1]}`,
        result: {
          type: "errored",
          error: { type: "invalid_request_error", message: "schema mismatch" },
        },
      }),
    ].join("\n");

    vi.spyOn(_httpInternals, "fetch").mockImplementation(async (url) => {
      if (typeof url === "string" && url.endsWith("/msgbatch_mixed")) {
        return mkResponse(200, {
          id: "msgbatch_mixed",
          processing_status: "ended",
          results_url: resultsUrl,
        });
      }
      if (url === resultsUrl) return mkResponse(200, lines);
      throw new Error(`unexpected: ${url}`);
    });

    await pollBatches(vaultDir, VAULT_ID);

    const okRow = getDb()
      .prepare("SELECT status FROM discovery_queue WHERE path = 'ok.md'")
      .get() as { status: string };
    expect(okRow.status).toBe("done");

    const badRow = getDb()
      .prepare("SELECT status, error_message FROM discovery_queue WHERE path = 'bad.md'")
      .get() as { status: string; error_message: string | null };
    expect(badRow.status).toBe("error");
    expect(badRow.error_message).toContain("schema mismatch");

    // The batch as a whole still finalizes.
    const batch = getDb()
      .prepare("SELECT status FROM discovery_batches WHERE id = ?")
      .get("msgbatch_mixed") as { status: string };
    expect(batch.status).toBe("ended");
  });
});

describe("P7-COST-5: stale-batched recovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-batch-stale-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    process.env.GROVE_DISCOVERY_COOLDOWN_MIN = "0";
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    delete process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
    delete process.env.GROVE_DISCOVERY_BATCH_MAX_AGE_HOURS;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("flips long-batched rows back to pending+write, untouched recent ones stay", () => {
    enqueueDiscovery("ancient.md", "commit", VAULT_ID);
    enqueueDiscovery("recent.md", "commit", VAULT_ID);
    const ancientRow = getDb()
      .prepare("SELECT id FROM discovery_queue WHERE path = 'ancient.md'")
      .get() as { id: number };
    const recentRow = getDb()
      .prepare("SELECT id FROM discovery_queue WHERE path = 'recent.md'")
      .get() as { id: number };

    markRowsBatched([ancientRow.id, recentRow.id], "msgbatch_stale");
    insertDiscoveryBatch("msgbatch_stale", VAULT_ID, 2);

    // Backdate the ancient row's queued_at well past the default 26h.
    getDb()
      .prepare(
        "UPDATE discovery_queue SET queued_at = datetime('now', '-48 hours') WHERE id = ?",
      )
      .run(ancientRow.id);

    const recovered = recoverStaleBatched(VAULT_ID);
    expect(recovered).toBe(1);

    const ancient = getDb()
      .prepare("SELECT status, trigger FROM discovery_queue WHERE id = ?")
      .get(ancientRow.id) as { status: string; trigger: string };
    // Recovery flips back to pending + urgent trigger.
    expect(ancient.status).toBe("pending");
    expect(ancient.trigger).toBe("write");

    const recent = getDb()
      .prepare("SELECT status, trigger FROM discovery_queue WHERE id = ?")
      .get(recentRow.id) as { status: string; trigger: string };
    expect(recent.status).toBe("batched");
    expect(recent.trigger).toBe("commit");
  });

  it("respects GROVE_DISCOVERY_BATCH_MAX_AGE_HOURS env var", () => {
    process.env.GROVE_DISCOVERY_BATCH_MAX_AGE_HOURS = "1";

    enqueueDiscovery("a.md", "commit", VAULT_ID);
    const row = getDb()
      .prepare("SELECT id FROM discovery_queue WHERE path = 'a.md'")
      .get() as { id: number };
    markRowsBatched([row.id], "msgbatch_short");
    insertDiscoveryBatch("msgbatch_short", VAULT_ID, 1);

    getDb()
      .prepare(
        "UPDATE discovery_queue SET queued_at = datetime('now', '-2 hours') WHERE id = ?",
      )
      .run(row.id);

    expect(recoverStaleBatched(VAULT_ID)).toBe(1);
  });

  it("does nothing when nothing is stale", () => {
    enqueueDiscovery("fresh.md", "commit", VAULT_ID);
    const row = getDb()
      .prepare("SELECT id FROM discovery_queue WHERE path = 'fresh.md'")
      .get() as { id: number };
    markRowsBatched([row.id], "msgbatch_fresh");
    insertDiscoveryBatch("msgbatch_fresh", VAULT_ID, 1);

    expect(recoverStaleBatched(VAULT_ID)).toBe(0);
  });
});
