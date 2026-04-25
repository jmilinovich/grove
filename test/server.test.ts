import { describe, it, expect, vi } from "vitest";
import { dispatchWriteNote } from "../src/server.js";

// dispatchWriteNote routes a single tool call to one of three handlers.
// Tests assert outcomes (which handler ran + the tool result) rather than
// pinning exact mock-call arg shapes — those couple to internal signatures
// and break on every refactor without revealing real bugs.
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
    expect(deps.handleDeleteNote).not.toHaveBeenCalled();
    expect(deps.handleMoveNote).not.toHaveBeenCalled();
  });

  it("action=delete routes to handleDeleteNote (soft delete by default)", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ action: "delete", path: "Inbox/old.md" }, deps);
    expect(res.isError).toBeFalsy();
    expect(deps.handleDeleteNote).toHaveBeenCalledOnce();
    expect(deps.handleWriteNote).not.toHaveBeenCalled();
    // hard=false in the third arg — only invariant we pin is the soft/hard flag,
    // since "soft delete" semantics are the contract callers depend on.
    expect(deps.handleDeleteNote.mock.calls[0]?.[2]).toMatchObject({ hard: false });
  });

  it("action=hard_delete routes to handleDeleteNote with hard=true", async () => {
    const deps = makeDeps();
    await dispatchWriteNote({ action: "hard_delete", path: "Inbox/gone.md" }, deps);
    expect(deps.handleDeleteNote).toHaveBeenCalledOnce();
    expect(deps.handleDeleteNote.mock.calls[0]?.[2]).toMatchObject({ hard: true });
  });

  it("action=move routes to handleMoveNote with both paths", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote(
      { action: "move", path: "Inbox/a.md", move_to: "Resources/Concepts/a.md" },
      deps,
    );
    expect(res.isError).toBeFalsy();
    expect(deps.handleMoveNote).toHaveBeenCalledOnce();
    // Path arguments are part of the user-facing contract, so we still
    // verify they made it through. Anything else (vaultId, trail) is
    // internal plumbing and not pinned.
    const call = deps.handleMoveNote.mock.calls[0]!;
    expect(call[1]).toBe("Inbox/a.md");
    expect(call[2]).toBe("Resources/Concepts/a.md");
  });

  it("action=move without move_to returns a tool error", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ action: "move", path: "Inbox/a.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("move_to is required");
    expect(deps.handleMoveNote).not.toHaveBeenCalled();
  });

  it("write without frontmatter/content returns a tool error", async () => {
    const deps = makeDeps();
    const res = await dispatchWriteNote({ path: "x.md" }, deps);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("frontmatter and content are required");
    expect(deps.handleWriteNote).not.toHaveBeenCalled();
  });

  it("write with invalid frontmatter JSON returns a tool error", async () => {
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

  it("passes if_hash through to the delete handler", async () => {
    const deps = makeDeps();
    await dispatchWriteNote(
      { action: "delete", path: "x.md", if_hash: "abc" },
      deps,
    );
    expect(deps.handleDeleteNote).toHaveBeenCalledOnce();
    expect(deps.handleDeleteNote.mock.calls[0]?.[2]).toMatchObject({ ifHash: "abc" });
  });
});
