/**
 * Assemble the graph payload handed to the renderer.
 *
 * Struct-of-arrays with integer link indices: the renderer does no string work
 * per frame, and the shape maps directly onto a typed-array renderer if we ever
 * outgrow force-graph.
 *
 * A domain is a user-made grouping of projects, not a note, so it has no node
 * here. It reaches the graph only as a colour: every note carries the index of
 * the domain that owns it, and `domains` carries the hue.
 */

import {
  Assignments,
  Datatype,
  Domain,
  GraphPayload,
  LinkKind,
  NODE,
  NORMAL,
  NO_STATUS,
  PHANTOM,
  PRIORITY,
  Positions,
  Priorities,
  STATUS_LEVEL,
  SUPPRESSED,
  VaultSnapshot,
  anyPriority,
  fold,
} from "../types";
import { Hierarchy } from "./hierarchy";
import { seedPosition } from "./layout";

// Hues by domain creation order. The slot design tops out around 6-8
// distinguishable domains, which is also where categorical colour stops being
// readable — and seven is already at the ceiling of what one hue circle holds.
//
// Spaced by measuring, not by hsl degrees: hsl hue is far from perceptually
// uniform (a 20-degree step in the blues reads as nothing, the same step in the
// yellows is a different colour). Each hue was placed to maximise the smallest
// OKLCH hue gap among the first seven, holding every domain inside its colour
// family so a user who knows "School is blue" still does. Result: the tightest
// pair went from 35 degrees (orange/gold) and 37 (blue/cyan) to 48-49 across
// the board; the best a full circle can do for seven is ~51. The eighth sits in
// the widest remaining gap, 30 degrees from the sixth. If hue alone stops being
// enough, the next channel is a per-domain lightness offset, not more hues.
// (Decision 29.)
export const DOMAIN_HUES = [204, 20, 121, 256, 48, 321, 178, 351];

// Shape vocabulary, ordered loosely by how quickly each reads. Every one has to
// survive being drawn a few pixels across, so the test for admitting a shape is
// its silhouette, not its detail: an octagon is a circle at this size and earns
// nothing.
export const SHAPES = [
  "circle",
  "square",
  "diamond",
  "triangle",
  "triangle-down",
  "pentagon",
  "hexagon",
  "star",
  "cross",
] as const;

/**
 * folded category name → index into `datatypes`, for the shaped ones only.
 *
 * The one place a datatype list becomes a shape lookup, so every caller agrees
 * on what counts. A row that is only a project flag has no shape to give and
 * is left out: otherwise `Projects` flagged but shapeless would win a note's
 * shape over the `Task` listed after it.
 */
export function shapeIndex(datatypes: Datatype[]): Map<string, number> {
  const index = new Map<string, number>();
  datatypes.forEach((d, i) => {
    if (d.shape !== null && !index.has(fold(d.name))) index.set(fold(d.name), i);
  });
  return index;
}

/**
 * Index into the datatype list for a note, or -1 for none. A note can carry
 * several categories; the first one with a datatype wins, in the note's own
 * order — the vault wrote that order, and picking by it is at least explicable.
 */
export function shapeOf(categories: string[], byCategory: Map<string, number>): number {
  for (const name of categories) {
    const index = byCategory.get(fold(name));
    if (index !== undefined) return index;
  }
  return -1;
}

/**
 * Which domain a path effectively belongs to, and where that came from.
 * `inherited` is only ever true alongside a domain.
 */
export interface Membership {
  domainId: string | null;
  inherited: boolean;
}

export const UNFILED: Membership = { domainId: null, inherited: false };

/** One project inside a domain, and whether it got there by inheritance. */
export interface Member {
  path: string;
  inherited: boolean;
}

/**
 * The domain a path belongs to, explicit rows first, then inheritance.
 *
 * One rule serves both the sidebar and the graph's colouring, so the two can
 * never disagree about who is in what:
 *
 *   1. an explicit row wins, including an explicit null — that is the user
 *      saying "deliberately not filed", and the walk stops there rather than
 *      falling through to an ancestor;
 *   2. otherwise the nearest `Parent:` ancestor carrying a row answers;
 *   3. otherwise nothing.
 */
