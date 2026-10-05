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
import { NoteSpec, fakeCreator, fakeSource, fakeWriter, note } from "./fake-cache";

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

describe("the focus box's promotion and quick-add", () => {
  let created: { path: string; content: string }[];
  let building: ZoomInModel;

  beforeEach(() => {
    created = [];
    building = new ZoomInModel(fakeSource(files), new Store(emptyStore(), () => {}), writer, fakeCreator(created));
    building.reload();
  });

  it("promotes an entry to a task in place, with the vault's own Task form", async () => {
    await building.promoteToTask("Memo.md");
    const frontmatter = fm("Memo.md");
    // Bare "Task": the vault's commonest spelling, and the vault writes Task bare.
    expect(frontmatter.categories).toEqual(["Task"]);
    expect(frontmatter.status).toBe("Exploring");
    expect(frontmatter.Parent).toBe("[[Work]]"); // untouched
    const note = building.snapshot.notes.get("Memo.md")!;
    expect(note.status).toBe("exploring");
    expect(note.categories).toEqual(["Task"]);
  });

  it("plants a child in the vault root: exploring, typed, dated, parented", async () => {
    const path = await building.createChildNote("Work.md", "Draft spec", "Task", "2026-10-10");
    expect(path).toBe("Draft spec.md");
    expect(created).toEqual([{ path: "Draft spec.md", content: expect.any(String) }]);
    const text = created[0].content;
    expect(text).toContain("status: Exploring");
    expect(text).toContain("categories:\n  - Task");
    expect(text).toContain("deadline: 2026-10-10");
    expect(text).toContain('Parent: "[[Work]]"');
  });

  it("writes no category or deadline keys when none are given", async () => {
    await building.createChildNote("Work.md", "Bare child", null, null);
    const text = created[0].content;
    expect(text).not.toContain("categories:");
    expect(text).not.toContain("deadline:");
    expect(text).toContain('Parent: "[[Work]]"');
  });

  it("refuses a second note with the same name", async () => {
    await building.createChildNote("Work.md", "Draft spec", null, null);
    await expect(building.createChildNote("Work.md", "Draft spec", null, null)).rejects.toThrow(/already exists/);
  });

  it("refuses an empty name", async () => {
    await expect(building.createChildNote("Work.md", "   ", null, null)).rejects.toThrow(/needs a name/);
    expect(created).toHaveLength(0);
  });

  it("validates the deadline before anything is written", async () => {
    await expect(building.createChildNote("Work.md", "Dated", "Task", "soon")).rejects.toThrow(/not a date/);
    expect(created).toHaveLength(0);
  });

  it("keeps the parent a path when the stem is ambiguous", async () => {
    // "Memo" is ambiguous — Memo.md and Notes/Memo.md — so a child of Memo
    // must carry the path, not the bare stem.
    await building.createChildNote("Notes/Memo.md", "Memo child", null, null);
    expect(created[0].content).toContain('Parent: "[[Notes/Memo]]"');
  });

  it("refuses to create without a creator", async () => {
    await expect(model.createChildNote("Work.md", "Nope", null, null)).rejects.toThrow("cannot create");
  });
});
