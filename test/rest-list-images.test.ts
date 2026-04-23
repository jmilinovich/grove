import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defaultVaultContext } from "../src/rest.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return { ...actual, gitPush: vi.fn().mockResolvedValue(undefined) };
});

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-list-images-"));
  process.env.GROVE_VAULT = tempVault;

  mkdirSync(join(tempVault, "Resources/Images"), { recursive: true });
  mkdirSync(join(tempVault, "Resources/Concepts"), { recursive: true });

  writeFileSync(
    join(tempVault, "Resources/Concepts/Thing.md"),
    "---\ntype: concept\ntags: [x]\n---\nA concept note.",
  );

  writeFileSync(
    join(tempVault, "Resources/Images/arch.md"),
    [
      "---",
      "type: image",
      "tags: [diagram, architecture]",
      "image_url: https://assets.grove.md/v1/abc.png",
      "thumbnail_url: https://assets.grove.md/v1/abc_thumb.webp",
      "dimensions: {width: 1920, height: 1080}",
      "---",
      "",
      "System architecture diagram showing microservices.",
      "",
      "![Arch](https://assets.grove.md/v1/abc.png)",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(tempVault, "Resources/Images/photo.md"),
    [
      "---",
      "type: image",
      "tags: [photo]",
      "image_url: https://assets.grove.md/v1/def.jpg",
      "thumbnail_url: https://assets.grove.md/v1/def_thumb.webp",
      "dimensions: {width: 800, height: 600}",
      "---",
      "A photograph.",
    ].join("\n"),
  );
});

afterEach(() => {
  delete process.env.GROVE_VAULT;
  vi.clearAllMocks();
});

async function loadRest() {
  vi.resetModules();
  return import("../src/rest.js");
}

describe("handleListNotes type filter + image metadata", () => {
  it("filters to image notes when type=image", async () => {
    const { handleListNotes } = await loadRest();
    const entries = handleListNotes(defaultVaultContext(), "", null, "image");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.type === "image")).toBe(true);
    expect(entries.map((e) => e.name).sort()).toEqual(["arch", "photo"]);
  });

  it("populates thumbnail_url, image_url, dimensions on image notes", async () => {
    const { handleListNotes } = await loadRest();
    const entries = handleListNotes(defaultVaultContext(), "", null, "image");
    const arch = entries.find((e) => e.name === "arch");
    expect(arch).toBeDefined();
    expect(arch!.thumbnail_url).toBe("https://assets.grove.md/v1/abc_thumb.webp");
    expect(arch!.image_url).toBe("https://assets.grove.md/v1/abc.png");
    expect(arch!.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(arch!.description).toContain("architecture");
  });

  it("does not populate image fields on non-image notes", async () => {
    const { handleListNotes } = await loadRest();
    const entries = handleListNotes(defaultVaultContext(), "");
    const concept = entries.find((e) => e.name === "Thing");
    expect(concept).toBeDefined();
    expect(concept!.thumbnail_url).toBeUndefined();
    expect(concept!.image_url).toBeUndefined();
    expect(concept!.dimensions).toBeUndefined();
  });

  it("returns all notes when no type filter is given", async () => {
    const { handleListNotes } = await loadRest();
    const entries = handleListNotes(defaultVaultContext(), "");
    expect(entries).toHaveLength(3);
  });
});
