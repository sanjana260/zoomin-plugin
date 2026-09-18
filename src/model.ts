/**
 * Everything ZoomIn knows, in one place: the vault as last read, the tree
 * derived from it, the app's state laid over it, and the payload the views
 * draw. The Python app's `Session` plus its endpoints, minus the HTTP.
 *
 * Views never read the vault or the store directly; they ask the model and
 * subscribe to `change`. The model never touches a DOM.
 *
 * Two kinds of change reach the views, and the distinction matters or the map
 * jumps: a *structural* change (a note came, went, was renamed, or a link
 * moved) means the renderer must reload its data and reheat; anything else
 * (status, category, deadline, priorities, domains, datatypes) only recolours
 * and must not move a node. The model decides which by comparing the new
 * snapshot's structure with the old one, so a callback never has to guess.
 */

import { DOMAIN_HUES, Member, buildPayload, domainMembers, effectiveDomain, shapeIndex, shapeOf } from "./graph/build";
import { Hierarchy, TreeNode, buildHierarchy } from "./graph/hierarchy";
import { RowBuilder, applyOrder, deadlinePaths, domainTaskPaths, exploringTasksUnder, stableShuffle, todayIso } from "./graph/tasks";
import type { TaskRow } from "./graph/tasks";
export type { TaskRow };
import { Store } from "./state/store";
import { Datatype, GraphPayload, LinkKind, Positions, STATUSES, Status, VaultSnapshot, fold } from "./types";
import { categoryNames } from "./vault/categories";
import { CATEGORY_DIR, CacheSource, buildSnapshot } from "./vault/snapshot";
import { FrontmatterWriter, nextStatus, setCategory, setDeadline, setParent, setStatus } from "./vault/write";

export type ChangeListener = (structural: boolean) => void;

export interface SlotCaps {
  domainSlots: number;
  projectSlots: number;
}

/** One project as the sidebar and the domain dialog see it. */
export interface ProjectView {
  path: string;
  label: string;
  size: number;
  domainId: string | null;
  inherited: boolean;
  /** nearest offered ancestor, for the dialog's tree */
  parent: string | null;
  depth: number;
}

export interface DomainView {
  id: string;
  name: string;
  hue: number;
  priority: boolean;
  projects: { path: string; label: string; size: number; priority: boolean; inherited: boolean }[];
}

export interface CategoryView {
  name: string;
  count: number;
  inFolder: boolean;
  shape: string | null;
  project: boolean;
}

export interface FocusBox {
  project: { path: string; label: string; hue: number | null; domainName: string | null };
  tasks: TaskRow[];
}

export interface TasksModelView {
  today: string;
  focus: FocusBox[];
  domains: TaskRow[];
  deadlines: TaskRow[];
}

export interface PrioritiesView {
  domains: string[];
  projects: string[];
  /** per priority project: its exploring descendants, for the sidebar's list */
  exploring: Record<string, { path: string; label: string; shape: string | null }[]>;
  domainSlots: number;
  projectSlots: number;
}

export class ZoomInModel {
  snapshot: VaultSnapshot = { notes: new Map(), edges: [], phantoms: new Map() };
  hierarchy: Hierarchy = new Hierarchy(new Map(), [], new Map());
  /** Persisted layout, owned by the plugin's per-device state. */
  positions: Positions = new Map();
  caps: SlotCaps = { domainSlots: 3, projectSlots: 1 };

  private listeners = new Set<ChangeListener>();
  private structureKey = "";
  private cached: GraphPayload | null = null;

  constructor(
    private readonly source: CacheSource,
    public readonly store: Store,
    private readonly writer: FrontmatterWriter | null = null,
  ) {
    store.knows = (path) => this.snapshot.notes.has(path);
  }

