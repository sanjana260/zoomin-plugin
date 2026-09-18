/** Hierarchy derivation and the suppression rules. Port of tests/test_graph.py. */

import { describe, expect, it } from "vitest";
import {
  buildPayload,
  computeFocus,
  domainMembers,
  effectiveDomain,
  shapeIndex,
  shapeOf,
} from "../src/graph/build";
import { Hierarchy, buildHierarchy } from "../src/graph/hierarchy";
import { seedPosition } from "../src/graph/layout";
import {
  Assignments,
  Datatype,
  Domain,
  EXPLORED,
  EXPLORING,
  NORMAL,
  NO_STATUS,
  PRIORITY,
  Priorities,
  SUPPRESSED,
  UNEXPLORED,
  VaultSnapshot,
} from "../src/types";
import { assemble, note } from "./fake-cache";

const WORK: Domain = { id: "d-work", name: "Working life" };
const PLAY: Domain = { id: "d-play", name: "Play" };
const none: Priorities = { domains: [], projects: [] };
const assigned = (entries: Record<string, string | null>): Assignments => new Map(Object.entries(entries));

/** Work -> Prepay -> two leaves; Chess -> Opening; Loose on its own. */
function vault(): VaultSnapshot {
  return assemble({
    "Work.md": note(),
    "Prepay.md": note("Work"),
    "Aetna.md": note("Prepay"),
    "Dashboard.md": note("Prepay", { links: ["Chess"] }),
    "Chess.md": note(),
    "Opening.md": note("Chess"),
    "Loose.md": note(),
  });
}

const offered = (h: Hierarchy) => h.parents().map((n) => n.path);

function zip(payload: ReturnType<typeof buildPayload>, key: keyof ReturnType<typeof buildPayload>["nodes"]) {
  const out: Record<string, number | string> = {};
  payload.nodes.id.forEach((id, i) => (out[id] = payload.nodes[key][i]));
  return out;
}

describe("hierarchy", () => {
  it("reconstructs the project tree", () => {
    const h = buildHierarchy(vault());
    expect(h.nodes.get("Prepay.md")!.parent).toBe("Work.md");
    expect(h.ancestors("Aetna.md")).toEqual(["Prepay.md", "Work.md"]);
    expect([...h.roots].sort()).toEqual(["Chess.md", "Work.md"]);
  });

  it("counts every descendant in subtree size", () => {
    const h = buildHierarchy(vault());
    expect(h.nodes.get("Work.md")!.subtreeSize).toBe(3); // Prepay, Aetna, Dashboard
    expect(h.nodes.get("Chess.md")!.subtreeSize).toBe(1);
  });

  it("ranks projects by reach", () => {
    // Ranking decides what to offer first, never what belongs together.
    expect(buildHierarchy(vault()).parents().map((n) => n.title)).toEqual(["Work", "Prepay", "Chess"]);
  });

  it("does not offer leaf notes as projects", () => {
    const h = buildHierarchy(vault());
    expect(h.nodes.has("Aetna.md")).toBe(true);
    expect(offered(h)).not.toContain("Aetna.md");
  });

  it("has a lineage that agrees with itself", () => {
    const lineage = buildHierarchy(vault()).lineage();
    expect(lineage.get("Work.md")).toEqual([null, 0]);
    expect(lineage.get("Prepay.md")).toEqual(["Work.md", 1]);
    expect(lineage.get("Chess.md")).toEqual([null, 0]);
    for (const [path, [parent, depth]] of lineage) {
      expect(depth === 0, path).toBe(parent === null);
      if (parent !== null) expect(depth).toBe(lineage.get(parent)![1] + 1);
    }
  });

  it("steps lineage over a project that is never offered", () => {
    const lineage = buildHierarchy(
      assemble({ "Project Template.md": note(), "Real.md": note("Project Template"), "Leaf.md": note("Real") }),
    ).lineage();
    expect(lineage.has("Project Template.md")).toBe(false);
    expect(lineage.get("Real.md")).toEqual([null, 0]);
  });

  it("never offers templates as projects", () => {
    const h = buildHierarchy(assemble({ "Project Template.md": note(), "Child.md": note("Project Template") }));
    expect(h.parents().map((n) => n.title)).not.toContain("Project Template");
  });

  it("walks the whole subtree for descendants", () => {
    const h = buildHierarchy(vault());
    expect(h.descendants("Work.md")).toEqual(["Prepay.md", "Aetna.md", "Dashboard.md"]);
    expect(h.descendants("Prepay.md")).toEqual(["Aetna.md", "Dashboard.md"]);
    expect(h.descendants("Aetna.md")).toEqual([]);
  });

  it("survives a cycle in descendants", () => {
    const h = buildHierarchy(assemble({ "A.md": note("B"), "B.md": note("A"), "C.md": note("A") }));
    expect(h.descendants("A.md").sort()).toEqual(["B.md", "C.md"]);
  });
});

