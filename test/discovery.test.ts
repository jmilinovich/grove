import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { tick, type Processor } from "../src/discovery.js";
import {
  enqueueDiscovery,
  dequeueDiscovery,
  markDiscoveryDone,
  markDiscoveryError,
  discoveryQueueDepth,
  insertDiscoveryResult,
  getRecentExtractions,
  getNewConceptsCreated,
  getSurprisingConnections,
  getLastProcessedAt,
  getDb,
  createSchema,
  closeDb,
  resetDb,
} from "../src/db.js";

describe("discovery queue (db helpers)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-discovery-test-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enqueue adds a pending entry", () => {
    enqueueDiscovery("Journal/2026/2026-04-13.md", "write");
    expect(discoveryQueueDepth()).toBe(1);
  });

  it("dequeue claims the oldest pending entry", () => {
    enqueueDiscovery("note-a.md", "write");
    enqueueDiscovery("note-b.md", "commit");

    const entry = dequeueDiscovery();
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("note-a.md");
    expect(entry!.trigger).toBe("write");
    expect(entry!.status).toBe("processing");

    // Only one pending left
    expect(discoveryQueueDepth()).toBe(1);
  });

  it("dequeue returns null when queue is empty", () => {
    expect(dequeueDiscovery()).toBeNull();
  });

  it("markDiscoveryDone sets status and processed_at", () => {
    enqueueDiscovery("test.md", "write");
    const entry = dequeueDiscovery()!;
    markDiscoveryDone(entry.id);

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE id = ?").get(entry.id) as any;
    expect(row.status).toBe("done");
    expect(row.processed_at).not.toBeNull();
  });

  it("markDiscoveryError sets status, processed_at, and error_message", () => {
    enqueueDiscovery("bad.md", "commit");
    const entry = dequeueDiscovery()!;
    markDiscoveryError(entry.id, "file not found");

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE id = ?").get(entry.id) as any;
    expect(row.status).toBe("error");
    expect(row.processed_at).not.toBeNull();
    expect(row.error_message).toBe("file not found");
  });

  it("discoveryQueueDepth counts only pending entries", () => {
    enqueueDiscovery("a.md", "write");
    enqueueDiscovery("b.md", "write");
    enqueueDiscovery("c.md", "commit");

    // Claim one — now processing, not pending
    dequeueDiscovery();
    expect(discoveryQueueDepth()).toBe(2);
  });

  it("dequeue is scoped by vault_id — workers never see other vaults' work", () => {
    // Two vaults enqueue concurrently; each vault's worker must only
    // dequeue its own entries. Prior to P8-A2 wire-up, the shared queue
    // let any worker drain any vault's work — a silent cross-vault leak.
    enqueueDiscovery("life/notes/a.md", "write", "vault_00000000");
    enqueueDiscovery("team/notes/x.md", "write", "vault_team");
    enqueueDiscovery("life/notes/b.md", "write", "vault_00000000");
    enqueueDiscovery("team/notes/y.md", "commit", "vault_team");

    const personalFirst = dequeueDiscovery("vault_00000000")!;
    const personalSecond = dequeueDiscovery("vault_00000000")!;
    const personalThird = dequeueDiscovery("vault_00000000");

    expect([personalFirst.path, personalSecond.path].sort()).toEqual([
      "life/notes/a.md",
      "life/notes/b.md",
    ]);
    expect(personalThird).toBeNull(); // nothing else for personal

    const teamFirst = dequeueDiscovery("vault_team")!;
    const teamSecond = dequeueDiscovery("vault_team")!;
    const teamThird = dequeueDiscovery("vault_team");

    expect([teamFirst.path, teamSecond.path].sort()).toEqual([
      "team/notes/x.md",
      "team/notes/y.md",
    ]);
    expect(teamThird).toBeNull();
  });

  it("enqueueDiscovery picks up vault_id from GROVE_VAULT_ID env by default", () => {
    // Simulates the grove-server code path: PM2 pins GROVE_VAULT_ID per
    // process; enqueue without an explicit argument tags rows with that id.
    process.env.GROVE_VAULT_ID = "vault_scoped_env";
    try {
      enqueueDiscovery("note.md", "write"); // no explicit vault_id
      const row = getDb().prepare(
        "SELECT vault_id FROM discovery_queue WHERE path = ?",
      ).get("note.md") as { vault_id: string };
      expect(row.vault_id).toBe("vault_scoped_env");
    } finally {
      delete process.env.GROVE_VAULT_ID;
    }
  });

  it("accepts the embed_retry trigger for re-embed workflow", () => {
    enqueueDiscovery("x.md", "embed_retry");
    const entry = dequeueDiscovery();
    expect(entry?.trigger).toBe("embed_retry");
    expect(entry?.attempts).toBe(1);
  });
});

