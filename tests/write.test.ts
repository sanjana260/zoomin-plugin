/**
 * Writing the four fields through the model. The value each takes, the
 * cascade, the loop refusal, the category's form, and what is patched in
 * memory versus re-read — what test_api.py pinned about writes, over a fake
 * `processFrontMatter`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ZoomInModel } from "../src/model";
import { Store, emptyStore } from "../src/state/store";
import { categoryValue, deadlineValue, nextStatus, parentValue, statusValue } from "../src/vault/write";
import { NoteSpec, fakeSource, fakeWriter, note } from "./fake-cache";

let files: Record<string, NoteSpec | string>;
let writer: ReturnType<typeof fakeWriter>;
let model: ZoomInModel;

beforeEach(() => {
  files = {
    "Work.md": note(null, { frontmatter: { status: "Exploring", categories: ["[[Projects]]"] } }),
    "Prepay.md": note("Work", { frontmatter: { status: "Exploring" } }),
    "Aetna.md": note("Prepay", { frontmatter: { status: ["Unexplored"] } }),
    "Chess.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
    "Ship.md": note("Work", { frontmatter: { categories: ["Task"], status: "Exploring" } }),
    "Memo.md": note("Work", { frontmatter: { categories: ["Entry"] } }),
    "Notes/Memo.md": note(null, { frontmatter: { categories: ["[[Entry]]"] } }),
    "Categories/Projects.md": note(),
    "Categories/Meetings.md": note(),
  };
  writer = fakeWriter(files);
  model = new ZoomInModel(fakeSource(files), new Store(emptyStore(), () => {}), writer);
  model.reload();
});

const fm = (path: string) => (files[path] as NoteSpec).frontmatter!;

describe("values", () => {
  it("cycles unexplored → exploring → explored → unexplored, entering at the start", () => {
    expect(nextStatus(null)).toBe("unexplored");
    expect(nextStatus("unexplored")).toBe("exploring");
    expect(nextStatus("exploring")).toBe("explored");
    expect(nextStatus("explored")).toBe("unexplored");
  });

  it("spells each field the way the vault does", () => {
    expect(statusValue("exploring")).toBe("Exploring");
    expect(parentValue("Work")).toBe("[[Work]]");
    expect(parentValue(null)).toBeNull();
    expect(categoryValue("Task", false)).toEqual(["Task"]);
    expect(categoryValue("Meetings", true)).toEqual(["[[Meetings]]"]);
    expect(categoryValue(null, true)).toBeNull();
    expect(deadlineValue("2026-09-16")).toBe("2026-09-16");
    expect(deadlineValue(null)).toBeNull();
    expect(() => deadlineValue("soon")).toThrow("not a date");
  });
});

describe("status", () => {
  it("cycles and lands in the file, cascading as a set", async () => {
    const result = await model.setStatus("Work.md");
    expect(result).toEqual({ status: "explored", cascaded: 4 }); // Prepay, Aetna, Ship, Memo
    expect(fm("Work.md")["status"]).toBe("Explored");
    expect(fm("Aetna.md")["status"]).toBe("Explored"); // the list-valued status replaced whole
    expect(fm("Memo.md")["status"]).toBe("Explored"); // set, not cycled: it had none
    expect(model.snapshot.notes.get("Prepay.md")!.status).toBe("explored");
  });

  it("sets rather than cycles when a status is given", async () => {
    await model.setStatus("Ship.md", "unexplored");
    expect(fm("Ship.md")["status"]).toBe("Unexplored");
    await expect(model.setStatus("Ship.md", "done" as never)).rejects.toThrow("unknown status");
  });

  it("cascades to nothing from a leaf, and refuses unknown or phantom notes", async () => {
    expect((await model.setStatus("Chess.md")).cascaded).toBe(0);
    await expect(model.setStatus("Nope.md")).rejects.toThrow("no such note");
    await expect(model.setStatus("phantom:ghost")).rejects.toThrow("no such note");
  });

  it("touches only the status key", async () => {
    await model.setStatus("Work.md", "explored");
    expect(Object.keys(fm("Work.md")).sort()).toEqual(["categories", "status"]);
    expect(fm("Work.md")["categories"]).toEqual(["[[Projects]]"]);
  });

  it("reports how far a cascade got when a write fails", async () => {
    writer.failOn.add("Aetna.md");
    await expect(model.setStatus("Prepay.md")).rejects.toThrow("disk full writing Aetna.md (stopped after 1 of 2)");
    expect(fm("Prepay.md")["status"]).toBe("Explored"); // the first write stands
  });

  it("recolours without a structural change", async () => {
    const seen: boolean[] = [];
    model.onChange((s) => seen.push(s));
    await model.setStatus("Chess.md");
    expect(seen).toEqual([false]);
  });
});

describe("parent", () => {
  it("moves the edge, the file and the project list", async () => {
    expect(await model.editNote("Chess.md", "parent", "Work.md")).toEqual({ structural: true });
    expect(fm("Chess.md")["Parent"]).toBe("[[Work]]");
    expect(model.hierarchy.parentOf.get("Chess.md")).toBe("Work.md");
  });

  it("refuses a loop and an unknown target", async () => {
    await expect(model.editNote("Work.md", "parent", "Aetna.md")).rejects.toThrow("would make a loop");
    await expect(model.editNote("Work.md", "parent", "Work.md")).rejects.toThrow("would make a loop");
    await expect(model.editNote("Work.md", "parent", "Nope.md")).rejects.toThrow("no such note");
    expect(writer.writes).toEqual([]);
  });

  it("clears to a null value rather than removing the key", async () => {
    await model.editNote("Prepay.md", "parent", null);
    expect("Parent" in fm("Prepay.md")).toBe(true);
    expect(fm("Prepay.md")["Parent"]).toBeNull();
    expect(model.hierarchy.parentOf.has("Prepay.md")).toBe(false);
  });

  it("writes a pathed link when the stem is ambiguous", async () => {
    await model.editNote("Chess.md", "parent", "Notes/Memo.md");
    expect(fm("Chess.md")["Parent"]).toBe("[[Notes/Memo]]");
    await model.editNote("Chess.md", "parent", "Prepay.md");
    expect(fm("Chess.md")["Parent"]).toBe("[[Prepay]]");
  });
});

describe("category", () => {
  it("takes the form the vault uses for it", async () => {
    await model.editNote("Chess.md", "category", "task"); // known spelling wins, bare habit
    expect(fm("Chess.md")["categories"]).toEqual(["Task"]);
    await model.editNote("Chess.md", "category", "Projects"); // always linked
    expect(fm("Chess.md")["categories"]).toEqual(["[[Projects]]"]);
    await model.editNote("Chess.md", "category", "Meetings"); // unused, but in Categories/
    expect(fm("Chess.md")["categories"]).toEqual(["[[Meetings]]"]);
    await model.editNote("Chess.md", "category", "Brand new"); // as typed, bare
    expect(fm("Chess.md")["categories"]).toEqual(["Brand new"]);
    await model.editNote("Chess.md", "category", null);
    expect(fm("Chess.md")["categories"]).toBeNull();
  });

  it("patches in memory and re-derives project-ness at once", async () => {
    model.setDatatype("Projects", { project: true });
    expect(model.isProject("Memo.md")).toBe(false);
    expect(await model.editNote("Memo.md", "category", "Projects")).toEqual({ structural: false });
    expect(model.snapshot.notes.get("Memo.md")!.categories).toEqual(["Projects"]);
    expect(model.isProject("Memo.md")).toBe(true);
    await model.editNote("Memo.md", "category", null);
    expect(model.isProject("Memo.md")).toBe(false);
  });
});

describe("deadline", () => {
  it("writes an ISO date, clears to null, and refuses garbage before writing", async () => {
    await model.editNote("Ship.md", "deadline", "2026-09-16");
    expect(fm("Ship.md")["deadline"]).toBe("2026-09-16");
    expect(model.snapshot.notes.get("Ship.md")!.deadline).toBe("2026-09-16");
    await expect(model.editNote("Ship.md", "deadline", "soon")).rejects.toThrow("not a date");
    expect(fm("Ship.md")["deadline"]).toBe("2026-09-16");
    await model.editNote("Ship.md", "deadline", "");
    expect(fm("Ship.md")["deadline"]).toBeNull();
  });
});

describe("without a writer", () => {
  it("refuses every write", async () => {
    const readOnly = new ZoomInModel(fakeSource(files), new Store(emptyStore(), () => {}));
    readOnly.reload();
    expect(readOnly.canWrite).toBe(false);
    await expect(readOnly.setStatus("Work.md")).rejects.toThrow("cannot write");
  });
});
