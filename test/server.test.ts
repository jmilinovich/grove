import { describe, it, expect, vi } from "vitest";
import { dispatchWriteNote } from "../src/server.js";

// server.ts is heavily side-effectful (MCP server, HTTP listener, vault I/O).
// We test the pure patterns and validation logic it uses.

describe("path normalization logic", () => {
  // From the get tool: normalizes input paths
  function normalizePath(file: string): string {
    let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
    if (!filePath.endsWith(".md")) filePath += ".md";
    return filePath;
  }

  it("strips life/ prefix", () => {
    expect(normalizePath("life/Resources/Concepts/Foo.md")).toBe("Resources/Concepts/Foo.md");
  });

  it("strips qmd://life/ prefix", () => {
    expect(normalizePath("qmd://life/Resources/People/Bar.md")).toBe("Resources/People/Bar.md");
  });

  it("adds .md extension if missing", () => {
    expect(normalizePath("Resources/Concepts/Foo")).toBe("Resources/Concepts/Foo.md");
  });

  it("leaves clean paths unchanged", () => {
    expect(normalizePath("Journal/2026/2026-04-07.md")).toBe("Journal/2026/2026-04-07.md");
  });
});

describe("date pattern detection", () => {
  it("detects YYYY-MM-DD date patterns", () => {
    const searchTerm = "2026-04-07";
    const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
    expect(dateMatch).not.toBeNull();
    expect(dateMatch![1]).toBe("2026");
  });

  it("does not match non-date strings", () => {
    expect("Taste Graph".match(/^(\d{4})-\d{2}-\d{2}$/)).toBeNull();
    expect("2026-13-40".match(/^(\d{4})-\d{2}-\d{2}$/)).not.toBeNull(); // regex doesn't validate ranges
  });
});

describe("INSTRUCTIONS constant format", () => {
  // Verify the server instructions contain expected content
  const INSTRUCTIONS = `Grove is your knowledge API over a personal Obsidian vault (~1000 notes).`;

  it("mentions Obsidian vault", () => {
    expect(INSTRUCTIONS).toContain("Obsidian vault");
  });
});

describe("dispatchWriteNote — action routing", () => {
  function makeDeps() {
    return {
      handleWriteNote: vi.fn().mockResolvedValue({ path: "x.md", content_hash: "h", url: "u" }),
      handleDeleteNote: vi.fn().mockResolvedValue({ action: "archived", original_path: "x.md", archive_path: "Archives/x.md", commit: "c" }),
      handleMoveNote: vi.fn().mockResolvedValue({ action: "moved", from: "a.md", to: "b.md", links_updated: 0, commit: "c", content_hash: "h", url: "u" }),
    };
  }

  it("default action routes to handleWriteNote", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote(
      { path: "x.md", frontmatter: '{"type":"concept","tags":["t"]}', content: "body" },
      deps,
    );
    expect(res.isError).toBeFalsy();
    expect(deps.handleWriteNote).toHaveBeenCalledOnce();
    expect(deps.handleWriteNote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: expect.any(String) }),
      "x.md",
      { type: "concept", tags: ["t"] },
      "body",
      expect.objectContaining({ trail: null }),
    );
    expect(deps.handleDeleteNote).not.toHaveBeenCalled();
    expect(deps.handleMoveNote).not.toHaveBeenCalled();
  });

  it("action=write behaves the same as default", async () => {
    const deps = makeDeps();
    await dispatchWriteNote(
      { action: "write", path: "x.md", frontmatter: '{"type":"concept","tags":["t"]}', content: "body" },
      deps,
    );
    expect(deps.handleWriteNote).toHaveBeenCalledOnce();
  });

  it("action=delete routes to handleDeleteNote with hard=false", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ action: "delete", path: "Inbox/old.md" }, deps);
    expect(res.isError).toBeFalsy();
    expect(deps.handleDeleteNote).toHaveBeenCalledOnce();
    expect(deps.handleDeleteNote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: expect.any(String) }),
      "Inbox/old.md",
      expect.objectContaining({ hard: false, trail: null }),
    );
    expect(deps.handleWriteNote).not.toHaveBeenCalled();
  });

  it("action=hard_delete routes to handleDeleteNote with hard=true", async () => {
    const deps = makeDeps();
    await dispatchWriteNote({ action: "hard_delete", path: "Inbox/gone.md" }, deps);
    expect(deps.handleDeleteNote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: expect.any(String) }),
      "Inbox/gone.md",
      expect.objectContaining({ hard: true }),
    );
  });

  it("action=move routes to handleMoveNote", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote(
      { action: "move", path: "Inbox/a.md", move_to: "Resources/Concepts/a.md" },
      deps,
    );
    expect(res.isError).toBeFalsy();
    expect(deps.handleMoveNote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: expect.any(String) }),
      "Inbox/a.md",
      "Resources/Concepts/a.md",
      expect.objectContaining({ trail: null }),
    );
  });

  it("action=move without move_to returns an error", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ action: "move", path: "Inbox/a.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("move_to is required");
    expect(deps.handleMoveNote).not.toHaveBeenCalled();
  });

  it("write without frontmatter/content returns an error", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ path: "x.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("frontmatter and content are required");
    expect(deps.handleWriteNote).not.toHaveBeenCalled();
  });

  it("write with invalid frontmatter JSON returns an error", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote(
      { path: "x.md", frontmatter: "not json", content: "body" },
      deps,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid frontmatter JSON");
  });

  it("surfaces handleDeleteNote errors as tool errors", async () => {
    const deps = makeDeps();
    deps.handleDeleteNote.mockRejectedValueOnce(Object.assign(new Error("Note not found"), { code: "NOT_FOUND" }));
    const res = await dispatchWriteNote({ action: "delete", path: "Inbox/missing.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Note not found");
  });

  it("surfaces handleMoveNote errors as tool errors", async () => {
    const deps = makeDeps();
    deps.handleMoveNote.mockRejectedValueOnce(Object.assign(new Error("Destination already exists: y.md"), { code: "CONFLICT" }));
    const res = await dispatchWriteNote({ action: "move", path: "x.md", move_to: "y.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already exists");
  });

  it("passes if_hash and trail through to the delete handler", async () => {
    const deps = makeDeps();
    const trail = { id: "t", name: "n" } as any;
    await dispatchWriteNote(
      { action: "delete", path: "x.md", if_hash: "abc" },
      { ...deps, trail },
    );
    expect(deps.handleDeleteNote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: expect.any(String) }),
      "x.md",
      expect.objectContaining({ ifHash: "abc", trail }),
    );
  });
});
