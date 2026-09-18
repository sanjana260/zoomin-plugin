/**
 * Compose the task dashboard: what to do next, as three lists.
 *
 * Pure functions over a snapshot, kept out of the views the same way
 * `build.ts` and `hierarchy.ts` are, so the composition rules can be tested
 * without a view.
 *
 * A *task* is a note filed under `categories: Task`. Nothing else is a to-do,
 * however much it is exploring: an Entry or an Idea is something you wrote,
 * not something you can check off. On the reference vault that is 119 notes.
 */

import { DOMAIN_HUES, Member, effectiveDomain, shapeIndex, shapeOf } from "./build";
import { Hierarchy } from "./hierarchy";
import { fnv1a } from "./layout";
import { Assignments, Datatype, Domain, Priorities, VaultSnapshot, fold } from "../types";

const TASK_CATEGORY = "task";

// Deadline tiers, in days from today. A day out or overdue is red and goes to
// the top; a week out is yellow; beyond that grey, present but not asking for
// anything yet.
export const RED_WITHIN = 1;
export const YELLOW_WITHIN = 7;

export interface TaskRow {
  path: string;
  label: string;
  status: string | null;
  shape: string | null;
  hue: number | null;
  domainId: string | null;
  projectLabel: string | null;
  deadline: string | null;
  /** days from `today`; negative is overdue */
  days: number | null;
  tier: string | null;
}

export function isTask(categories: string[]): boolean {
  return categories.some((name) => fold(name) === TASK_CATEGORY);
}

export function tier(days: number): string {
  if (days <= RED_WITHIN) return "red";
  if (days <= YELLOW_WITHIN) return "yellow";
  return "grey";
}