describe("declared and undeclared parents", () => {
  it("offers a declared leaf with nothing under it", () => {
    const h = buildHierarchy(vault(), ["Loose.md", "Aetna.md"]);
    expect(h.nodes.get("Loose.md")!.subtreeSize).toBe(0);
    expect(h.nodes.get("Loose.md")!.children).toEqual([]);
    expect(h.nodes.get("Loose.md")!.declared).toBe(true);
    expect(offered(h)).toEqual(["Work.md", "Prepay.md", "Chess.md", "Aetna.md", "Loose.md"]);
  });

  it("ignores a declared path the vault lacks", () => {
    expect(buildHierarchy(vault(), ["Gone.md"]).nodes.has("Gone.md")).toBe(false);
  });

  it("does not offer an undeclared parent but still carries its children", () => {
    const h = buildHierarchy(vault(), [], ["Work.md"]);
    expect(offered(h)).not.toContain("Work.md");
    expect(offered(h)).toContain("Prepay.md");
    expect(h.ancestors("Aetna.md")).toEqual(["Prepay.md", "Work.md"]);
    expect(effectiveDomain(h, assigned({ "Work.md": "d-work" }), "Aetna.md").domainId).toBe("d-work");
    expect(h.nodes.get("Work.md")!.subtreeSize).toBe(3);
  });

  it("still bows to the title exclusion when declared", () => {
    expect(offered(buildHierarchy(assemble({ "Project Template.md": note() }), ["Project Template.md"]))).toEqual([]);
  });

  it("copes with a declared leaf in lineage", () => {
    const lineage = buildHierarchy(vault(), ["Aetna.md", "Loose.md"]).lineage();
    expect(lineage.get("Aetna.md")).toEqual(["Prepay.md", 2]);
    expect(lineage.get("Loose.md")).toEqual([null, 0]);
    for (const [path, [parent, depth]] of lineage) expect(depth === 0, path).toBe(parent === null);
  });

  it("steps lineage over an undeclared parent", () => {
    const lineage = buildHierarchy(vault(), [], ["Work.md"]).lineage();
    expect(lineage.has("Work.md")).toBe(false);
    expect(lineage.get("Prepay.md")).toEqual([null, 0]);
  });

  it("marks isParent following declared and undeclared", () => {
    const v = vault();
    const flags = zip(buildPayload(v, buildHierarchy(v, ["Loose.md"], ["Chess.md"]), [], new Map(), none), "isParent");
    expect(flags["Loose.md"]).toBe(1);
    expect(flags["Chess.md"]).toBe(0);
    expect(flags["Work.md"]).toBe(1);
  });
});

describe("effective domain", () => {
  const membership = (a: Record<string, string | null>, path: string) => effectiveDomain(buildHierarchy(vault()), assigned(a), path);

  it("lets a subproject inherit its parent's domain", () => {
    expect(membership({ "Work.md": WORK.id }, "Prepay.md")).toEqual({ domainId: WORK.id, inherited: true });
  });

  it("lets an explicit assignment beat an inherited one", () => {
    expect(membership({ "Work.md": WORK.id, "Prepay.md": PLAY.id }, "Prepay.md")).toEqual({ domainId: PLAY.id, inherited: false });
  });

  it("stops the walk at an explicit unfiling", () => {
    const m = membership({ "Work.md": WORK.id, "Prepay.md": null }, "Prepay.md");
    expect(m.domainId).toBeNull();
    expect(m.inherited).toBe(false);
  });

  it("unfiles everything below a tombstone", () => {
    const a = { "Work.md": WORK.id, "Prepay.md": null };
    expect(membership(a, "Aetna.md").domainId).toBeNull();
    expect(membership(a, "Work.md").domainId).toBe(WORK.id);
  });

  it("only ever inherits upwards", () => {
    expect(membership({ "Prepay.md": PLAY.id }, "Work.md").domainId).toBeNull();
  });

  it("lists inherited members parents first", () => {
    const members = domainMembers(buildHierarchy(vault()), assigned({ "Work.md": WORK.id }));
    expect(members.get(WORK.id)!.map((m) => [m.path, m.inherited])).toEqual([["Work.md", false], ["Prepay.md", true]]);
  });

  it("omits a tombstoned subproject from members", () => {
    const members = domainMembers(buildHierarchy(vault()), assigned({ "Work.md": WORK.id, "Prepay.md": null }));
    expect(members.get(WORK.id)!.map((m) => m.path)).toEqual(["Work.md"]);
  });

  it("follows an overridden subproject to its own domain", () => {
    const members = domainMembers(buildHierarchy(vault()), assigned({ "Work.md": WORK.id, "Prepay.md": PLAY.id }));
    expect(members.get(WORK.id)!.map((m) => m.path)).toEqual(["Work.md"]);
    expect(members.get(PLAY.id)!.map((m) => [m.path, m.inherited])).toEqual([["Prepay.md", false]]);
  });
});

