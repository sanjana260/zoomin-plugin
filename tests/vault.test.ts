/**
 * The rules the snapshot applies over Obsidian's cache, and the frontmatter
 * readers. What tests/test_vault.py guarded, minus the parsing and resolution
 * that are Obsidian's now, and minus the splicing writer that was not ported.
 */

import { describe, expect, it } from "vitest";
import { categoryNames, frontmatterLinks, linkTarget, noteDeadline, noteStatus } from "../src/vault/categories";
import { included } from "../src/vault/snapshot";
import { LinkKind } from "../src/types";
import { assemble, note } from "./fake-cache";

describe("link targets", () => {
  it.each([
    ["Note", "Note"],
    ["Note|Alias", "Note"],
    ["Note#Heading", "Note"],
    ["Note#^blk-1", "Note"],
    ["folder/Note", "folder/Note"],
    ["Note\\|Alias", "Note"], // pipe escaped inside a markdown table
    ["#Heading", null], // same-note fragment is not an edge
  ])("%s → %s", (inner, expected) => {
    expect(linkTarget(inner)).toBe(expected);
  });

  it("pulls wikilinks out of a frontmatter value in every form", () => {
    expect(frontmatterLinks('"[[Work]]"')).toEqual(["Work"]);
    expect(frontmatterLinks("[[Work]]")).toEqual(["Work"]);
    expect(frontmatterLinks(["[[Work]]", "[[Play|alias]]"])).toEqual(["Work", "Play"]);
    expect(frontmatterLinks(null)).toEqual([]);
    expect(frontmatterLinks("")).toEqual([]);
    expect(frontmatterLinks(42)).toEqual([]);
  });
});

describe("edges", () => {
  it("makes Parent: a hierarchy edge", () => {
    const v = assemble({ "Work.md": note(), "Child.md": note("Work") });
    expect(v.edges).toEqual([{ source: "Child.md", target: "Work.md", kind: LinkKind.HIERARCHY }]);
  });

  it("does not treat the old Project: key as hierarchy", () => {
    const v = assemble({ "Work.md": note(), "Child.md": { frontmatter: { Project: "[[Work]]" } } });
    expect(v.edges).toEqual([]);
  });

  it("never makes an edge from a non-markdown embed (Trap 1)", () => {
    const v = assemble({
      "Note.md": note(null, { embeds: ["Tasks.base", "Attachments/pic.png", "Memo"], links: ["Work"] }),
      "Tasks.base": "base",
      "Attachments/pic.png": "png",
      "Memo.md": note(),
      "Work.md": note(),
    });
    expect(v.edges.map((e) => e.target).sort()).toEqual(["Memo.md", "Work.md"]);
    expect(v.phantoms.size).toBe(0);
  });

  it("does not make a phantom out of an unresolved non-note target", () => {
    const v = assemble({ "Note.md": note(null, { embeds: ["Gone.base", "gone.png"], links: ["Gone"] }) });
    expect([...v.phantoms.values()]).toEqual(["Gone"]);
    expect(v.edges).toHaveLength(1);
  });

  it("never turns categories into edges", () => {
    const v = assemble({
      "Projects.md": note(),
      "N.md": { frontmatter: { categories: ['"[[Projects]]"'] } },
    });
    expect(v.notes.get("N.md")!.categories).toEqual(["Projects"]);
    expect(v.edges).toEqual([]);
  });

  it("collapses duplicate links and ignores self-links", () => {
    const v = assemble({ "A.md": note(null, { links: ["B", "B", "b", "A"] }), "B.md": note() });
    expect(v.edges).toEqual([{ source: "A.md", target: "B.md", kind: LinkKind.ASSOCIATIVE }]);
  });

  it("keeps hierarchy and mention as separate edges to the same target", () => {
    const v = assemble({ "Work.md": note(), "Child.md": note("Work", { links: ["Work"] }) });
    expect(v.edges.map((e) => e.kind).sort()).toEqual([LinkKind.ASSOCIATIVE, LinkKind.HIERARCHY]);
  });

  it("makes a phantom for an unwritten note, once, with its display name", () => {
    const v = assemble({ "A.md": note(null, { links: ["Ghost"] }), "B.md": note(null, { links: ["ghost#Heading"] }) });
    expect(v.phantoms.size).toBe(1);
    expect([...v.phantoms.values()]).toEqual(["Ghost"]);
    expect(v.edges).toHaveLength(2);
  });

  it("excludes Templates/ and Attachments/ at the root, and sync conflicts", () => {
    expect(included("Templates/T.md")).toBe(false);
    expect(included("Attachments/a.md")).toBe(false);
    expect(included("Projects/Templates/T.md")).toBe(true);
    expect(included("Note.sync-conflict-20260101.md")).toBe(false);
    expect(included("Templates.md")).toBe(true);
    const v = assemble({ "Templates/T.md": note(null, { links: ["Work"] }), "Work.md": note(), "Child.md": note("Templates/T") });
    expect(v.notes.has("Templates/T.md")).toBe(false);
    // A resolved link into an excluded folder is neither an edge nor a phantom.
    expect(v.edges).toEqual([]);
    expect(v.phantoms.size).toBe(0);
  });

  it("carries the Parent: link target and the description on the note", () => {
    const v = assemble({ "Work.md": note(), "Child.md": { frontmatter: { Parent: '"[[Work]]"', Description: " Why. " } } });
    expect(v.notes.get("Child.md")!.parentLink).toBe("Work");
    expect(v.notes.get("Child.md")!.description).toBe("Why.");
    expect(v.notes.get("Work.md")!.parentLink).toBeNull();
  });
});

describe("categories", () => {
  it.each<[unknown, string[]]>([
    [["Task"], ["Task"]], // bare: 184 of 238 uses in the vault
    [['"[[Projects]]"'], ["Projects"]], // wikilinked: the other 54 (Obsidian keeps the quotes off)
    [["[[Projects]]"], ["Projects"]],
    ["[[Categories/Projects|Project]]", ["Projects"]], // path + alias
    [null, []], // present but empty — 46 notes do this
    [["Task", "Idea"], ["Task", "Idea"]],
    [["Task", "task"], ["Task"]], // one category, two spellings
    [[""], []],
    ["Task", ["Task"]],
  ])("%j → %j", (raw, expected) => {
    expect(categoryNames(raw)).toEqual(expected);
  });
});

describe("status", () => {
  it.each<[unknown, string | null]>([
    ["Exploring", "exploring"],
    ["Explored", "explored"],
    ["Unexplored", "unexplored"],
    ["EXPLORED", "explored"],
    ["Unexplored - Unexplored", "unexplored"], // typo'd, intent obvious
    [true, null], // YAML boolean
    [null, null], // set empty
    [undefined, null], // never set
    ["Abandoned", null], // a word we do not model
    [["Exploring"], "exploring"], // 46 notes carry it as a list
    [[], null],
  ])("%j → %j", (raw, expected) => {
    expect(noteStatus(raw)).toBe(expected);
  });
});

describe("deadline", () => {
  it.each<[unknown, string | null]>([
    ["2026-09-16", "2026-09-16"],
    ["2026-09-16 14:00:00", "2026-09-16"], // a datetime is reduced to its day
    ["2026-09-16T14:00:00Z", "2026-09-16"],
    ["soon", null],
    [null, null],
    [undefined, null],
    [["2026-09-16"], "2026-09-16"], // a list takes its first entry
    ["2026-02-30", null], // not a real day
    [new Date(Date.UTC(2026, 8, 16)), "2026-09-16"],
  ])("%j → %j", (raw, expected) => {
    expect(noteDeadline(raw)).toBe(expected);
  });
});
