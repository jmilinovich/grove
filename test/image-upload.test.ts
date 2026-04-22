import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNote } from "../src/notes-validate.js";

vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("sha-image"),
    gitPush: vi.fn().mockResolvedValue(undefined),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/embed-single.js", () => ({
  embedFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/vault-stats.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-stats.js")>();
  return {
    ...actual,
    refreshStats: vi.fn().mockResolvedValue(undefined),
  };
});

// Discovery enqueue hits a SQLite DB — stub it out
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    enqueueDiscovery: vi.fn(),
  };
});

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-image-upload-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_VAULT_ID = "life";
  // Per-test sqlite DB so write-path provenance recording has a schema
  // in CI runs (local runs happen to have a populated default db).
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_VAULT_ID;
  delete process.env.GROVE_DB_PATH;
});

async function loadRest() {
  vi.resetModules();
  // Bring schema up so write_provenance exists when handleWriteNote runs.
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

function makePngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf.write("\x89PNG\r\n\x1a\n", 0, "binary");
  // IHDR chunk length (ignored by our reader)
  buf.writeUInt32BE(13, 8);
  // IHDR type
  buf.write("IHDR", 12, "binary");
  // width / height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("handleImageUpload", () => {
  it("uploads to the store and creates a companion vault note", async () => {
    const rest = await loadRest();

    const uploadFn = vi.fn().mockImplementation(async (key: string, data: Buffer) => ({
      url: `https://assets.grove.md/${key}`,
      size: data.length,
    }));
    rest.setImageStoreResolver(() => ({
      upload: uploadFn,
      delete: vi.fn(),
      getUrl: (key: string) => `https://assets.grove.md/${key}`,
    }));

    rest.setAutoTagFn(async () => ({
      description: "A simple test diagram.",
      tags: ["diagram", "test"],
      concepts: ["System"],
      ocr_text: "HELLO WORLD",
    }));

    const png = makePngHeader(1920, 1080);
    const result = await rest.handleImageUpload({
      file: png,
      contentType: "image/png",
      filename: "diagram.png",
    });

    // R2 upload was called with a content-addressed key under the vault prefix
    expect(uploadFn).toHaveBeenCalledTimes(1);
    const [key, data, ct] = uploadFn.mock.calls[0];
    expect(key).toMatch(/^life\/[a-f0-9]{64}\.png$/);
    expect(data).toBe(png);
    expect(ct).toBe("image/png");

    // Response shape matches the fast-path spec: Vision-derived fields
    // (auto_tags, description, ocr_text) are populated asynchronously
    // via the discovery queue, so the immediate response is a stub.
    expect(result.image_url).toBe(`https://assets.grove.md/${key}`);
    expect(result.thumbnail_url).toBe(`https://assets.grove.md/${key}`);
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.auto_tags).toEqual([]);
    expect(result.enrichment_pending).toBe(true);
    expect(result.description).toMatch(/awaiting enrichment/i);
    expect(result.ocr_text).toBe("");
    expect(result.dimensions).toEqual({ width: 1920, height: 1080 });

    // Note was written to disk with the stub frontmatter + placeholder body
    const notePath = join(tempVault, result.note_path);
    expect(existsSync(notePath)).toBe(true);
    const { frontmatter, content } = parseNote(readFileSync(notePath, "utf-8"));
    expect(frontmatter.type).toBe("image");
    expect(frontmatter.image_url).toBe(result.image_url);
    expect(frontmatter.thumbnail_url).toBe(result.thumbnail_url);
    expect(frontmatter.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(frontmatter.enrichment_pending).toBe(true);
    expect(Array.isArray(frontmatter.tags)).toBe(true);
    expect(frontmatter.tags as string[]).toContain("image");
    expect(content).toContain("awaiting enrichment");
    expect(content).toContain(`](${result.image_url})`);
    expect(content).toMatch(/^# .+/m);
  });

  it("keeps user-supplied tags on the stub note (Vision tags arrive later via enrichment)", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async (key, data) => ({ url: `https://assets.grove.md/${key}`, size: data.length }),
      delete: async () => {},
      getUrl: (key) => `https://assets.grove.md/${key}`,
    }));

    const png = makePngHeader(100, 200);
    const result = await rest.handleImageUpload({
      file: png,
      contentType: "image/png",
      tags: ["travel", "nature"],
    });

    // Immediate response has only user tags + 'image' baseline
    expect(result.auto_tags).toEqual([]);
    expect(result.enrichment_pending).toBe(true);

    // Stub note on disk carries user tags (plus 'image')
    const { frontmatter } = parseNote(readFileSync(join(tempVault, result.note_path), "utf-8"));
    const tags = frontmatter.tags as string[];
    expect(tags).toEqual(expect.arrayContaining(["image", "travel", "nature"]));
  });

  it("rejects unsupported content types", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async () => ({ url: "x", size: 0 }),
      delete: async () => {},
      getUrl: () => "x",
    }));
    rest.setAutoTagFn(async () => ({ description: "", tags: [], concepts: [], ocr_text: "" }));

    await expect(
      rest.handleImageUpload({
        file: Buffer.from("some-text"),
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects files larger than 10MB", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async () => ({ url: "x", size: 0 }),
      delete: async () => {},
      getUrl: () => "x",
    }));
    rest.setAutoTagFn(async () => ({ description: "", tags: [], concepts: [], ocr_text: "" }));

    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(
      rest.handleImageUpload({ file: tooBig, contentType: "image/png" }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects empty file", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async () => ({ url: "x", size: 0 }),
      delete: async () => {},
      getUrl: () => "x",
    }));
    rest.setAutoTagFn(async () => ({ description: "", tags: [], concepts: [], ocr_text: "" }));

    await expect(
      rest.handleImageUpload({ file: Buffer.alloc(0), contentType: "image/png" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("honors trail scoping on write", async () => {
    const rest = await loadRest();
    const uploadFn = vi.fn().mockResolvedValue({ url: "https://assets.grove.md/k", size: 1 });
    rest.setImageStoreResolver(() => ({
      upload: uploadFn,
      delete: async () => {},
      getUrl: (key) => `https://assets.grove.md/${key}`,
    }));
    rest.setAutoTagFn(async () => ({ description: "x", tags: [], concepts: [], ocr_text: "" }));

    const trail = {
      id: "t1",
      name: "restricted",
      allow_paths: ["Resources/Concepts/"],
      deny_paths: [],
      allow_tags: [],
      deny_tags: [],
      allow_types: [],
      deny_types: [],
      rate_limit_reads: 100,
      rate_limit_writes: 10,
    };

    const png = makePngHeader(10, 10);
    await expect(
      rest.handleImageUpload({ file: png, contentType: "image/png" }, { trail }),
    ).rejects.toMatchObject({ code: "TRAIL_DENIED" });
  });

  it("enqueues discovery for the created note", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async (key, data) => ({ url: `https://assets.grove.md/${key}`, size: data.length }),
      delete: async () => {},
      getUrl: (key) => `https://assets.grove.md/${key}`,
    }));
    rest.setAutoTagFn(async () => ({
      description: "Test",
      tags: ["t"],
      concepts: [],
      ocr_text: "",
    }));

    const { enqueueDiscovery } = await import("../src/db.js");
    const png = makePngHeader(10, 10);
    const result = await rest.handleImageUpload({ file: png, contentType: "image/png" });

    expect(enqueueDiscovery).toHaveBeenCalledWith(result.note_path, "write");
  });

  it("uses provided path when supplied", async () => {
    const rest = await loadRest();
    rest.setImageStoreResolver(() => ({
      upload: async (key, data) => ({ url: `https://assets.grove.md/${key}`, size: data.length }),
      delete: async () => {},
      getUrl: (key) => `https://assets.grove.md/${key}`,
    }));
    rest.setAutoTagFn(async () => ({
      description: "anything",
      tags: ["tag"],
      concepts: [],
      ocr_text: "",
    }));

    const png = makePngHeader(10, 10);
    const result = await rest.handleImageUpload({
      file: png,
      contentType: "image/png",
      path: "Resources/Images/explicit-name.md",
    });
    expect(result.note_path).toBe("Resources/Images/explicit-name.md");
  });
});

describe("image dimension readers", () => {
  it("reads PNG dimensions from IHDR", async () => {
    const { readImageDimensions } = await loadRest();
    const png = makePngHeader(1920, 1080);
    expect(readImageDimensions(png, "image/png")).toEqual({ width: 1920, height: 1080 });
  });

  it("returns 0/0 for unknown formats", async () => {
    const { readImageDimensions } = await loadRest();
    expect(readImageDimensions(Buffer.alloc(8), "application/octet-stream")).toEqual({ width: 0, height: 0 });
  });
});
