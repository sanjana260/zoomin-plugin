/**
 * The store and the model's rules, against the tiny vault test_api.py used:
 * Work → Prepay → Aetna (which links a phantom), plus Chess filed
 * `[[Projects]]` with no children. What the API tests pinned about state,
 * without the HTTP.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ZoomInModel } from "../src/model";
import { SlotFull, Store, StoreData, emptyStore, upgrade } from "../src/state/store";
import { fakeSource, note } from "./fake-cache";

function vaultSource() {
  return fakeSource({
    "Work.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
    "Prepay.md": note("Work", { frontmatter: { categories: ["[[Projects]]"] } }),
    "Aetna.md": note("Prepay", { links: ["Ghost"] }),
    "Chess.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
    "Categories/Projects.md": note(),
    "Categories/Unused.md": note(),
  });
}

let saved: StoreData[];
let model: ZoomInModel;

beforeEach(() => {
  saved = [];
  const store = new Store(emptyStore(), (data) => saved.push(JSON.parse(JSON.stringify(data))));
  model = new ZoomInModel(vaultSource(), store);
  model.caps = { domainSlots: 2, projectSlots: 1 };
  model.reload();
});

const labels = () => model.projects().map((p) => p.label);
const isParent = () => {
  const p = model.payload();
  const out: Record<string, number> = {};
  p.nodes.id.forEach((id, i) => (out[id] = p.nodes.isParent[i]));
  return out;
};

describe("domains and assignments", () => {
  it("offers projects ranked and unfiled", () => {
    expect(labels()).toEqual(["Work", "Prepay"]);
    expect(model.projects().every((p) => p.domainId === null)).toBe(true);
  });

  it("names a domain by the user and needs a name", () => {
    const id = model.createDomain("Working life");
    expect(model.domains().map((d) => [d.id, d.name, d.hue])).toEqual([[id, "Working life", 204]]);
    expect(() => model.createDomain("   ")).toThrow("needs a name");
  });

  it("keeps creation order, which is hue order", () => {
    model.createDomain("B");
    model.createDomain("A");
    expect(model.domains().map((d) => d.name)).toEqual(["B", "A"]);
  });

  it("moves a project when assigned twice", () => {
    const a = model.createDomain("A"), b = model.createDomain("B");
    model.assign("Work.md", a);
    model.assign("Work.md", b);
    expect(model.store.assignments()).toEqual(new Map([["Work.md", b]]));
    expect(model.domains().find((d) => d.id === a)!.projects).toEqual([]);
  });

  it("refuses an unknown project or domain", () => {
    const a = model.createDomain("A");
    expect(() => model.assign("Aetna.md", a)).toThrow("unknown project");
    expect(() => model.assign("Work.md", "nope")).toThrow("unknown domain");
  });

  it("drops a root project's row on unassign — no ancestor to inherit from", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.assign("Work.md", null);
    expect(model.store.assignments().size).toBe(0);
  });

  it("writes a tombstone when an ancestor would refile the project", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    expect(model.projects().find((p) => p.path === "Prepay.md")!.inherited).toBe(true);
    model.assign("Prepay.md", null);
    expect(model.store.assignments().get("Prepay.md")).toBeNull();
    expect(model.projects().find((p) => p.path === "Prepay.md")!.domainId).toBeNull();
    expect(model.domains()[0].projects.map((p) => p.path)).toEqual(["Work.md"]);
  });

  it("lists inherited members with the flag, parents first", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    expect(model.domains()[0].projects.map((p) => [p.path, p.inherited])).toEqual([["Work.md", false], ["Prepay.md", true]]);
  });

  it("renames in place, keeping assignments and slots", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.setSlot("domain", a, true);
    model.renameDomain(a, "Alpha");
    expect(model.domains()[0].name).toBe("Alpha");
    expect(model.domains()[0].projects.length).toBe(2); // Work and inherited Prepay
    expect(model.priorities().domains).toEqual([a]);
    expect(() => model.renameDomain("nope", "x")).toThrow("unknown domain");
  });

  it("deleting a domain frees its slot, its projects, and the tombstones it caused", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.assign("Prepay.md", null); // tombstone against A
    model.setSlot("domain", a, true);
    model.deleteDomain(a);
    expect(model.domains()).toEqual([]);
    expect(model.priorities().domains).toEqual([]);
    expect(model.store.assignments().size).toBe(0);
    expect(model.store.data.slotHistory.map((h) => h.action)).toEqual(["fill", "clear"]);
  });
});

describe("slots", () => {
  it("rejects filling past the cap", () => {
    const a = model.createDomain("A"), b = model.createDomain("B"), c = model.createDomain("C");
    model.setSlot("domain", a, true);
    model.setSlot("domain", b, true);
    expect(() => model.setSlot("domain", c, true)).toThrow(SlotFull);
    expect(model.priorities().domains).toEqual([a, b]);
  });

  it("gives project slots their own cap", () => {
    model.setSlot("project", "Work.md", true);
    expect(() => model.setSlot("project", "Prepay.md", true)).toThrow("all 1 project slots are full");
  });

  it("refuses to prioritise something that does not exist", () => {
    expect(() => model.setSlot("domain", "nope", true)).toThrow("unknown domain");
    expect(() => model.setSlot("project", "Nope.md", true)).toThrow("unknown project");
  });

  it("frees a slot on deselect and records both moves", () => {
    model.setSlot("project", "Work.md", true);
    model.setSlot("project", "Work.md", true); // idempotent, not recorded twice
    model.setSlot("project", "Work.md", false);
    expect(model.priorities().projects).toEqual([]);
    expect(model.store.data.slotHistory.map((h) => [h.kind, h.action, h.key])).toEqual([
      ["project", "fill", "Work.md"],
      ["project", "clear", "Work.md"],
    ]);
  });

  it("lets a priority domain lift the projects filed under it", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.setSlot("domain", a, true);
    const p = model.payload();
    const focus: Record<string, number> = {};
    p.nodes.id.forEach((id, i) => (focus[id] = p.nodes.focus[i]));
    expect(focus["Aetna.md"]).toBe(1);
    expect(focus["Chess.md"]).toBe(0);
    expect(p.domains[0].priority).toBe(true);
  });

  it("lists exploring descendants of a priority project, not the project itself", () => {
    const store = new Store(emptyStore(), () => {});
    const m = new ZoomInModel(
      fakeSource({
        "Work.md": note(null, { frontmatter: { status: "Exploring" } }),
        "Doing.md": note("Work", { frontmatter: { status: "Exploring", categories: ["Task"] } }),
        "Done.md": note("Work", { frontmatter: { status: "Explored" } }),
      }),
      store,
    );
    m.reload();
    m.store.setDatatype("Task", "square");
    m.setSlot("project", "Work.md", true);
    expect(m.priorities().exploring["Work.md"]).toEqual([{ path: "Doing.md", label: "Doing", shape: "square" }]);
  });
});

describe("datatypes and categories", () => {
  it("merges the folder with what notes actually use, ranked by use", () => {
    expect(model.categories().map((c) => [c.name, c.count, c.inFolder])).toEqual([
      ["Projects", 3, true],
      ["Unused", 0, true],
    ]);
  });

  it("keeps one shape per category regardless of spelling, and can clear it", () => {
    model.setDatatype("projects", { shape: "square" });
    model.setDatatype("PROJECTS", { shape: "star" });
    expect(model.store.datatypes().map((d) => [d.name, d.shape])).toEqual([["projects", "star"]]);
    model.setDatatype("Projects", { shape: null });
    expect(model.store.datatypes()).toEqual([]);
  });

  it("refuses an unknown shape", () => {
    expect(() => model.setDatatype("Task", { shape: "blob" })).toThrow("unknown shape");
  });

  it("keeps the shape and the project flag independent", () => {
    model.setDatatype("Projects", { shape: "square" });
    model.setDatatype("Projects", { project: true });
    const row = () => model.categories().find((c) => c.name === "Projects")!;
    expect([row().shape, row().project]).toEqual(["square", true]);
    model.setDatatype("Projects", { shape: "star" });
    expect([row().shape, row().project]).toEqual(["star", true]);
    model.setDatatype("Projects", { shape: null });
    expect([row().shape, row().project]).toEqual([null, true]);
    expect(model.payload().datatypes.map((d) => d.shape)).toEqual([null]);
    model.setDatatype("Projects", { project: false });
    expect(model.store.datatypes()).toEqual([]);
  });

  it("makes a childless note a project through a flagged category, without a rescan", () => {
    expect(labels()).toEqual(["Work", "Prepay"]);
    expect(isParent()["Chess.md"]).toBe(0);
    model.setDatatype("Projects", { project: true });
    expect(labels()).toEqual(["Work", "Prepay", "Chess"]);
    expect(isParent()["Chess.md"]).toBe(1);
    expect(new Set(model.payload().nodes.datatype)).toEqual(new Set([-1])); // flag-only: no shape
    model.setDatatype("Projects", { project: false });
    expect(labels()).toEqual(["Work", "Prepay"]);
  });
});

describe("project rulings", () => {
  it("ruling a parent out removes it and frees its slot", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.setSlot("project", "Work.md", true);
    expect(model.setProjectOverride("Work.md", false)).toEqual({ project: false, slotCleared: true });
    expect(labels()).toEqual(["Prepay"]);
    expect(model.priorities().projects).toEqual([]);
    expect(isParent()["Work.md"]).toBe(0);
    // Inheritance runs on `Parent:` alone, so Prepay still takes Work's domain.
    const prepay = model.projects()[0];
    expect([prepay.domainId, prepay.inherited, prepay.depth]).toEqual([a, true, 0]);
    expect(model.setProjectOverride("Work.md", false).slotCleared).toBe(false);
    expect(model.setProjectOverride("Work.md", null)).toEqual({ project: true, slotCleared: false });
    expect(labels()).toEqual(["Work", "Prepay"]);
  });

  it("ruling a leaf in adds it, filable and slottable", () => {
    expect(model.setProjectOverride("Aetna.md", true)).toEqual({ project: true, slotCleared: false });
    expect(labels()).toEqual(["Work", "Prepay", "Aetna"]);
    const aetna = model.projects().find((p) => p.path === "Aetna.md")!;
    expect([aetna.parent, aetna.depth, aetna.size]).toEqual(["Prepay.md", 2, 0]);
    model.assign("Aetna.md", model.createDomain("Health"));
    model.setSlot("project", "Aetna.md", true);
    expect(model.priorities().projects).toEqual(["Aetna.md"]);
  });

  it("lets a ruling outrank the datatype flag", () => {
    model.setDatatype("Projects", { project: true });
    expect(labels()).toContain("Chess");
    model.setProjectOverride("Chess.md", false);
    expect(labels()).not.toContain("Chess");
    model.setProjectOverride("Chess.md", null);
    expect(labels()).toContain("Chess");
  });

  it("refuses an unknown or phantom note", () => {
    expect(() => model.setProjectOverride("Nope.md", true)).toThrow("no such note");
    expect(() => model.setProjectOverride("phantom:ghost", true)).toThrow("no such note");
  });
});

describe("persistence and renames", () => {
  it("saves after every mutation, in a shape that reloads", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.setSlot("domain", a, true);
    const last = saved[saved.length - 1];
    const store = new Store(upgrade(last), () => {});
    expect(store.domains()).toEqual([{ id: a, name: "A" }]);
    expect(store.assignments()).toEqual(new Map([["Work.md", a]]));
    expect(store.priorities()).toEqual({ domains: [a], projects: [] });
  });

  it("upgrades an empty or partial file to the current version", () => {
    expect(upgrade(undefined).version).toBe(1);
    expect(upgrade({ domains: [{ id: "x", name: "X", createdAt: 1, retiredAt: null }] }).domains.length).toBe(1);
    expect(upgrade({}).taskOrder).toEqual({});
  });

  it("follows a rename through every path-keyed row", () => {
    const a = model.createDomain("A");
    model.assign("Work.md", a);
    model.setSlot("project", "Prepay.md", true);
    model.setProjectOverride("Aetna.md", true);
    model.store.saveTaskOrder("focus:Prepay.md", ["Aetna.md"]);
    model.rename("Prepay.md", "Prepaid.md");
    model.rename("Aetna.md", "Cigna.md");
    expect(model.store.priorities().projects).toEqual(["Prepaid.md"]);
    expect(model.store.projectOverrides()).toEqual(new Map([["Cigna.md", true]]));
    expect(model.store.taskOrder("focus:Prepaid.md")).toEqual(["Cigna.md"]);
    expect(model.store.assignments()).toEqual(new Map([["Work.md", a]]));
  });

  it("keeps a task order per list, replaces wholesale, skips unknown paths", () => {
    model.store.saveTaskOrder("domains", ["Aetna.md", "Nope.md", "Work.md"]);
    expect(model.store.taskOrder("domains")).toEqual(["Aetna.md", "Work.md"]);
    model.store.saveTaskOrder("domains", ["Work.md"]);
    expect(model.store.taskOrder("domains")).toEqual(["Work.md"]);
    expect(model.store.taskOrder("focus:Work.md")).toEqual([]);
  });

  it("tells the views whether a reload was structural", () => {
    const seen: boolean[] = [];
    model.onChange((structural) => seen.push(structural));
    model.reload(); // same vault: nothing structural
    model.createDomain("A");
    expect(seen).toEqual([false, false]);
  });
});

describe("migration from the pywebview app", () => {
  it("loads what scripts/migrate_state.py writes", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/migrated.json"), "utf8"));
    const store = new Store(upgrade(raw.store), () => {});
    expect(store.domains().map((d) => d.name)).toEqual(["School", "Life Admin"]);
    const school = store.domains()[0].id;
    expect(store.assignments().get("Work.md")).toBe(school);
    expect(store.assignments().get("Prepay.md")).toBeNull();
    expect(store.priorities()).toEqual({ domains: [school], projects: [] });
    expect(store.datatypes().map((d) => [d.name, d.shape, d.isProject])).toEqual([["Task", "diamond", false], ["Projects", null, true]]);
    expect(store.projectOverrides()).toEqual(new Map([["Aetna.md", true]]));
    expect(store.taskOrder("focus:Work.md")).toEqual(["Prepay.md"]);
    expect(raw.settings).toEqual({ domainSlots: 4, projectSlots: 2, followActiveFile: true });
    expect(raw.positions["Work.md"]).toEqual([1.5, -2.25]);
  });
});

describe("the dossier's note view", () => {
  function noteModel() {
    const files = {
      "Work.md": note(null, { frontmatter: { categories: ["[[Projects]]"], status: "Exploring", Description: "Everything done for money.", deadline: "2026-09-20" } }),
      "Prepay.md": note("Work", { frontmatter: { categories: ["Task"], status: "Exploring" } }),
      "Aetna.md": note("Prepay", { links: ["Ghost"] }),
      "Chess.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
      "Categories/Projects.md": note(),
    };
    const m = new ZoomInModel(fakeSource(files), new Store(emptyStore(), () => {}));
    m.reload();
    return { m, files };
  }

  it("reads one note in words: parent, domain, datatype, children, description", () => {
    const { m } = noteModel();
    const d = m.createDomain("One");
    m.assign("Work.md", d);
    const n = m.note("Prepay.md")!;
    expect(n.label).toBe("Prepay");
    expect(n.parent).toEqual({ path: "Work.md", label: "Work" });
    expect(n.domain).toEqual({ id: d, name: "One", hue: 204 });
    expect(n.datatype).toBeNull(); // a category with no datatype row gives no datatype
    expect(n.status).toBe("exploring");
    expect(m.note("Work.md")!.children).toBe(1);
    expect(m.note("Work.md")!.description).toBe("Everything done for money.");
    expect(m.note("Work.md")!.deadline).toBe("2026-09-20");
    expect(m.note("Nope.md")).toBeNull();
  });

  it("names the source that settled project-ness, and what the automatics would say", () => {
    const { m } = noteModel();
    // Children: Work is offered, nothing declared.
    expect(m.projectVerdict("Work.md")).toMatchObject({ is: true, reason: "children", override: null, automatic: true });
    // A datatype flag outranks children.
    m.setDatatype("Projects", { project: true });
    expect(m.projectVerdict("Chess.md")).toMatchObject({ is: true, reason: "datatype" });
    // A ruling outranks the flag; removing names itself.
    m.setProjectOverride("Chess.md", false);
    expect(m.projectVerdict("Chess.md")).toMatchObject({ is: false, reason: "removed", override: false, automatic: true });
    m.setProjectOverride("Chess.md", null);
    expect(m.projectVerdict("Chess.md")).toMatchObject({ reason: "datatype" });
    // Declared by a ruling alone.
    m.setProjectOverride("Aetna.md", true);
    expect(m.projectVerdict("Aetna.md")).toMatchObject({ is: true, reason: "declared", override: true, automatic: false });
  });

  it("splits a note's links by direction", () => {
    const { m } = noteModel();
    const links = m.neighbours("Prepay.md");
    // `out` is what this note points at — its parent; `in` is what points at it.
    expect(links.out.map((l) => l.path)).toEqual(["Work.md"]);
    expect(links.out[0].kind).toBe(1); // hierarchy
    expect(links.in.map((l) => l.path)).toEqual(["Aetna.md"]);
    expect(m.neighbours("Aetna.md").out.map((l) => l.path)).toEqual(["Prepay.md", "phantom:ghost"]); // its parent, and its mention
  });
});
