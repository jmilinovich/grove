import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeMcpResponse } from "../src/proxy.js";

/**
 * Security regression: the OAUTH_ENCRYPT_KEY must not use a static fallback
 * string. A static string ("grove-oauth-default") would let any attacker who
 * knows the source code decrypt the `encrypted_key` column in `oauth_codes`
 * and recover live API tokens from the database. The fallback must be random
 * (randomBytes) or derived from an operator-supplied secret (GROVE_CSRF_SECRET).
 */
describe("OAuth encryption key — static fallback guard", () => {
  it("does not use 'grove-oauth-default' as a fallback in OAUTH_ENCRYPT_KEY", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/proxy.ts"), "utf8");
    // Extract the block that defines OAUTH_ENCRYPT_KEY, spanning the multi-line form.
    const startIdx = src.indexOf("const OAUTH_ENCRYPT_KEY");
    const endIdx = src.indexOf(".digest();", startIdx) + ".digest();".length;
    const oauthKeyBlock = src.slice(startIdx, endIdx);
    expect(oauthKeyBlock).toBeTruthy();
    // Must not contain the old static fallback
    expect(oauthKeyBlock).not.toContain("grove-oauth-default");
    // Must use randomBytes as the fallback for per-process entropy
    expect(oauthKeyBlock).toMatch(/randomBytes/);
  });
});

describe("summarizeMcpResponse", () => {
  it("summarizes tool call response with text preview", () => {
    const response = {
      result: { content: [{ type: "text", text: "Hello world, this is a long response" }] },
    };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.text_length).toBe(36);
    expect(summary.preview).toBe("Hello world, this is a long response");
  });

  it("truncates long text to 300 chars in preview", () => {
    const long = "a".repeat(500);
    const response = { result: { content: [{ type: "text", text: long }] } };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.text_length).toBe(500);
    expect(summary.preview).toHaveLength(300);
  });

  it("summarizes tools/list response by name", () => {
    const response = {
      result: { tools: [{ name: "query" }, { name: "get" }, { name: "write_note" }] },
    };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.tools).toEqual(["query", "get", "write_note"]);
  });

  it("summarizes error response", () => {
    const response = { error: { code: -1, message: "bad request" } };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.error).toEqual({ code: -1, message: "bad request" });
  });

  it("falls back to top-level keys for unknown shapes", () => {
    const summary = summarizeMcpResponse({ foo: 1, bar: 2 }) as any;
    expect(summary.keys.sort()).toEqual(["bar", "foo"]);
  });

  it("returns primitives as-is", () => {
    expect(summarizeMcpResponse(null)).toBeNull();
    expect(summarizeMcpResponse(undefined)).toBeUndefined();
    expect(summarizeMcpResponse(42)).toBe(42);
  });
});