export function effectiveDomain(hierarchy: Hierarchy, assignments: Assignments, path: string): Membership {
  if (assignments.has(path)) return { domainId: assignments.get(path)!, inherited: false };
  for (const ancestor of hierarchy.ancestors(path)) {
    if (assignments.has(ancestor)) {
      const domainId = assignments.get(ancestor)!;
      return { domainId, inherited: domainId !== null };
    }
  }
  return UNFILED;
}

/**
 * domain id → the projects in it, inherited ones included. Ordered depth-first
 * through the project tree, so a parent always precedes the children that
 * inherit from it and the sidebar can indent them.
 */
export function domainMembers(hierarchy: Hierarchy, assignments: Assignments): Map<string, Member[]> {
  const rank = new Map<string, number>();
  hierarchy.parents().forEach((node, i) => rank.set(node.path, i));
  const unranked = rank.size;

  // A parent's key is a prefix of its children's, so lexicographic order is
  // pre-order and a parent can never sort below its own child.
  const treeKey = (path: string): [number, string][] => {
    const chain = [...hierarchy.ancestors(path).reverse(), path];
    return chain.map((p) => [rank.get(p) ?? unranked, p]);
  };
  const compare = (a: Member, b: Member): number => {
    const ka = treeKey(a.path), kb = treeKey(b.path);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i][0] !== kb[i][0]) return ka[i][0] - kb[i][0];
      if (ka[i][1] !== kb[i][1]) return ka[i][1] < kb[i][1] ? -1 : 1;
    }
    return ka.length - kb.length;
  };

  const members = new Map<string, Member[]>();
  // Assignments can name a project the vault no longer offers — a note renamed
  // outside Obsidian — and losing it here would hide the filing rather than let
  // the user undo it.
  const paths = [...new Set([...rank.keys(), ...assignments.keys()])].sort();
  for (const path of paths) {
    const membership = effectiveDomain(hierarchy, assignments, path);
    if (membership.domainId !== null) {
      const list = members.get(membership.domainId) ?? [];
      list.push({ path, inherited: membership.inherited });
      members.set(membership.domainId, list);
    }
  }
  for (const entries of members.values()) entries.sort(compare);
  return members;
}

/** Every note whose `Parent:` chain reaches one of `roots`. */
function subtree(hierarchy: Hierarchy, roots: string[], notes: Iterable<string>): Set<string> {
  const wanted = new Set(roots);
  if (!wanted.size) return new Set();
  const members = new Set(wanted);
  for (const path of notes) {
    if (members.has(path)) continue;
    if (hierarchy.ancestors(path).some((a) => wanted.has(a))) members.add(path);
  }
  return members;
}

/**
 * Per-note focus level, from each note's effective domain.
 *
 * Before any priority is chosen there is nothing to suppress, so the whole
 * graph reads as normal. After that, everything outside a priority region is
 * the cost of the slot — which is the point of the mechanic.
 *
 * A domain lifts exactly what it owns, tombstones included. A priority
 * *project* still lifts its whole subtree — a project slot names a region of
 * the tree, and says nothing about domains.
 */
export function computeFocus(
  snapshot: VaultSnapshot,
  hierarchy: Hierarchy,
  owners: Map<string, string | null>,
  priorities: Priorities,
): Map<string, number> {
  const focus = new Map<string, number>();
  if (!anyPriority(priorities)) {
    for (const path of snapshot.notes.keys()) focus.set(path, NORMAL);
    return focus;
  }
  for (const path of snapshot.notes.keys()) focus.set(path, SUPPRESSED);
  const priorityDomains = new Set(priorities.domains);
  for (const [path, domainId] of owners) {
    if (domainId !== null && priorityDomains.has(domainId) && focus.has(path)) focus.set(path, NORMAL);
  }
  // A note can sit inside a priority domain and a priority project at once;
  // the project wins, so it is applied second.
  for (const path of subtree(hierarchy, priorities.projects, snapshot.notes.keys())) focus.set(path, PRIORITY);
  return focus;
}

