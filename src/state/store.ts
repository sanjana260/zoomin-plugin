/**
 * The app's own state: the user's domains, and what occupies a priority slot.
 *
 * Two distinct acts, deliberately:
 *   * creating a domain and filing projects under it — building your map's
 *     vocabulary, which is free and reversible;
 *   * filling a slot with one of them — spending a fixed attention budget,
 *     which costs you the others.
 *
 * Domains live only here. They are named by the user, they are never notes,
 * and nothing in the vault knows about them.
 *
 * Port of `state/priorities.py` with the SQLite taken out: the whole store is
 * one plain object, persisted as the plugin's `data.json` (decision 39 — it
 * lives in the vault's config folder and syncs with it). Notes are keyed by
 * path; a rename in Obsidian arrives as an event and rewrites the keys, which
 * is what the Python app's minted `note_id` was reserved to do one day.
 * The migration ladder becomes a `version` field and `upgrade()`.
 */

import { Assignments, Datatype, Domain, Priorities } from "../types";
import { SHAPES } from "../graph/build";

export const STORE_VERSION = 1;

export interface DomainRecord {
  id: string;
  name: string;
  createdAt: number;
  /** Retired rather than erased — the slot history refers to it. */
  retiredAt: number | null;
}

export interface SlotRecord {
  kind: "domain" | "project";
  /** a domain id for a domain slot, a note path for a project one */
  key: string;
  since: number;
}

export interface SlotHistoryRecord {
  ts: number;
  kind: "domain" | "project";
  action: "fill" | "clear";
  key: string;
}

export interface DatatypeRecord {
  id: string;
  name: string;
  shape: string | null;
  isProject: boolean;
  createdAt: number;
}

export interface StoreData {
  version: number;
  domains: DomainRecord[];
  /** path → domain id, or null for an explicit "unfiled" tombstone */
  assignments: Record<string, string | null>;
  slots: SlotRecord[];
  slotHistory: SlotHistoryRecord[];
  datatypes: DatatypeRecord[];
  /** path → the user's ruling on project-ness; absent = automatic */
  projectOverrides: Record<string, boolean>;
  /** list key → note paths, first to last */
  taskOrder: Record<string, string[]>;
}

export function emptyStore(): StoreData {
  return {
    version: STORE_VERSION,
    domains: [],
    assignments: {},
    slots: [],
    slotHistory: [],
    datatypes: [],
    projectOverrides: {},
    taskOrder: {},
  };
}

/** Bring any older on-disk shape up to the current one. Append-only, like
 *  the migrations it replaces: never edit a step that shipped. */
export function upgrade(raw: unknown): StoreData {
  const data = { ...emptyStore(), ...(raw && typeof raw === "object" ? (raw as Partial<StoreData>) : {}) };
  // version 1 is the first; later versions add their steps here.
  data.version = STORE_VERSION;
  return data;
}

