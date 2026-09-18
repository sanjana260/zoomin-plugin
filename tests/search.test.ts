/** The palette's ranking — search.js's tiers, ported. */

import { describe, expect, it } from "vitest";
import { locate } from "../src/views/search-modal";

const rank = (items: string[], q: string) => {
  const hits = items
    .map((label) => ({ label, hit: locate(label.toLowerCase(), q.toLowerCase()) }))
    .filter((h) => h.hit)
    .sort((a, b) => {
      const la = a.label.toLowerCase(), lb = b.label.toLowerCase();
      return a.hit!.tier - b.hit!.tier || la.length - lb.length || la.localeCompare(lb);
    })
    .map((h) => h.label);
  return hits;
};

describe("ranking", () => {
  it("prefers the start of the label, then a word start, then anywhere", () => {
    expect(rank(["Income Computing", "Computing", "My Computer"], "com")).toEqual(["Computing", "Computer".length ? "My Computer" : "", "Income Computing"].slice(0, 3));
  });

  it("finds a subsequence and reports its spans", () => {
    const hit = locate("prepay task dashboard", "ptd")!;
    expect(hit.tier).toBe(3);
    expect(hit.spans).toEqual([[0, 1], [7, 8], [12, 13]]);
    expect(locate("prepay", "xyz")).toBeNull();
  });

  it("gives word-start hits over earlier mid-word ones", () => {
    const hit = locate("income computing", "com")!;
    expect(hit.tier).toBe(1);
    expect(hit.spans).toEqual([[7, 10]]);
  });

  it("is empty for an empty query by construction", () => {
    expect(locate("anything", "")!.tier).toBe(0);
  });
});
