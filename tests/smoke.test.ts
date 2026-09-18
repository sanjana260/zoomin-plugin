import { describe, expect, it } from "vitest";
import { normalizePath } from "obsidian";

describe("test harness", () => {
  it("resolves the obsidian stub", () => {
    expect(normalizePath("a//b/")).toBe("a/b");
  });
});