export function buildPayload(
  snapshot: VaultSnapshot,
  hierarchy: Hierarchy,
  domains: Domain[],
  assignments: Assignments,
  priorities: Priorities,
  positions: Positions = new Map(),
  datatypes: Datatype[] = [],
): GraphPayload {
  const domainIndex = new Map<string, number>();
  domains.forEach((d, i) => domainIndex.set(d.id, i));
  const datatypeIndex = shapeIndex(datatypes);
  // Every note's colour comes from the same walk the sidebar uses, so the map
  // and the list can never disagree about who belongs to what.
  const ownerOf = new Map<string, string | null>();
  for (const path of snapshot.notes.keys()) ownerOf.set(path, effectiveDomain(hierarchy, assignments, path).domainId);
  const focus = computeFocus(snapshot, hierarchy, ownerOf, priorities);
  const parentPaths = new Set(hierarchy.parents().map((n) => n.path));
  // The note in a project slot is the landmark you navigate by, so the
  // renderer labels it at every zoom.
  const slotted = new Set(priorities.projects);

  const children = new Map<string, number>();
  for (const path of snapshot.notes.keys()) {
    const parent = hierarchy.parentOf.get(path);
    if (parent !== undefined) children.set(parent, (children.get(parent) ?? 0) + 1);
  }

  const ids = [...[...snapshot.notes.keys()].sort(), ...[...snapshot.phantoms.keys()].sort()];
  const order = new Map<string, number>();
  ids.forEach((id, i) => order.set(id, i));

  const nodes: GraphPayload["nodes"] = {
    id: ids, label: [], kind: [], size: [], x: [], y: [], domain: [],
    isParent: [], isSlotted: [], focus: [], datatype: [], status: [],
  };

  for (const nodeId of ids) {
    const phantom = snapshot.phantoms.has(nodeId);
    let label: string, owner: string | null, parent: boolean, datatype: number, status: number;
    if (phantom) {
      label = snapshot.phantoms.get(nodeId)!;
      owner = null;
      parent = false;
      // A phantom has no frontmatter to carry a category or a status, so it
      // keeps the defaults rather than inheriting from whoever wants it.
      datatype = -1;
      status = NO_STATUS;
    } else {
      const note = snapshot.notes.get(nodeId)!;
      label = note.title;
      owner = ownerOf.get(nodeId) ?? null;
      parent = parentPaths.has(nodeId);
      datatype = shapeOf(note.categories, datatypeIndex);
      status = note.status ? STATUS_LEVEL[note.status] : NO_STATUS;
    }
    const [x, y] = positions.get(nodeId) ?? seedPosition(nodeId);
    nodes.label.push(label);
    nodes.kind.push(phantom ? PHANTOM : NODE);
    // Structural only, and deliberately independent of focus: priority is
    // said in colour, so a node must not move or resize when you choose it.
    nodes.size.push(Math.round((1 + Math.sqrt(children.get(nodeId) ?? 0)) * 1000) / 1000);
    nodes.x.push(Math.round(x * 100) / 100);
    nodes.y.push(Math.round(y * 100) / 100);
    nodes.domain.push(owner !== null ? domainIndex.get(owner) ?? -1 : -1);
    nodes.isParent.push(parent ? 1 : 0);
    nodes.isSlotted.push(!phantom && slotted.has(nodeId) ? 1 : 0);
    nodes.focus.push(phantom ? SUPPRESSED : focus.get(nodeId) ?? NORMAL);
    nodes.datatype.push(datatype);
    nodes.status.push(status);
  }

  const links: GraphPayload["links"] = { source: [], target: [], kind: [] };
  for (const edge of snapshot.edges) {
    const source = order.get(edge.source), target = order.get(edge.target);
    if (source === undefined || target === undefined) continue;
    links.source.push(source);
    links.target.push(target);
    links.kind.push(edge.kind);
    // A phantom is an intention; it should be as visible as whoever wants it.
    if (nodes.kind[target] === PHANTOM) nodes.focus[target] = Math.max(nodes.focus[target], nodes.focus[source]);
  }

  const priorityDomains = new Set(priorities.domains);
  return {
    nodes,
    links,
    domains: domains.map((domain, i) => ({
      id: domain.id,
      label: domain.name,
      hue: DOMAIN_HUES[i % DOMAIN_HUES.length],
      priority: priorityDomains.has(domain.id),
    })),
    datatypes: datatypes.map((d) => ({ id: d.id, name: d.name, shape: d.shape, is_project: d.isProject })),
    stats: { notes: snapshot.notes.size, phantoms: snapshot.phantoms.size, links: snapshot.edges.length },
  };
}

export { LinkKind };
