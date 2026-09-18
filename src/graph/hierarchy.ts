/**
 * Derive the vault's tree, and from it a ranked list of parents.
 *
 * The vault already encodes its own hierarchy: `Parent:` frontmatter is a
 * wikilink to the note above this one. That tree is the backbone we render.
 *
 * A *parent* — a "project", in the sidebar's word — has three sources, and
 * they rank:
 *
 *   1. a per-note ruling by the user: a project regardless, or not one regardless;
 *   2. a datatype flagged as a project kind: every note in that category;
 *   3. the tree itself: a note something else points at.
 *
 * The third is the vault's own statement and the one this module derives.
 * The first two are app state, which keeps this layer pure: `buildHierarchy`
 * never reads the store, it is simply handed the set of paths the store
 * *declares* and the set it *undeclares*, already reconciled by the caller
 * under the precedence above. A declared note joins the tree even with
 * nothing under it; an undeclared one stays in the tree (its children still
 * resolve their ancestors through it) but is never offered.
 *
 * What the tree does *not* give us is domains. The root `Personal Projects`
 * is a junk drawer holding six unrelated things, while `Work` is a genuine
 * grouping at the same depth; no depth rule separates them. So the tree
 * yields *parents* only, and domains are created by the user in app state —
 * they are not notes, and nothing here knows about them (design.md §4).
 */

import { LinkKind, VaultSnapshot } from "../types";

/** Template scaffolding that would otherwise look like a large root. */
export const EXCLUDED_TITLES = new Set(["Project Template"]);

export interface TreeNode {
  path: string;
  title: string;
  parent: string | null;
  children: string[];
  subtreeSize: number;
  depth: number;
  /** Offered as a parent by app state, whether or not anything hangs off it. */
  declared: boolean;
}

export class Hierarchy {
  constructor(
    public readonly nodes: Map<string, TreeNode>,
    public readonly roots: string[],
    /** every note carrying a `Parent:` */
    public readonly parentOf: Map<string, string>,
    /** Ruled out by app state. Still tree members, never offered. */
    public readonly undeclared: Set<string> = new Set(),
  ) {}

  /** Walk up the `Parent:` chain. Cycle-safe. */
  ancestors(path: string): string[] {
    const chain: string[] = [];
    const seen = new Set([path]);
    let current = this.parentOf.get(path);
    while (current !== undefined && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = this.parentOf.get(current);
    }
    return chain;
  }

  /**
   * Every note whose `Parent:` chain reaches `path`, nearest first.
   *
   * Cycle-safe: `Parent:` is hand-written and a loop is one typo away, so
   * the walk refuses to visit a note twice rather than trusting the vault.
   */
  descendants(path: string): string[] {
    const children = new Map<string, string[]>();
    for (const [child, parent] of this.parentOf) {
      const list = children.get(parent);
      if (list) list.push(child);
      else children.set(parent, [child]);
    }
    const found: string[] = [];
    const queue = [path];
    const seen = new Set([path]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const child of (children.get(current) ?? []).slice().sort()) {
        if (!seen.has(child)) {
          seen.add(child);
          found.push(child);
          queue.push(child);
        }
      }
    }
    return found;
  }

  /**
   * Every note something else hangs off, or that app state declares one,
   * best first — minus anything app state has ruled out.
   *
   * These are what the user assigns to a domain; the ranking only decides
   * what to offer first, never what to group.
   */
  parents(): TreeNode[] {
    const found: TreeNode[] = [];
    for (const node of this.nodes.values()) {
      if (EXCLUDED_TITLES.has(node.title)) continue;
      if (!(node.children.length || node.declared)) continue;
      if (this.undeclared.has(node.path)) continue;
      found.push(node);
    }
    found.sort(
      (a, b) =>
        b.subtreeSize - a.subtreeSize ||
        b.children.length - a.children.length ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    );
    return found;
  }

  /**
   * For every offered parent: [nearest offered ancestor, depth], both measured
   * in the forest of *offered* parents rather than the raw tree, so the
   * sidebar's indentation and its parent pointer can never disagree.
   */
  lineage(): Map<string, [string | null, number]> {
    const offered = new Set(this.parents().map((n) => n.path));
    const lineage = new Map<string, [string | null, number]>();
    for (const path of offered) {
      const chain = this.ancestors(path).filter((a) => offered.has(a));
      lineage.set(path, [chain.length ? chain[0] : null, chain.length]);
    }
    return lineage;
  }
}

/**
 * The `Parent:` tree, with app state's rulings laid over it.
 *
 * `declared` paths are offered as parents even when childless; `undeclared`
 * paths are never offered even with children. The caller has already applied
 * the precedence between the user's per-note ruling and the datatype flag,
 * so the two sets arrive disjoint and this function does not rank them.
 */
export function buildHierarchy(
  snapshot: VaultSnapshot,
  declared: Iterable<string> = [],
  undeclared: Iterable<string> = [],
): Hierarchy {
  const declaredSet = new Set<string>();
  for (const path of declared) if (snapshot.notes.has(path)) declaredSet.add(path);
  const undeclaredSet = new Set(undeclared);

  const parentOf = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind === LinkKind.HIERARCHY && snapshot.notes.has(edge.target) && !parentOf.has(edge.source)) {
      parentOf.set(edge.source, edge.target);
    }
  }

  // The tree covers notes that have a parent, plus every note named as one —
  // and every note app state declares a parent, which may be neither.
  const members = new Set<string>();
  for (const [child, parent] of parentOf) {
    if (snapshot.notes.has(child)) members.add(child);
    if (snapshot.notes.has(parent)) members.add(parent);
  }
  for (const path of declaredSet) members.add(path);

  const nodes = new Map<string, TreeNode>();
  for (const path of members) {
    nodes.set(path, {
      path,
      title: snapshot.notes.get(path)!.title,
      parent: parentOf.get(path) ?? null,
      children: [],
      subtreeSize: 0,
      depth: 0,
      declared: declaredSet.has(path),
    });
  }
  for (const [path, node] of nodes) {
    if (node.parent !== null && nodes.has(node.parent)) nodes.get(node.parent)!.children.push(path);
  }
  for (const node of nodes.values()) node.children.sort();

  const roots = [...nodes.entries()]
    .filter(([, n]) => n.parent === null || !nodes.has(n.parent))
    .map(([p]) => p)
    .sort();

  // Subtree size counts every note whose `Parent:` chain reaches this node,
  // including the many leaf notes that never appear in the tree themselves.
  const descendants = new Map<string, number>();
  for (const path of snapshot.notes.keys()) {
    const seen = new Set([path]);
    let current = parentOf.get(path);
    while (current !== undefined && !seen.has(current)) {
      descendants.set(current, (descendants.get(current) ?? 0) + 1);
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  for (const [path, node] of nodes) node.subtreeSize = descendants.get(path) ?? 0;

  const setDepth = (path: string, depth: number, seen: Set<string>) => {
    nodes.get(path)!.depth = depth;
    for (const child of nodes.get(path)!.children) {
      if (!seen.has(child)) setDepth(child, depth + 1, new Set([...seen, child]));
    }
  };
  for (const root of roots) setDepth(root, 0, new Set([root]));

  return new Hierarchy(nodes, roots, parentOf, undeclaredSet);
}