describe("discovery loop (tick)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-discovery-tick-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tick returns false when queue is empty", async () => {
    const result = await tick();
    expect(result).toBe(false);
  });

  it("tick processes an entry and marks it done", async () => {
    const processed: string[] = [];
    const processor: Processor = async (entry) => {
      processed.push(entry.path);
    };

    enqueueDiscovery("Journal/2026/2026-04-13.md", "write");
    const result = await tick(processor);

    expect(result).toBe(true);
    expect(processed).toEqual(["Journal/2026/2026-04-13.md"]);

    // Entry should be marked done
    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE status = 'done'").get() as any;
    expect(row).toBeTruthy();
    expect(row.path).toBe("Journal/2026/2026-04-13.md");
  });

  it("tick marks entry as error when processor throws", async () => {
    const failProcessor: Processor = async () => {
      throw new Error("extraction failed");
    };

    enqueueDiscovery("bad-note.md", "write");
    const result = await tick(failProcessor);

    expect(result).toBe(true);

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE status = 'error'").get() as any;
    expect(row).toBeTruthy();
    expect(row.error_message).toBe("extraction failed");
  });

  it("failed entry does not block subsequent entries", async () => {
    const processed: string[] = [];
    let callCount = 0;
    const mixedProcessor: Processor = async (entry) => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      processed.push(entry.path);
    };

    enqueueDiscovery("fail.md", "write");
    enqueueDiscovery("succeed.md", "write");

    // First tick — processes fail.md, errors
    await tick(mixedProcessor);
    // Second tick — processes succeed.md, succeeds
    await tick(mixedProcessor);

    expect(processed).toEqual(["succeed.md"]);

    const db = getDb();
    const done = db.prepare("SELECT * FROM discovery_queue WHERE status = 'done'").get() as any;
    expect(done.path).toBe("succeed.md");
    const errored = db.prepare("SELECT * FROM discovery_queue WHERE status = 'error'").get() as any;
    expect(errored.path).toBe("fail.md");
  });

  it("processes entries in FIFO order", async () => {
    const order: string[] = [];
    const processor: Processor = async (entry) => {
      order.push(entry.path);
    };

    enqueueDiscovery("first.md", "write");
    enqueueDiscovery("second.md", "commit");
    enqueueDiscovery("third.md", "ingest");

    await tick(processor);
    await tick(processor);
    await tick(processor);

    expect(order).toEqual(["first.md", "second.md", "third.md"]);
  });
});

describe("discovery digest helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-digest-test-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("empty state returns zeroed fields", () => {
    expect(getRecentExtractions()).toEqual([]);
    expect(getNewConceptsCreated()).toEqual([]);
    expect(getSurprisingConnections()).toEqual([]);
    expect(discoveryQueueDepth()).toBe(0);
    expect(getLastProcessedAt()).toBeNull();
  });

  it("getRecentExtractions returns only done entries with processed_at", () => {
    enqueueDiscovery("a.md", "write");
    enqueueDiscovery("b.md", "commit");
    enqueueDiscovery("c.md", "write");

    // Process a and b, leave c pending
    const a = dequeueDiscovery()!;
    markDiscoveryDone(a.id);
    const b = dequeueDiscovery()!;
    markDiscoveryDone(b.id);

    const extractions = getRecentExtractions();
    expect(extractions).toHaveLength(2);
    // Both done entries present, c (pending) excluded
    const paths = extractions.map((e) => e.path).sort();
    expect(paths).toEqual(["a.md", "b.md"]);
    expect(extractions.every((e) => e.processed_at != null)).toBe(true);
  });

  it("getRecentExtractions respects limit", () => {
    for (let i = 0; i < 5; i++) {
      enqueueDiscovery(`note-${i}.md`, "write");
      const entry = dequeueDiscovery()!;
      markDiscoveryDone(entry.id);
    }
    expect(getRecentExtractions(3)).toHaveLength(3);
  });

  it("getNewConceptsCreated returns concept-path results", () => {
    insertDiscoveryResult("r1", "Journal/2026/2026-04-13.md", "Resources/Concepts/knowledge-graphs.md", 0.85, "mentioned");
    insertDiscoveryResult("r2", "Journal/2026/2026-04-13.md", "Resources/People/alice.md", 0.9, "mentioned");
    insertDiscoveryResult("r3", "Notes/scratch.md", "Resources/Concepts/emergence.md", 0.75, "related");

    const concepts = getNewConceptsCreated();
    expect(concepts).toHaveLength(2);
    // Both should be concept paths
    expect(concepts.every((c) => c.path.startsWith("Resources/Concepts/"))).toBe(true);
    // triggered_by should be the source
    expect(concepts.find((c) => c.path.includes("knowledge-graphs"))?.triggered_by).toBe("Journal/2026/2026-04-13.md");
  });

  it("getSurprisingConnections returns by similarity desc", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.7, "related");
    insertDiscoveryResult("r2", "c.md", "d.md", 0.95, "similar");
    insertDiscoveryResult("r3", "e.md", "f.md", 0.8, "related");

    const connections = getSurprisingConnections();
    expect(connections).toHaveLength(3);
    expect(connections[0].similarity).toBe(0.95);
    expect(connections[1].similarity).toBe(0.8);
    expect(connections[2].similarity).toBe(0.7);
  });

  it("getSurprisingConnections excludes dismissed results", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.9, "related");
    insertDiscoveryResult("r2", "c.md", "d.md", 0.8, "similar");

    const db = getDb();
    db.prepare("UPDATE discovery_results SET dismissed_at = datetime('now') WHERE id = 'r1'").run();

    const connections = getSurprisingConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].source).toBe("c.md");
  });

  it("getLastProcessedAt returns most recent timestamp", () => {
    enqueueDiscovery("a.md", "write");
    enqueueDiscovery("b.md", "write");

    const a = dequeueDiscovery()!;
    markDiscoveryDone(a.id);
    const b = dequeueDiscovery()!;
    markDiscoveryDone(b.id);

    const last = getLastProcessedAt();
    expect(last).toBeTruthy();

    // Should match b's processed_at (processed second)
    const db = getDb();
    const bRow = db.prepare("SELECT processed_at FROM discovery_queue WHERE id = ?").get(b.id) as any;
    expect(last).toBe(bRow.processed_at);
  });

  it("queue_depth only counts pending entries", () => {
    enqueueDiscovery("pending-1.md", "write");
    enqueueDiscovery("pending-2.md", "write");
    enqueueDiscovery("done.md", "write");

    const entry = dequeueDiscovery()!;  // now processing
    markDiscoveryDone(entry.id);        // now done

    // 2 pending (pending-2 and done.md which hasn't been dequeued yet)
    expect(discoveryQueueDepth()).toBe(2);
  });
});
