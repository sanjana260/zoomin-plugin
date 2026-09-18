/** The task dashboard's composition rules, plus the model's tasks() —
 *  test_tasks.py and the /api/tasks behaviour, without a view. */

import { beforeEach, describe, expect, it } from "vitest";
import { ZoomInModel } from "../src/model";
import { domainMembers } from "../src/graph/build";
import { buildHierarchy } from "../src/graph/hierarchy";
import {
  applyOrder,
  daysUntil,
  deadlinePaths,
  domainTaskPaths,
  exploringTasksUnder,
  isTask,
  nearDeadline,
  stableShuffle,
  tier,
  todayIso,
} from "../src/graph/tasks";
import { Store, emptyStore } from "../src/state/store";
import { NoteSpec, fakeSource, note } from "./fake-cache";

// The Python tests pinned dates around 2026-09-13; deadines are written
// relative to it so the tiers are identical.
const TODAY = new Date(2026, 8, 13);
const day = (n: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  return todayIso(d);
};

function vaultFiles(): Record<string, NoteSpec | string> {
  return {
    "Work.md": note(),
    "Ship.md": note("Work", { frontmatter: { categories: ["Task"], status: "Exploring" } }),
    "Memo.md": note("Work", { frontmatter: { categories: ["Entry"], status: "Exploring" } }),
    "Done.md": note("Work", { frontmatter: { categories: ["Task"], status: "Explored", deadline: day(-8) } }),
    "Chess.md": note(),
    "Opening.md": note("Chess", { frontmatter: { categories: ["Task"], status: "Exploring", deadline: day(1) } }),
    "Castle.md": note("Chess", { frontmatter: { categories: ["Task"], status: "Exploring" } }),
    "Loose.md": note(null, { frontmatter: { categories: ["Task"], status: "Unexplored", deadline: day(9) } }),
    "Late.md": note(null, { frontmatter: { categories: ["Task"], status: "Exploring", deadline: day(-17) } }),
  };
}

let files: Record<string, NoteSpec | string>;
let model: ZoomInModel;

beforeEach(() => {
  files = vaultFiles();
  model = new ZoomInModel(fakeSource(files), new Store(emptyStore(), () => {}));
  model.reload();
});

const snapshot = () => model.snapshot;
const hierarchy = () => model.hierarchy;
const labelsOf = (paths: string[]) => paths.map((p) => snapshot().notes.get(p)!.title);
const rows = (paths: string[]) => paths.map((p) => model.payload() && p);

describe("what a task is", () => {
  it("is a note filed Task, and nothing else", () => {
    expect(isTask(snapshot().notes.get("Ship.md")!.categories)).toBe(true);
    expect(isTask(snapshot().notes.get("Memo.md")!.categories)).toBe(false); // exploring, but an Entry
    expect(isTask(snapshot().notes.get("Work.md")!.categories)).toBe(false);
  });
});

describe("the three lists", () => {
  it("gathers a slotted project's exploring tasks, done and entries excluded", () => {
    expect(labelsOf(exploringTasksUnder(snapshot(), hierarchy(), "Work.md"))).toEqual(["Ship"]);
  });

  it("gathers priority-domain tasks, minus what the feed is already shouting", () => {
    const d1 = model.createDomain("One");
    model.assign("Work.md", d1);
    model.assign("Chess.md", d1);
    model.setSlot("domain", d1, true);
    const paths = domainTaskPaths(snapshot(), hierarchy(), domainMembers(hierarchy(), model.store.assignments()), { domains: [d1], projects: [] }, TODAY);
    expect(labelsOf(paths).sort()).toEqual(["Castle", "Ship"]); // Opening is due tomorrow: the feed has it
  });

  it("tiers deadlines and skips done work in the feed", () => {
    expect(labelsOf(deadlinePaths(snapshot(), TODAY))).toEqual(["Late", "Opening", "Loose"]);
  });

  it("leaves near deadlines to the feed by the feed's own boundary", () => {
    expect(nearDeadline(day(7), TODAY)).toBe(true); // +7: the boundary is included
    expect(nearDeadline(day(8), TODAY)).toBe(false); // +8: kept by the domain list
    expect(nearDeadline(null, TODAY)).toBe(false);
  });

  it("computes days in the viewer's clock", () => {
    expect(daysUntil(day(3), TODAY)).toBe(3);
    expect(daysUntil(day(-1), TODAY)).toBe(-1);
    expect(tier(-1)).toBe("red");
    expect(tier(0)).toBe("red");
    expect(tier(7)).toBe("yellow");
    expect(tier(8)).toBe("grey");
  });
});

describe("order", () => {
  it("shuffles stably and applies a saved order over it", () => {
    const paths = ["a.md", "b.md", "c.md"];
    expect(stableShuffle(paths)).toEqual(stableShuffle(paths));
    expect(stableShuffle([...paths].reverse())).toEqual(stableShuffle(paths));
    expect(applyOrder(stableShuffle(paths), ["c.md"])[0]).toBe("c.md");
    expect(applyOrder(["a.md", "b.md"], ["gone.md", "b.md"])).toEqual(["b.md", "a.md"]);
  });

  it("round-trips a manual order through the model, per list", () => {
    model.setSlot("project", "Work.md", true);
    model.saveTaskOrder("focus:Work.md", ["Ship.md", "Done.md"]);
    const tasks = model.tasks(TODAY);
    // Done is explored, so it is not in the list at all; the order survives it.
    expect(tasks.focus[0].tasks.map((t) => t.label)).toEqual(["Ship"]);
    expect(() => model.saveTaskOrder("focus:Chess.md", ["x"])).toThrow("not in a slot"); // refused
    expect(model.store.taskOrder("focus:Chess.md")).toEqual([]);
  });

  it("composes the dashboard: focus, domains, deadlines, today", () => {
    model.setSlot("project", "Work.md", true);
    const d1 = model.createDomain("One");
    model.assign("Work.md", d1);
    model.assign("Chess.md", d1);
    model.setSlot("domain", d1, true);
    const tasks = model.tasks(TODAY);
    expect(tasks.today).toBe(day(0));
    expect(tasks.focus.map((f) => f.project.label)).toEqual(["Work"]);
    expect(tasks.focus[0].project.hue).toBe(204); // the first domain's hue, inherited by the slotted project
    expect(tasks.focus[0].project.domainName).toBe("One");
    expect(tasks.deadlines.map((t) => t.label)).toEqual(["Late", "Opening", "Loose"]);
    expect(tasks.deadlines[0].tier).toBe("red");
    expect(tasks.domains.map((t) => t.label)).toContain("Castle");
    expect(tasks.domains.every((t) => t.label !== "Opening")).toBe(true);
  });

  it("keys a focus order to its project, and the deadline feed has no manual layer", () => {
    model.setSlot("project", "Work.md", true);
    model.saveTaskOrder("domains", ["Loose.md"]);
    expect(model.store.taskOrder("domains")).toEqual(["Loose.md"]);
    expect(model.store.taskOrder("focus:Chess.md")).toEqual([]);
  });
});
