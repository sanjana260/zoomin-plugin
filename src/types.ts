/**
 * Core data types. Ports of `vault/model.py` and the dataclasses in
 * `graph/build.py`; nothing here touches Obsidian.
 */

/** NFC-normalise. Obsidian keys its cache by NFC paths, but link text typed by
 *  hand and names from app state can arrive either way. */
export function nfc(text: string): string {
  return text.normalize("NFC");
}

/** Case-fold for lookup. Obsidian's link resolution is case-insensitive. */
export function fold(text: string): string {
  return nfc(text).toLowerCase();
}

export const enum LinkKind {
  /** body wikilink, `.md` embed, or markdown link */
  ASSOCIATIVE = 0,
  /** `Parent:` frontmatter → the note above this one */
  HIERARCHY = 1,
}

export const STATUSES = ["unexplored", "exploring", "explored"] as const;
export type Status = (typeof STATUSES)[number];

export interface Note {
  /** vault-relative POSIX path, NFC */
  path: string;
  /** filename stem */
  title: string;
  frontmatter: Record<string, unknown>;
  /** `categories:` names, NFC, deduplicated case-insensitively */
  categories: string[];
  status: Status | null;
  /** `deadline:` as an ISO date `YYYY-MM-DD`, or null */
  deadline: string | null;
  /** the `Parent:` link target as written (bare stem or path), or null */
  parentLink: string | null;
  /** `Description:` / `description:` — read both, never written */
  description: string | null;
}

export interface Edge {
  /** note path */
  source: string;
  /** note path, or `phantom:<folded target>` */
  target: string;
  kind: LinkKind;
}

export const PHANTOM_PREFIX = "phantom:";

export interface VaultSnapshot {
  /** keyed by path */
  notes: Map<string, Note>;
  edges: Edge[];
  /** phantom id → display label */
  phantoms: Map<string, string>;
}

/** A user-created grouping. Its id is minted once and never changes. */
export interface Domain {
  id: string;
  name: string;
}

/**
 * A category the user gave a shape to, or declared a kind of project.
 *
 * `name` is the `categories:` value as the vault writes it; matching is
 * case-folded. `shape` is null for a category that carries only the project
 * flag: the two are independent opinions about one category, and a row exists
 * as long as either is held. A shapeless datatype never wins a note's shape.
 */
export interface Datatype {
  id: string;
  name: string;
  shape: string | null;
  isProject: boolean;
}

export interface Priorities {
  /** domain ids */
  domains: string[];
  /** note paths */
  projects: string[];
}

export function anyPriority(p: Priorities): boolean {
  return p.domains.length > 0 || p.projects.length > 0;
}

/** Assignments: path → domain id, or null for an explicit "unfiled" tombstone. */
export type Assignments = Map<string, string | null>;

export type Positions = Map<string, [number, number]>;

// Focus levels. Nothing is ever hidden; these drive chroma and opacity only.
export const SUPPRESSED = 0;
export const NORMAL = 1;
export const PRIORITY = 2;

export const NODE = 0;
export const PHANTOM = 1;

// Status, from the `status:` frontmatter field. NONE is its own level rather
// than a synonym for unexplored: a third of the vault never sets the field, and
// inventing a status for those notes would restyle them on a claim their author
// never made.
export const NO_STATUS = 0;
export const UNEXPLORED = 1;
export const EXPLORING = 2;
export const EXPLORED = 3;

export const STATUS_LEVEL: Record<Status, number> = {
  unexplored: UNEXPLORED,
  exploring: EXPLORING,
  explored: EXPLORED,
};

/** The graph payload: struct-of-arrays with integer link indices, so the
 *  renderer does no string work per frame. */
export interface GraphPayload {
  nodes: {
    id: string[];
    label: string[];
    kind: number[];
    size: number[];
    x: number[];
    y: number[];
    domain: number[];
    isParent: number[];
    isSlotted: number[];
    focus: number[];
    datatype: number[];
    status: number[];
  };
  links: { source: number[]; target: number[]; kind: number[] };
  domains: { id: string; label: string; hue: number; priority: boolean }[];
  datatypes: { id: string; name: string; shape: string | null; is_project: boolean }[];
}