  /** Whether this model can write to the vault at all (a writer was wired in). */
  get canWrite(): boolean {
    return this.writer !== null;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(structural: boolean): void {
    this.cached = null;
    for (const listener of this.listeners) listener(structural);
  }

  /** Every note whose category is flagged as a project datatype. */
  private flaggedPaths(): Set<string> {
    const projectCategories = new Set(this.store.datatypes().filter((d) => d.isProject).map((d) => fold(d.name)));
    const paths = new Set<string>();
    if (!projectCategories.size) return paths;
    for (const [path, note] of this.snapshot.notes) {
      if (note.categories.some((name) => projectCategories.has(fold(name)))) paths.add(path);
    }
    return paths;
  }

  /** Re-read the vault and rebuild everything. Returns whether the structure changed. */
  reload(): boolean {
    this.snapshot = buildSnapshot(this.source);
    const key = structureKeyOf(this.snapshot);
    const structural = key !== this.structureKey;
    this.structureKey = key;
    this.rebuild(structural);
    return structural;
  }

  /**
   * Rebuild the tree from the current snapshot plus the store's rulings.
   *
   * Project-ness has three sources: the tree, a datatype flagged as a project
   * kind, and the user's per-note ruling. The last two are app state, so a
   * change to either needs the tree re-derived without a rescan — this is
   * that step. Precedence is applied here, once: a ruling beats a flag, a
   * flag beats the tree.
   */
  rebuild(structural = false): void {
    const declared = this.flaggedPaths();
    const undeclared = new Set<string>();
    for (const [path, ruling] of this.store.projectOverrides()) {
      if (ruling) declared.add(path);
      else {
        declared.delete(path);
        undeclared.add(path);
      }
    }
    this.hierarchy = buildHierarchy(this.snapshot, declared, undeclared);
    // The store needs the vault's tree to know whether removing a project
    // from a domain requires a tombstone.
    this.store.ancestors = (path) => this.hierarchy.ancestors(path);
    this.emit(structural);
  }

  /** A note moved. The store follows it; the vault event will reload the map. */
  rename(oldPath: string, newPath: string): void {
    this.store.rename(oldPath, newPath);
    const xy = this.positions.get(oldPath);
    if (xy) {
      this.positions.delete(oldPath);
      this.positions.set(newPath, xy);
    }
  }

  /* --- reads -------------------------------------------------------------- */

  payload(): GraphPayload {
    if (!this.cached) {
      this.cached = buildPayload(
        this.snapshot,
        this.hierarchy,
        this.store.domains(),
        this.store.assignments(),
        this.store.priorities(),
        this.positions,
        this.store.datatypes(),
      );
    }
    return this.cached;
  }

  /** path → ranked parent node, best first. Insertion order is the rank. */
  rankedProjects(): Map<string, TreeNode> {
    const out = new Map<string, TreeNode>();
    for (const node of this.hierarchy.parents()) out.set(node.path, node);
    return out;
  }

  isProject(path: string): boolean {
    return this.rankedProjects().has(path);
  }

  /** Every assignable project, ranked, with enough tree to render one. */
  projects(): ProjectView[] {
    const assignments = this.store.assignments();
    const lineage = this.hierarchy.lineage();
    return [...this.rankedProjects().values()].map((node) => {
      const member = effectiveDomain(this.hierarchy, assignments, node.path);
      const [parent, depth] = lineage.get(node.path) ?? [null, 0];
      return {
        path: node.path,
        label: node.title,
        size: node.subtreeSize,
        domainId: member.domainId,
        inherited: member.inherited,
        parent,
        depth,
      };
    });
  }

  domains(): DomainView[] {
    const ranked = this.rankedProjects();
    const members = domainMembers(this.hierarchy, this.store.assignments());
    const priorities = this.store.priorities();
    const priorityDomains = new Set(priorities.domains);
    const priorityProjects = new Set(priorities.projects);
    const project = (member: Member) => {
      // A project can outlive its note: the vault is edited elsewhere, and
      // an assignment shouldn't vanish silently when a file is renamed.
      const node = ranked.get(member.path);
      return {
        path: member.path,
        label: node ? node.title : labelFor(member.path),
        size: node ? node.subtreeSize : 0,
        priority: priorityProjects.has(member.path),
        inherited: member.inherited,
      };
    };
    return this.store.domains().map((domain, i) => ({
      id: domain.id,
      name: domain.name,
      hue: DOMAIN_HUES[i % DOMAIN_HUES.length],
      priority: priorityDomains.has(domain.id),
      projects: (members.get(domain.id) ?? []).map(project),
    }));
  }

  priorities(): PrioritiesView {
    const priorities = this.store.priorities();
    const datatypes = this.store.datatypes();
    const index = shapeIndex(datatypes);
    const exploring: PrioritiesView["exploring"] = {};
    // What's actually in motion under each priority project — the notes
    // currently being worked on, not the ones done or not yet started. Shape
    // travels with each entry so the list can draw the same silhouette the
    // map does.
    for (const path of priorities.projects) {
      const found: { path: string; label: string; shape: string | null }[] = [];
      for (const descendant of this.hierarchy.descendants(path)) {
        const note = this.snapshot.notes.get(descendant);
        if (!note || note.status !== "exploring") continue;
        const i = shapeOf(note.categories, index);
        found.push({ path: descendant, label: note.title, shape: i >= 0 ? datatypes[i].shape : null });
      }
      found.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
      exploring[path] = found;
    }
    return {
      domains: priorities.domains,
      projects: priorities.projects,
      exploring,
      domainSlots: this.caps.domainSlots,
      projectSlots: this.caps.projectSlots,
    };
  }

  /**
   * Every category that could be given a shape, with how much it is used.
   *
   * The names are the union of two sources, because neither alone is honest:
   * the notes in `Categories/`, and the values notes actually write. On the
   * reference vault they barely overlap — Task (113 notes), Idea (32) and
   * Reference (9) have no note anywhere, while 16 of the 22 `Categories/`
   * notes are never used.
   */
  categories(): CategoryView[] {
    const { counts, display, inFolder } = this.categoryCensus();
    const datatypes = new Map<string, Datatype>();
    for (const d of this.store.datatypes()) datatypes.set(fold(d.name), d);
    const rows: CategoryView[] = [...counts.keys()].map((key) => ({
      name: display.get(key)!,
      count: counts.get(key) ?? 0,
      inFolder: inFolder.has(key),
      shape: datatypes.get(key)?.shape ?? null,
      project: datatypes.get(key)?.isProject ?? false,
    }));
    // Most-used first: the categories worth distinguishing are the ones you
    // actually have notes in. Ties break alphabetically so the list is stable.
    rows.sort((a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return rows;
  }

  /** (count, display label, in the `Categories/` folder) per folded name. */
  private categoryCensus(): { counts: Map<string, number>; display: Map<string, string>; inFolder: Set<string> } {
    const counts = new Map<string, number>();
    // Spellings seen, per folded name. `Task` and `TASK` are one category,
    // but one of them has to be the label — and picking whichever note the
    // filesystem handed over first would rename the category between scans.
    const spellings = new Map<string, Map<string, number>>();
    const folderTitle = new Map<string, string>();
    for (const [path, note] of this.snapshot.notes) {
      if (path.startsWith(`${CATEGORY_DIR}/`)) {
        const key = fold(note.title);
        folderTitle.set(key, note.title);
        if (!counts.has(key)) counts.set(key, 0);
        if (!spellings.has(key)) spellings.set(key, new Map());
      }
      for (const name of note.categories) {
        const key = fold(name);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const seen = spellings.get(key) ?? new Map<string, number>();
        seen.set(name, (seen.get(name) ?? 0) + 1);
        spellings.set(key, seen);
      }
    }
    const label = (key: string): string => {
      // The note in Categories/ is the vault declaring the spelling, so it
      // wins. Otherwise the commonest, alphabetical to break a tie.
      const declared = folderTitle.get(key);
      if (declared) return declared;
      const seen = [...spellings.get(key)!.entries()];
      seen.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return seen[0][0];
    };
    const display = new Map<string, string>();
    for (const key of counts.keys()) display.set(key, label(key));
    return { counts, display, inFolder: new Set(folderTitle.keys()) };
  }

  /**
   * Whether the vault writes this category as `[[Name]]` or bare `Name`.
   *
   * The vault has a habit per category rather than one rule: Task, Idea and
   * Reference are always bare, Meetings, Projects and People always linked,
   * Entry split 29 to 11. So the form is the one the notes already use most
   * for that name, counted over the raw values; a tie, or a category no note
   * uses yet, is linked exactly when there is a note in `Categories/` for the
   * link to land on.
   */
  categoryPrefersWikilink(key: string, inFolder: Set<string>): boolean {
    let linked = 0, bare = 0;
    for (const note of this.snapshot.notes.values()) {
      const raw = note.frontmatter["categories"];
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        if (typeof item !== "string") continue;
        const names = categoryNames([item]);
        if (!names.length || fold(names[0]) !== key) continue;
        if (item.trim().replace(/^["']/, "").startsWith("[[")) linked++;
        else bare++;
      }
    }
    if (linked !== bare) return linked > bare;
    return inFolder.has(key);
  }

  /* --- writes to app state ------------------------------------------------ */
  //
  // Each of these changes what stands out, never where anything sits, so
  // they all emit a non-structural change.

  createDomain(name: string): string {
    name = name.trim();
    if (!name) throw new Error("A domain needs a name.");
    const id = this.store.createDomain(name);
    this.emit(false);
    return id;
  }

  renameDomain(id: string, name: string): void {
    name = name.trim();
    if (!name) throw new Error("A domain needs a name.");
    this.store.renameDomain(id, name);
    this.emit(false);
  }

  deleteDomain(id: string): void {
    this.store.deleteDomain(id);
    this.emit(false);
  }

  assign(path: string, domainId: string | null): void {
    if (!this.isProject(path)) throw new Error("unknown project");
    this.store.assignProject(domainId, path);
    this.emit(false);
  }

  /**
   * Set a category's shape, its project flag, or both. Each key acts only
   * when given: `{project}` leaves the shape alone and `{shape}` leaves the
   * flag alone, so the two controls in the dialog can fire independently. An
   * explicit `shape: null` clears the shape.
   */
  setDatatype(name: string, patch: { shape?: string | null; project?: boolean }): void {
    name = name.trim();
    if (!name) throw new Error("A datatype needs a category.");
    if ("shape" in patch) {
      if (patch.shape === null || patch.shape === undefined) this.store.clearDatatype(name);
      else this.store.setDatatype(name, patch.shape);
    }
    if (patch.project !== undefined) {
      this.store.setProjectDatatype(name, patch.project);
      // The flag changes who counts as a project; the tree is re-derived
      // from the same snapshot, no rescan needed.
      this.rebuild(false);
      return;
    }
    this.emit(false);
  }

  /**
   * Rule that a note is, or is not, a project — or hand it back. Ruling a
   * note out can leave a project slot holding something the sidebar no
   * longer lists; the slot is cleared rather than left dangling, and the
   * clearing is recorded like any other. Returns the verdict.
   */
  setProjectOverride(path: string, value: boolean | null): { project: boolean; slotCleared: boolean } {
    if (!this.snapshot.notes.has(path)) throw new Error(`no such note: ${path}`);
    this.store.setProjectOverride(path, value);
    this.rebuild(false);
    const project = this.isProject(path);
    let slotCleared = false;
    if (!project && this.store.priorities().projects.includes(path)) {
      this.store.clearSlot("project", path);
      slotCleared = true;
      this.emit(false);
    }
    return { project, slotCleared };
  }

  setSlot(kind: "domain" | "project", key: string, selected: boolean): void {
    if (selected) {
      this.store.fillSlot(kind, key, kind === "domain" ? this.caps.domainSlots : this.caps.projectSlots);
    } else {
      this.store.clearSlot(kind, key);
    }
    this.emit(false);
  }

  /**
   * The dashboard: focus, priority-domain tasks, and the deadline feed.
   *
   * Focus and the domain list carry the user's manual order first and the
   * remainder after it; the deadline feed is the calendar's order and has no
   * manual layer. `today` is the caller's clock — pass `new Date()`; a view
   * that stays open past midnight re-asks.
   */
  tasks(today: Date): TasksModelView {
    const priorities = this.store.priorities();
    const assignments = this.store.assignments();
    const domains = this.store.domains();
    const builder = new RowBuilder(this.snapshot, this.hierarchy, domains, assignments, this.store.datatypes());
    const byId = new Map(domains.map((d) => [d.id, d]));

    const focus: FocusBox[] = [];
    for (const projectPath of priorities.projects) {
      const project = this.snapshot.notes.get(projectPath);
      if (!project) continue;
      const paths = applyOrder(
        exploringTasksUnder(this.snapshot, this.hierarchy, projectPath),
        this.store.taskOrder(`focus:${projectPath}`),
      );
      const [domainId, hue] = builder.hue(projectPath);
      focus.push({
        project: {
          path: projectPath,
          label: project.title,
          hue,
          domainName: domainId !== null ? byId.get(domainId)?.name ?? null : null,
        },
        tasks: paths.map((p) => builder.row(p, today)),
      });
    }

    const members = domainMembers(this.hierarchy, assignments);
    const unordered = domainTaskPaths(this.snapshot, this.hierarchy, members, priorities, today);
    const domainRows = applyOrder(stableShuffle(unordered), this.store.taskOrder("domains"));

    return {
      today: todayIso(today),
      focus,
      domains: domainRows.map((p) => builder.row(p, today)),
      deadlines: deadlinePaths(this.snapshot, today).map((p) => builder.row(p, today)),
    };
  }

  /** Save one dashboard list's manual order. A focus list must belong to a
   *  slotted project; the deadline feed has no manual layer. */
  saveTaskOrder(list: "domains" | `focus:${string}`, paths: string[]): void {
    if (list === "domains") {
      this.store.saveTaskOrder("domains", paths);
      return;
    }
    const projectPath = list.slice("focus:".length);
    if (!this.store.priorities().projects.includes(projectPath)) throw new Error("that project is not in a slot");
    this.store.saveTaskOrder(list, paths);
  }

  /* --- writes to the vault ------------------------------------------------ */

  private requireWriter(): FrontmatterWriter {
    if (!this.writer) throw new Error("ZoomIn cannot write to this vault");
    return this.writer;
  }

  /**
   * Advance a note's status, in the vault itself — and everything under it.
   *
   * The clicked note cycles (or is set, when `status` is given); its whole
   * subtree is then *set* to the result rather than cycled, so a parent and
   * its descendants always land on one status. "Work is explored" with
   * Prepay's children still exploring would be a contradiction, and marking
   * them by hand one at a time was the chore this exists to remove.
   *
   * Each file is written on its own, and the set is not a transaction: a
   * failure part-way leaves the earlier notes changed. The error says how far
   * it got, and a second click finishes the job. Only frontmatter moved, so
   * the notes are patched in memory and the map recolours at once; the
   * vault's own change event follows and confirms it.
   */
  async setStatus(path: string, status: Status | null = null): Promise<{ status: Status; cascaded: number }> {
    const writer = this.requireWriter();
    const note = this.snapshot.notes.get(path);
    if (!note) throw new Error(`no such note: ${path}`);
    if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new Error(`unknown status ${status}`);
    const target = status ?? nextStatus(note.status);
    const paths = [path, ...this.hierarchy.descendants(path)];
    let written = 0;
    try {
      for (const p of paths) {
        await setStatus(writer, p, target);
        this.snapshot.notes.get(p)!.status = target;
        written++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(false);
      throw new Error(`${message} (stopped after ${written} of ${paths.length})`);
    }
    this.emit(false);
    return { status: target, cascaded: written - 1 };
  }

  /** Whether more than one note shares this stem — when only a pathed link lands on the right one. */
  private stemIsAmbiguous(stem: string): boolean {
    let n = 0;
    const key = fold(stem);
    for (const note of this.snapshot.notes.values()) if (fold(note.title) === key && ++n > 1) return true;
    return false;
  }

  /**
   * Set a note's parent, category or deadline, in the vault itself.
   *
   * A parent change moves hierarchy edges, subtree sizes and inherited
   * domains — the structure is genuinely new, so the vault is re-read. A
   * category or deadline moves only frontmatter, so the note is patched in
   * memory the way a status write is. Re-parenting a note under its own
   * descendant is refused rather than written and untangled later.
   */
  async editNote(path: string, field: "parent" | "category" | "deadline", rawValue: string | null): Promise<{ structural: boolean }> {
    const writer = this.requireWriter();
    const note = this.snapshot.notes.get(path);
    if (!note) throw new Error(`no such note: ${path}`);
    const trimmed = rawValue?.trim() ?? "";
    const value: string | null = trimmed || null; // an empty string is a clear, not a value

    if (field === "parent") {
      let target: string | null = null;
      if (value !== null) {
        if (!this.snapshot.notes.has(value)) throw new Error(`no such note: ${value}`);
        // A note above itself, at any distance, is a loop: `Parent:` is
        // hand-written and the walkers are cycle-safe, but the map should
        // not be the thing that writes one.
        if (value === path || this.hierarchy.ancestors(value).includes(path)) {
          throw new Error(`${labelFor(value)} is under ${labelFor(path)}; filing it above would make a loop`);
        }
        const stem = labelFor(value);
        target = this.stemIsAmbiguous(stem) ? value.replace(/\.md$/, "") : stem;
      }
      await setParent(writer, path, target);
      this.reload();
      return { structural: true };
    }

    if (field === "category") {
      let name: string | null = null;
      let wikilink = false;
      if (value !== null) {
        const { display, inFolder } = this.categoryCensus();
        const key = fold(value);
        // A known category takes its established spelling; a new one is
        // written as typed, and bare unless the folder says otherwise.
        name = display.get(key) ?? value;
        wikilink = this.categoryPrefersWikilink(key, inFolder);
      }
      await setCategory(writer, path, name, wikilink);
      note.categories = name ? [name] : [];
      // A category can be a project datatype, so the note may have just
      // become (or stopped being) a project; the tree is re-derived from the
      // patched snapshot without touching the disk.
      this.rebuild(false);
      return { structural: false };
    }

    await setDeadline(writer, path, value);
    note.deadline = value;
    this.emit(false);
    return { structural: false };
  }

  /** The layout settled. Kept in memory so a rebuild seeds from it; the
   *  plugin persists it per device. */
  setPositions(positions: Record<string, [number, number]>): void {
    for (const [id, xy] of Object.entries(positions)) this.positions.set(id, xy);
    this.cached = null;
  }
}

export function labelFor(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** The part of a snapshot the renderer's simulation depends on: which nodes
 *  exist and which links join them. Frontmatter values are not in it. */
function structureKeyOf(snapshot: VaultSnapshot): string {
  const ids = [...snapshot.notes.keys(), ...snapshot.phantoms.keys()].sort();
  const edges = snapshot.edges
    .map((e) => e.source + ">" + e.target + ":" + (e.kind === LinkKind.HIERARCHY ? "h" : "a"))
    .sort();
  return ids.join("\n") + "\n\n" + edges.join("\n");
}