/** A date string as `YYYY-MM-DD`, or null. */
export function todayIso(today: Date): string {
  const y = today.getFullYear(), m = String(today.getMonth() + 1).padStart(2, "0"), d = String(today.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Days from `today` to a deadline date string, in the viewer's clock. */
export function daysUntil(deadline: string, today: Date): number {
  const [y, m, d] = deadline.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
}

/**
 * True when the note's deadline would light up (red or yellow) in the feed.
 * Defined through `tier()` rather than a comparison of its own so the
 * deadline feed and anything that defers to it can never disagree about where
 * "near" ends: it is YELLOW_WITHIN, overdue included.
 */
export function nearDeadline(deadline: string | null, today: Date): boolean {
  return deadline !== null && tier(daysUntil(deadline, today)) !== "grey";
}

export class RowBuilder {
  private domainIndex = new Map<string, number>();
  private datatypeIndex: Map<string, number>;
  // The nearest ancestor that is itself offered as a parent is what the
  // sidebar would call this note's project. Resolved once, not per row.
  private offered: Set<string>;

  constructor(
    private readonly snapshot: VaultSnapshot,
    private readonly hierarchy: Hierarchy,
    domains: Domain[],
    private readonly assignments: Assignments,
    private readonly datatypes: Datatype[],
  ) {
    domains.forEach((d, i) => this.domainIndex.set(d.id, i));
    this.datatypeIndex = shapeIndex(datatypes);
    this.offered = new Set(hierarchy.parents().map((n) => n.path));
  }

  hue(path: string): [string | null, number | null] {
    const domainId = effectiveDomain(this.hierarchy, this.assignments, path).domainId;
    const index = domainId !== null ? this.domainIndex.get(domainId) : undefined;
    if (domainId === null || index === undefined) return [null, null];
    return [domainId, DOMAIN_HUES[index % DOMAIN_HUES.length]];
  }

  projectLabel(path: string): string | null {
    for (const ancestor of this.hierarchy.ancestors(path)) {
      if (this.offered.has(ancestor)) return this.snapshot.notes.get(ancestor)!.title;
    }
    return null;
  }

  row(path: string, today: Date | null = null): TaskRow {
    const note = this.snapshot.notes.get(path)!;
    const [domainId, hue] = this.hue(path);
    const index = shapeOf(note.categories, this.datatypeIndex);
    let days: number | null = null, tierName: string | null = null;
    if (note.deadline !== null && today !== null) {
      days = daysUntil(note.deadline, today);
      tierName = tier(days);
    }
    return {
      path,
      label: note.title,
      status: note.status,
      shape: index >= 0 ? this.datatypes[index].shape : null,
      hue,
      domainId,
      projectLabel: this.projectLabel(path),
      deadline: note.deadline,
      days,
      tier: tierName,
    };
  }
}

/** Task paths in `root`'s subtree that are currently exploring, sorted by title. */
export function exploringTasksUnder(snapshot: VaultSnapshot, hierarchy: Hierarchy, root: string): string[] {
  const found: string[] = [];
  for (const path of hierarchy.descendants(root)) {
    const note = snapshot.notes.get(path);
    if (note && note.status === "exploring" && isTask(note.categories)) found.push(path);
  }
  found.sort((a, b) => {
    const ta = snapshot.notes.get(a)!.title.toLowerCase(), tb = snapshot.notes.get(b)!.title.toLowerCase();
    return ta.localeCompare(tb);
  });
  return found;
}

/**
 * Exploring tasks anywhere under a priority domain's projects, deduplicated.
 *
 * A project sits in one domain, so two domains' subtrees cannot overlap — but
 * a project and its own subproject can both be members of the same domain,
 * which would list the subproject's tasks twice without the set.
 *
 * A task whose deadline is near is left out: it is already shouting from the
 * deadline feed in red or yellow, and listing it again under its domain is
 * the same information twice. Grey-tier deadlines and tasks with no deadline
 * stay. The boundary is deliberately the feed's own yellow tier
 * (`nearDeadline`), not a second constant.
 */
export function domainTaskPaths(
  snapshot: VaultSnapshot,
  hierarchy: Hierarchy,
  members: Map<string, Member[]>,
  priorities: Priorities,
  today: Date,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const domainId of priorities.domains) {
    for (const member of members.get(domainId) ?? []) {
      for (const path of exploringTasksUnder(snapshot, hierarchy, member.path)) {
        if (seen.has(path)) continue;
        const note = snapshot.notes.get(path)!;
        if (nearDeadline(note.deadline, today)) continue;
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

/**
 * Every task with a deadline that is not yet done, most urgent first.
 *
 * Explored is excluded — a finished task's deadline is moot — but every other
 * status is in, unexplored included: a deadline is exactly the thing that
 * should drag an unstarted task into view.
 */
export function deadlinePaths(snapshot: VaultSnapshot, today: Date): string[] {
  const found: string[] = [];
  for (const [path, note] of snapshot.notes) {
    if (note.deadline !== null && note.status !== "explored" && isTask(note.categories)) found.push(path);
  }
  found.sort((a, b) => {
    const na = snapshot.notes.get(a)!, nb = snapshot.notes.get(b)!;
    return na.deadline!.localeCompare(nb.deadline!) || na.title.toLowerCase().localeCompare(nb.title.toLowerCase());
  });
  return found;
}

/**
 * A random-looking order that is the same every time for the same paths.
 *
 * The user asked for the domain list "in random order", and a list that
 * reshuffled on every visit would fight the manual ordering that sits on top
 * of it. Hashing the path gives a shuffle with no memory and no clock.
 */
export function stableShuffle(paths: string[]): string[] {
  const key = (p: string): [number, number] => {
    const [a, b] = fnv1a(p);
    return [a, b];
  };
  return [...paths].sort((x, y) => {
    const [ax, bx] = key(x), [ay, by] = key(y);
    return ax - ay || bx - by;
  });
}

/**
 * Saved order first, in that order; everything else after, in its given
 * order. A saved path that is no longer in `paths` (done, moved, deleted) is
 * simply absent — the order survives it and nothing has to be repaired.
 */
export function applyOrder(paths: string[], saved: string[]): string[] {
  const present = new Set(paths);
  const ordered = saved.filter((p) => present.has(p));
  const placed = new Set(ordered);
  return [...ordered, ...paths.filter((p) => !placed.has(p))];
}
