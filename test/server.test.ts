import { describe, it, expect, vi } from "vitest";
import { dispatchWriteNote } from "../src/server.js";

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