describe("suppression", () => {
  function focusFor(a: Record<string, string | null>, priorities: Priorities) {
    const v = vault();
    const h = buildHierarchy(v);
    const owners = new Map<string, string | null>();
    for (const p of v.notes.keys()) owners.set(p, effectiveDomain(h, assigned(a), p).domainId);
    return computeFocus(v, h, owners, priorities);
  }
  const levels = (m: Map<string, number>) => new Set(m.values());

  it("suppresses nothing before a priority is chosen", () => {
    expect(levels(focusFor({ "Work.md": WORK.id }, none))).toEqual(new Set([NORMAL]));
  });

  it("lifts a priority domain's project subtrees", () => {
    const f = focusFor({ "Work.md": WORK.id }, { domains: [WORK.id], projects: [] });
    expect(f.get("Work.md")).toBe(NORMAL);
    expect(f.get("Aetna.md")).toBe(NORMAL);
    expect(f.get("Chess.md")).toBe(SUPPRESSED);
    expect(f.get("Loose.md")).toBe(SUPPRESSED);
  });

  it("lifts only the projects assigned to the domain", () => {
    const f = focusFor({ "Chess.md": WORK.id }, { domains: [WORK.id], projects: [] });
    expect(f.get("Opening.md")).toBe(NORMAL);
    expect(f.get("Work.md")).toBe(SUPPRESSED);
  });

  it("does not lift a subproject taken out of a priority domain", () => {
    const f = focusFor({ "Work.md": WORK.id, "Prepay.md": null }, { domains: [WORK.id], projects: [] });
    expect(f.get("Work.md")).toBe(NORMAL);
    expect(f.get("Prepay.md")).toBe(SUPPRESSED);
    expect(f.get("Aetna.md")).toBe(SUPPRESSED);
  });

  it("lifts nothing for an empty domain", () => {
    expect(levels(focusFor({}, { domains: [WORK.id], projects: [] }))).toEqual(new Set([SUPPRESSED]));
  });

  it("lets a priority project outrank its domain", () => {
    const f = focusFor({ "Work.md": WORK.id }, { domains: [WORK.id], projects: ["Prepay.md"] });
    expect(f.get("Aetna.md")).toBe(PRIORITY);
    expect(f.get("Prepay.md")).toBe(PRIORITY);
    expect(f.get("Work.md")).toBe(NORMAL);
  });

  it("lifts a project slot's subtree even where a tombstone sits", () => {
    const f = focusFor({ "Prepay.md": null }, { domains: [], projects: ["Work.md"] });
    expect(f.get("Work.md")).toBe(PRIORITY);
    expect(f.get("Aetna.md")).toBe(PRIORITY);
  });

  it("suppresses nothing extra for a domain with no slot", () => {
    expect(levels(focusFor({ "Work.md": WORK.id, "Chess.md": PLAY.id }, none))).toEqual(new Set([NORMAL]));
  });
});

