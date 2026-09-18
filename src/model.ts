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

import { buildPayload } from "./graph/build";
import { Hierarchy, buildHierarchy } from "./graph/hierarchy";
import { Assignments, Datatype, Domain, GraphPayload, LinkKind, Positions, Priorities, VaultSnapshot, fold } from "./types";
import { CacheSource, buildSnapshot } from "./vault/snapshot";

export type ChangeListener = (structural: boolean) => void;

export class ZoomInModel {
  snapshot: VaultSnapshot = { notes: new Map(), edges: [], phantoms: new Map() };
  hierarchy: Hierarchy = new Hierarchy(new Map(), [], new Map());

  // App state. Phase 2 replaces these with the persisted store; until then the
  // map has no domains, no priorities and no shapes, which is exactly what a
  // fresh install looks like.
  domains: Domain[] = [];
  assignments: Assignments = new Map();
  priorities: Priorities = { domains: [], projects: [] };
  datatypes: Datatype[] = [];
  projectOverrides: Map<string, boolean> = new Map();
  positions: Positions = new Map();

  private listeners = new Set<ChangeListener>();
  private structureKey = "";
  private cached: GraphPayload | null = null;

  constructor(private readonly source: CacheSource) {}

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
    const projectCategories = new Set(this.datatypes.filter((d) => d.isProject).map((d) => fold(d.name)));
    const paths = new Set<string>();
    if (!projectCategories.size) return paths;
    for (const [path, note] of this.snapshot.notes) {
      if (note.categories.some((name) => projectCategories.has(fold(name)))) paths.add(path);
    }
    return paths;
  }

  /**
   * Re-read the vault and rebuild everything. Returns whether the structure
   * changed, and tells the listeners the same.
   */
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
   * that step, and `reload()` is a scan followed by it. Precedence is applied
   * here, once: a ruling beats a flag, a flag beats the tree.
   */
  rebuild(structural = false): void {
    const declared = this.flaggedPaths();
    const undeclared = new Set<string>();
    for (const [path, ruling] of this.projectOverrides) {
      if (ruling) declared.add(path);
      else {
        declared.delete(path);
        undeclared.add(path);
      }
    }
    this.hierarchy = buildHierarchy(this.snapshot, declared, undeclared);
    this.emit(structural);
  }

  payload(): GraphPayload {
    if (!this.cached) {
      this.cached = buildPayload(
        this.snapshot,
        this.hierarchy,
        this.domains,
        this.assignments,
        this.priorities,
        this.positions,
        this.datatypes,
      );
    }
    return this.cached;
  }
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
