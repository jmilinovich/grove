import { describe, it, expect } from "vitest";
import { summarizeMcpResponse } from "../src/proxy.js";

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