describe("payload", () => {
  function payloadFor(v: VaultSnapshot, opts: { domains?: Domain[]; assigned?: Record<string, string | null>; priorities?: Priorities } = {}) {
    return buildPayload(v, buildHierarchy(v), opts.domains ?? [], assigned(opts.assigned ?? {}), opts.priorities ?? none);
  }

  it("uses integer link indices", () => {
    const p = payloadFor(vault(), { domains: [WORK], assigned: { "Work.md": WORK.id } });
    const count = p.nodes.id.length;
    expect(p.links.source.every((i) => i >= 0 && i < count)).toBe(true);
    expect(p.links.target.every((i) => i >= 0 && i < count)).toBe(true);
  });

  it("names domains by the user, not by a note", () => {
    const p = payloadFor(vault(), { domains: [WORK], assigned: { "Work.md": WORK.id } });
    expect(p.domains).toEqual([{ id: WORK.id, label: "Working life", hue: 204, priority: false }]);
    expect(p.nodes.id).not.toContain(WORK.id);
  });

  it("gives notes the domain of their nearest assigned project", () => {
    const d = zip(payloadFor(vault(), { domains: [WORK, PLAY], assigned: { "Work.md": WORK.id, "Chess.md": PLAY.id } }), "domain");
    expect(d["Work.md"]).toBe(0);
    expect(d["Aetna.md"]).toBe(0);
    expect(d["Opening.md"]).toBe(1);
    expect(d["Loose.md"]).toBe(-1);
  });

  it("recolours the subtree a tombstone sits on", () => {
    const d = zip(payloadFor(vault(), { domains: [WORK], assigned: { "Work.md": WORK.id, "Prepay.md": null } }), "domain");
    expect(d["Work.md"]).toBe(0);
    expect(d["Prepay.md"]).toBe(-1);
    expect(d["Aetna.md"]).toBe(-1);
  });

  it("gives unassigned projects no domain", () => {
    expect(new Set(payloadFor(vault(), { domains: [WORK] }).nodes.domain)).toEqual(new Set([-1]));
  });

  it("leaves no colour behind for a retired domain", () => {
    expect(zip(payloadFor(vault(), { domains: [PLAY], assigned: { "Work.md": WORK.id } }), "domain")["Work.md"]).toBe(-1);
  });

  it("marks exactly the notes with children as parents", () => {
    const flags = zip(payloadFor(vault()), "isParent");
    expect(flags["Work.md"]).toBe(1);
    expect(flags["Chess.md"]).toBe(1);
    expect(flags["Aetna.md"]).toBe(0);
    expect(flags["Loose.md"]).toBe(0);
  });

  it("keeps size structural when focus moves", () => {
    const a = { "Work.md": WORK.id };
    const plain = payloadFor(vault(), { domains: [WORK], assigned: a });
    const focused = payloadFor(vault(), { domains: [WORK], assigned: a, priorities: { domains: [WORK.id], projects: ["Prepay.md"] } });
    expect(plain.nodes.size).toEqual(focused.nodes.size);
    expect(plain.nodes.focus).not.toEqual(focused.nodes.focus);
  });

  it("reports priority per domain", () => {
    const p = payloadFor(vault(), { domains: [WORK, PLAY], assigned: { "Work.md": WORK.id, "Chess.md": PLAY.id }, priorities: { domains: [PLAY.id], projects: [] } });
    expect(p.domains.map((d) => d.priority)).toEqual([false, true]);
  });

  it("marks the note in a project slot as slotted, and only it", () => {
    const p = payloadFor(vault(), { priorities: { domains: [], projects: ["Prepay.md"] } });
    const flags = zip(p, "isSlotted");
    expect(flags["Prepay.md"]).toBe(1);
    expect(p.nodes.isSlotted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(flags["Aetna.md"]).toBe(0);
  });

  it("slots nothing before a project slot is filled", () => {
    expect(new Set(payloadFor(vault()).nodes.isSlotted)).toEqual(new Set([0]));
  });

  it("shows phantom nodes for unwritten notes", () => {
    const v = assemble({ "A.md": note(null, { links: ["Not Written Yet"] }) });
    expect(v.phantoms.size).toBe(1);
    expect(payloadFor(v).nodes.kind).toContain(1);
  });

  it("lays out deterministically", () => {
    expect(seedPosition("Notes/Alpha.md")).toEqual(seedPosition("Notes/Alpha.md"));
    expect(seedPosition("Notes/Alpha.md")).not.toEqual(seedPosition("Notes/Beta.md"));
  });
});

describe("datatypes", () => {
  const TASK: Datatype = { id: "dt-task", name: "Task", shape: "square", isProject: false };
  const IDEA: Datatype = { id: "dt-idea", name: "Idea", shape: "diamond", isProject: false };

  const typedVault = () =>
    assemble({
      "Work.md": note(),
      "Todo.md": { frontmatter: { categories: ["Task"] } },
      "Shout.md": { frontmatter: { categories: ["TASK"] } },
      "Both.md": { frontmatter: { categories: ["Idea", "Task"] } },
      "Plain.md": {},
    });
  const withDatatypes = (datatypes: Datatype[]) => {
    const v = typedVault();
    return buildPayload(v, buildHierarchy(v), [], new Map(), none, new Map(), datatypes);
  };
  const shapeByPath = (p: ReturnType<typeof withDatatypes>) => {
    const out: Record<string, string | null> = {};
    p.nodes.id.forEach((id, i) => (out[id] = p.nodes.datatype[i] >= 0 ? p.datatypes[p.nodes.datatype[i]].shape : null));
    return out;
  };

  it("gives its notes a shape", () => {
    const s = shapeByPath(withDatatypes([TASK]));
    expect(s["Todo.md"]).toBe("square");
    expect(s["Plain.md"]).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(shapeByPath(withDatatypes([TASK]))["Shout.md"]).toBe("square");
  });

  it("lets the first category with a datatype win", () => {
    expect(shapeByPath(withDatatypes([TASK, IDEA]))["Both.md"]).toBe("diamond");
    expect(shapeByPath(withDatatypes([TASK]))["Both.md"]).toBe("square");
  });

  it("gives no datatype when none are defined", () => {
    expect(new Set(withDatatypes([]).nodes.datatype)).toEqual(new Set([-1]));
  });

  it("never lets a shapeless datatype win a note's shape", () => {
    const projects: Datatype = { id: "dt-proj", name: "Projects", shape: null, isProject: true };
    expect(shapeOf(["Projects", "Task"], shapeIndex([projects, TASK]))).toBe(1);
    expect(shapeOf(["Projects"], shapeIndex([projects, TASK]))).toBe(-1);
    const p = withDatatypes([projects, TASK]);
    expect(p.datatypes[0]).toEqual({ id: "dt-proj", name: "Projects", shape: null, is_project: true });
    expect(shapeByPath(p)["Todo.md"]).toBe("square");
  });

  it("never moves or resizes a node", () => {
    const plain = withDatatypes([]), typed = withDatatypes([TASK, IDEA]);
    expect(plain.nodes.size).toEqual(typed.nodes.size);
    expect(plain.nodes.x).toEqual(typed.nodes.x);
    expect(plain.nodes.y).toEqual(typed.nodes.y);
  });
});

describe("status", () => {
  const statuses = () => {
    const v = assemble({
      "Work.md": note(),
      "Doing.md": { frontmatter: { status: "Exploring" } },
      "Done.md": { frontmatter: { status: "Explored" } },
      "Todo.md": { frontmatter: { status: "Unexplored" } },
      "Silent.md": {},
    });
    return zip(buildPayload(v, buildHierarchy(v), [], new Map(), none), "status");
  };

  it("reaches the payload", () => {
    const s = statuses();
    expect(s["Doing.md"]).toBe(EXPLORING);
    expect(s["Done.md"]).toBe(EXPLORED);
    expect(s["Todo.md"]).toBe(UNEXPLORED);
  });

  it("keeps a note without a status at its own level", () => {
    expect(statuses()["Silent.md"]).toBe(NO_STATUS);
  });

  it("never moves or resizes a node", () => {
    const typed = assemble({ "A.md": { frontmatter: { status: "Explored" } }, "B.md": {} });
    const bare = assemble({ "A.md": {}, "B.md": {} });
    const pt = buildPayload(typed, buildHierarchy(typed), [], new Map(), none);
    const pb = buildPayload(bare, buildHierarchy(bare), [], new Map(), none);
    expect(pt.nodes.size).toEqual(pb.nodes.size);
    expect(pt.nodes.x).toEqual(pb.nodes.x);
  });
});

describe("size from direct children", () => {
  const sizesFor = (v: VaultSnapshot) => zip(buildPayload(v, buildHierarchy(v), [], new Map(), none), "size") as Record<string, number>;

  it("counts direct children, not mentions", () => {
    const sizes = sizesFor(
      assemble({
        "Organiser.md": note(),
        "A.md": note("Organiser"),
        "B.md": note("Organiser"),
        "C.md": note("Organiser"),
        "Mentioned.md": note(),
        "T1.md": note(null, { links: ["Mentioned"] }),
        "T2.md": note(null, { links: ["Mentioned"] }),
        "T3.md": note(null, { links: ["Mentioned"] }),
        "T4.md": note(null, { links: ["Mentioned"] }),
      }),
    );
    expect(sizes["Organiser.md"]).toBeCloseTo(1 + Math.sqrt(3), 3);
    expect(sizes["Mentioned.md"]).toBe(1.0);
  });

  it("makes a leaf the smallest thing on the map", () => {
    const sizes = sizesFor(vault());
    expect(sizes["Aetna.md"]).toBe(1.0);
    expect(sizes["Work.md"]).toBeGreaterThan(sizes["Aetna.md"]);
  });

  it("does not count grandchildren", () => {
    const sizes = sizesFor(assemble({ "Top.md": note(), "Mid.md": note("Top"), "Low1.md": note("Mid"), "Low2.md": note("Mid") }));
    expect(sizes["Top.md"]).toBe(2.0);
    expect(sizes["Mid.md"]).toBeCloseTo(1 + Math.sqrt(2), 3);
  });
});
