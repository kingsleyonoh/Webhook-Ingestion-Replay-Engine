/**
 * Unit tests for JSON safe parse with nesting depth limit.
 * Tests:
 * - Normal JSON accepted
 * - Deeply nested JSON (100 levels) rejected
 * - Edge case: exactly at max depth accepted
 * - Edge case: one over max depth rejected
 * - Array nesting counted
 * - Mixed object/array nesting counted
 * - Empty object/array accepted
 * - Invalid JSON still rejected with parse error
 * - Nested strings with braces not counted (inside quotes)
 */

import { describe, it, expect } from "vitest";

describe("json-safe-parse (unit)", () => {
  it("should accept normal JSON within depth limit", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    const json = JSON.stringify({ a: { b: { c: 1 } } });
    const result = safeParse(json, 20);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("should reject JSON nested 100 levels deep with default limit", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // Build deeply nested JSON: {"a":{"a":{"a":...}}}
    let json = "1";
    for (let i = 0; i < 100; i++) {
      json = `{"a":${json}}`;
    }
    expect(() => safeParse(json, 20)).toThrow();
  });

  it("should accept JSON at exactly max depth", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // Build JSON nested exactly 3 levels deep
    const json = '{"a":{"b":{"c":1}}}'; // depth 3
    const result = safeParse(json, 3);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it("should reject JSON one level over max depth", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // depth 4
    const json = '{"a":{"b":{"c":{"d":1}}}}';
    expect(() => safeParse(json, 3)).toThrow();
  });

  it("should count array nesting", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // [[[[1]]]] = depth 4
    const json = "[[[[1]]]]";
    expect(() => safeParse(json, 3)).toThrow();
  });

  it("should count mixed object and array nesting", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // {"a":[{"b":1}]} = depth 3
    const json = '{"a":[{"b":1}]}';
    const result = safeParse(json, 3);
    expect(result).toEqual({ a: [{ b: 1 }] });
  });

  it("should accept empty object", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    const result = safeParse("{}", 20);
    expect(result).toEqual({});
  });

  it("should accept empty array", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    const result = safeParse("[]", 20);
    expect(result).toEqual([]);
  });

  it("should reject invalid JSON", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    expect(() => safeParse("{invalid", 20)).toThrow();
  });

  it("should not count braces inside strings", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    // The string value contains braces but they don't count as nesting
    const json = '{"msg":"hello {world} [test]"}';
    const result = safeParse(json, 1);
    expect(result).toEqual({ msg: "hello {world} [test]" });
  });

  it("should accept top-level primitives", async () => {
    const { safeParse } = await import(
      "../../../src/lib/json-safe-parse.js"
    );
    expect(safeParse('"hello"', 20)).toBe("hello");
    expect(safeParse("42", 20)).toBe(42);
    expect(safeParse("true", 20)).toBe(true);
    expect(safeParse("null", 20)).toBeNull();
  });
});