export class SlotFull extends Error {
  constructor(
    public readonly kind: string,
    public readonly cap: number,
  ) {
    super(`all ${cap} ${kind} slots are full`);
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  data: StoreData;
  /**
   * Deciding whether a removal needs a tombstone means knowing whether an
   * ancestor would refile the project, and that tree lives in the vault, not
   * here. The model wires its hierarchy in on every rebuild; with no vault the
   * walk is empty and removals are plain deletes.
   */
  ancestors: (path: string) => string[] = () => [];
  /** Whether a path is a note the vault currently has. Set by the model. */
  knows: (path: string) => boolean = () => true;

  constructor(
    data: StoreData,
    private readonly persist: (data: StoreData) => void,
  ) {
    this.data = data;
  }

  private save(): void {
    this.persist(this.data);
  }

  private liveDomain(id: string): DomainRecord | undefined {
    return this.data.domains.find((d) => d.id === id && d.retiredAt === null);
  }

  /* --- renames ------------------------------------------------------------ */

  /** A note moved. Every path-keyed row follows it. */
  rename(oldPath: string, newPath: string): void {
    let touched = false;
    const move = <T>(table: Record<string, T>) => {
      if (oldPath in table) {
        table[newPath] = table[oldPath];
        delete table[oldPath];
        touched = true;
      }
    };
    move(this.data.assignments);
    move(this.data.projectOverrides);
    for (const slot of this.data.slots) {
      if (slot.kind === "project" && slot.key === oldPath) {
        slot.key = newPath;
        touched = true;
      }
    }
    for (const key of Object.keys(this.data.taskOrder)) {
      const list = this.data.taskOrder[key];
      const i = list.indexOf(oldPath);
      if (i >= 0) {
        list[i] = newPath;
        touched = true;
      }
      // A focus list is keyed by its project's path, too.
      if (key === `focus:${oldPath}`) {
        this.data.taskOrder[`focus:${newPath}`] = list;
        delete this.data.taskOrder[key];
        touched = true;
      }
    }
    if (touched) this.save();
  }

  /* --- domains ------------------------------------------------------------ */

  /** Creation order, which is also hue order: two domains must not swap hues on reload. */
  domains(): Domain[] {
    return this.data.domains
      .filter((d) => d.retiredAt === null)
      .map((d) => ({ id: d.id, name: d.name }));
  }

  createDomain(name: string): string {
    const id = uuid();
    this.data.domains.push({ id, name, createdAt: now(), retiredAt: null });
    this.save();
    return id;
  }

  /** Relabel a domain. Its id is its identity and never moves, so a rename
   *  keeps every assignment and any slot it holds. */
  renameDomain(id: string, name: string): void {
    const domain = this.liveDomain(id);
    if (!domain) throw new Error("unknown domain");
    domain.name = name;
    this.save();
  }

  /**
   * Retire a domain: free its slot, and set its projects loose.
   *
   * Both kinds of row go: the explicit assignments naming this domain, and
   * the tombstones that were only there to block inheritance *from* it. A
   * tombstone whose reason has been deleted is just litter — and it would
   * keep a project out of a domain nothing files it into any more.
   */
  deleteDomain(id: string): void {
    this.clearSlot("domain", id); // a deleted domain cannot hold one
    const assignments = this.assignments();
    const stale: string[] = [];
    for (const [path, owner] of assignments) {
      if (owner === null && this.inherited(path, assignments) === id) stale.push(path);
    }
    for (const [path, owner] of Object.entries(this.data.assignments)) {
      if (owner === id) delete this.data.assignments[path];
    }
    for (const path of stale) delete this.data.assignments[path];
    const domain = this.liveDomain(id);
    if (domain) domain.retiredAt = now();
    this.save();
  }

  /* --- datatypes ---------------------------------------------------------- */
  //
  // A row holds two independent opinions about one category: the shape its
  // notes are drawn with, and whether its notes are projects. Either one
  // justifies the row's existence, so setting or clearing one must never
  // disturb the other.

  datatypes(): Datatype[] {
    return this.data.datatypes.map((d) => ({ id: d.id, name: d.name, shape: d.shape, isProject: d.isProject }));
  }

  private datatypeRow(name: string): DatatypeRecord | undefined {
    const key = name.toLowerCase();
    return this.data.datatypes.find((d) => d.name.toLowerCase() === key);
  }

  private upsertDatatype(name: string, patch: Partial<Pick<DatatypeRecord, "shape" | "isProject">>): DatatypeRecord {
    let row = this.datatypeRow(name);
    if (!row) {
      row = { id: uuid(), name, shape: null, isProject: false, createdAt: now() };
      this.data.datatypes.push(row);
    }
    Object.assign(row, patch);
    return row;
  }

  /** Delete the category's row if it holds neither opinion any more. Returns whether a row survives. */
  private sweepDatatype(name: string): boolean {
    const row = this.datatypeRow(name);
    if (row && row.shape === null && !row.isProject) {
      this.data.datatypes.splice(this.data.datatypes.indexOf(row), 1);
      return false;
    }
    return !!row;
  }

  /** Give a category a shape, creating or updating as needed. */
  setDatatype(name: string, shape: string): string {
    if (!(SHAPES as readonly string[]).includes(shape)) throw new Error(`unknown shape ${shape}`);
    const row = this.upsertDatatype(name, { shape });
    this.save();
    return row.id;
  }

  /**
   * Declare (or undeclare) that every note in a category is a project. A
   * category can be flagged before it has a shape, so the row is created
   * shapeless when it has to be; unflagging sweeps the row when nothing else
   * holds it.
   */
  setProjectDatatype(name: string, flag: boolean): string | null {
    if (!flag && !this.datatypeRow(name)) return null; // nothing to unflag, and no reason to mint a row
    const row = this.upsertDatatype(name, { isProject: flag });
    const survives = this.sweepDatatype(name);
    this.save();
    return survives ? row.id : null;
  }

  /** Drop a category's shape. Idempotent; the row goes only when nothing else holds it. */
  clearDatatype(name: string): void {
    const row = this.datatypeRow(name);
    if (row) row.shape = null;
    this.sweepDatatype(name);
    this.save();
  }

  /* --- project overrides -------------------------------------------------- */

  projectOverrides(): Map<string, boolean> {
    return new Map(Object.entries(this.data.projectOverrides));
  }

  /** Rule on a note's project-ness, or with null hand it back to the automatic sources. */
  setProjectOverride(path: string, value: boolean | null): void {
    if (!this.knows(path)) throw new Error(`no such note: ${path}`);
    if (value === null) delete this.data.projectOverrides[path];
    else this.data.projectOverrides[path] = value;
    this.save();
  }

  /* --- assignments -------------------------------------------------------- */

  /**
   * File a project under a domain, or remove it when `domainId` is null.
   *
   * A project belongs to at most one domain, so assigning it again moves it.
   * Removal is the interesting half. Subprojects inherit their parent's
   * domain, so deleting the row is only honest when nothing above would
   * refile the project; when something would, we write an explicit null
   * instead. Unchecking a project in a domain's dialog has to mean it is out
   * of that domain, whatever its ancestors say.
   */
  assignProject(domainId: string | null, path: string): void {
    if (!this.knows(path)) throw new Error(`no such note: ${path}`);
    if (domainId !== null && !this.liveDomain(domainId)) throw new Error("unknown domain");
    if (domainId === null) {
      delete this.data.assignments[path];
      // Read the world as it is *after* the removal: what this project would
      // inherit if we left the table alone.
      if (this.inherited(path, this.assignments()) !== null) this.data.assignments[path] = null;
    } else {
      this.data.assignments[path] = domainId;
    }
    this.save();
  }

  /**
   * path → domain id for every explicit row; null means *explicitly unfiled*,
   * which is not the same as having no row at all. Rows naming a retired
   * domain are dropped rather than reported.
   */
  assignments(): Assignments {
    const live = new Set(this.domains().map((d) => d.id));
    const out: Assignments = new Map();
    for (const [path, owner] of Object.entries(this.data.assignments)) {
      if (owner === null || live.has(owner)) out.set(path, owner);
    }
    return out;
  }

  /** What `path` would take from above it, ignoring its own row. An ancestor's
   *  explicit null answers "nothing" — inheritance stops there. */
  private inherited(path: string, assignments: Assignments): string | null {
    for (const ancestor of this.ancestors(path)) {
      if (assignments.has(ancestor)) return assignments.get(ancestor)!;
    }
    return null;
  }

  /* --- slots -------------------------------------------------------------- */

  priorities(): Priorities {
    const ordered = [...this.data.slots].sort((a, b) => a.since - b.since);
    return {
      domains: ordered.filter((s) => s.kind === "domain").map((s) => s.key),
      projects: ordered.filter((s) => s.kind === "project").map((s) => s.key),
    };
  }

  /** `key` is a domain id for a domain slot, a note path for a project one. */
  fillSlot(kind: "domain" | "project", key: string, cap: number): void {
    if (kind === "domain" ? !this.liveDomain(key) : !this.knows(key)) throw new Error(`unknown ${kind}`);
    if (this.data.slots.some((s) => s.kind === kind && s.key === key)) return;
    if (this.data.slots.filter((s) => s.kind === kind).length >= cap) throw new SlotFull(kind, cap);
    const ts = now();
    this.data.slots.push({ kind, key, since: ts });
    this.record(ts, kind, "fill", key);
    this.save();
  }

  clearSlot(kind: "domain" | "project", key: string): void {
    const before = this.data.slots.length;
    this.data.slots = this.data.slots.filter((s) => !(s.kind === kind && s.key === key));
    if (this.data.slots.length !== before) {
      this.record(now(), kind, "clear", key);
      this.save();
    }
  }

  private record(ts: number, kind: "domain" | "project", action: "fill" | "clear", key: string): void {
    this.data.slotHistory.push({ ts, kind, action, key });
  }

  /* --- task order --------------------------------------------------------- */

  taskOrder(listKey: string): string[] {
    return [...(this.data.taskOrder[listKey] ?? [])];
  }

  /** Replace one list's order wholesale. A path the vault does not know is
   *  skipped rather than refused. */
  saveTaskOrder(listKey: string, paths: string[]): void {
    this.data.taskOrder[listKey] = paths.filter((p) => this.knows(p));
    this.save();
  }
}
