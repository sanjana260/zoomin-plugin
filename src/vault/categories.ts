/**
 * Readers for the frontmatter fields ZoomIn cares about. Port of the relevant
 * half of `vault/parse.py`; the link and body parsing that made up the other
 * half is Obsidian's job now (see `snapshot.ts`).
 *
 * Every reader takes the raw value out of Obsidian's frontmatter cache and
 * never throws: these fields are hand-typed, and a map that refused to load
 * over one typo would be worse than one that quietly skipped it.
 */

import { STATUSES, Status, nfc } from "../types";

const WIKILINK = /^!?\[\[([^[\]]+?)\]\]$/;

/**
 * Reduce the inside of a wikilink to its bare target path.
 *
 * Handles `Note|Alias`, `Note#Heading`, `Note#^blockid`, `folder/Note`, and the
 * `\|` pipe escape used inside markdown tables. Returns null for same-note
 * fragments like `[[#Heading]]`, which are not edges.
 */
export function linkTarget(inner: string): string | null {
  let target = inner.replace(/\\\|/g, "|");
  target = target.split("|", 1)[0];
  target = target.split("#", 1)[0];
  target = target.trim();
  return target || null;
}

/** Wikilink targets out of a frontmatter value: `"[[Work]]"`, a list of those, or nothing. */
export function frontmatterLinks(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const targets: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const re = /!?\[\[([^[\]]+?)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(item)) !== null) {
      const target = linkTarget(match[1]);
      if (target) targets.push(target);
    }
  }
  return targets;
}

/**
 * Names out of a `categories:` frontmatter value.
 *
 * Written two ways in the same vault: bare (`categories: [Task]`) or as a
 * wikilink to a note in `Categories/` (`categories: ["[[Projects]]"]`). On the
 * reference vault that is 184 bare against 54 linked, so both have to work and
 * neither can be treated as the canonical form.
 *
 * Deliberately NOT turned into edges. 113 notes carry the value `Task`, and an
 * edge per note would build exactly the false hub that excluding non-`.md`
 * embed targets was meant to avoid — with the added twist that `Task` has no
 * note to point at, so it would be a phantom hub joining a third of the vault.
 * A category is a property of a note, not a link between notes.
 */
export function categoryNames(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    let name = item.trim();
    // YAML's quotes are syntax and the cache strips them; a pair that survives
    // (a value typed with literal quotes) is not part of the name either.
    name = name.replace(/^(["'])(.*)\1$/, "$2").trim();
    if (!name) continue;
    // A wikilinked value carries the same name as a bare one, so reduce to
    // the target and let the two spellings land on one category.
    const match = WIKILINK.exec(name);
    if (match) {
      const target = linkTarget(match[1]);
      if (!target) continue;
      // `Categories/Projects` and `Projects` are the same category.
      name = target.split("/").pop() ?? target;
    }
    name = nfc(name);
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * Normalise a `status:` value to one of STATUSES, or null.
 *
 * The vault writes these capitalised. A handful of notes carry something else:
 * some parse as YAML booleans because they were written `yes`/`no`, and two say
 * `Unexplored - Unexplored`, which is a typo with an obvious intent — the
 * leading word is taken rather than throwing the note away. Anything
 * unrecognised is null, and null renders exactly as a note with no status at
 * all; 92 of 314 notes have no usable status, and giving them a look of their
 * own would restyle a third of the map for a property their author never set.
 */
export function noteStatus(value: unknown): Status | null {
  if (Array.isArray(value)) value = value.length ? value[0] : null;
  if (typeof value !== "string") return null; // a missing key, an empty value, the booleans
  const text = nfc(value).trim().toLowerCase();
  if ((STATUSES as readonly string[]).includes(text)) return text as Status;
  const head = text.split(/[^\p{L}\p{N}_]+/u, 1)[0];
  return (STATUSES as readonly string[]).includes(head) ? (head as Status) : null;
}

/**
 * A `deadline:` value as an ISO date string, or null.
 *
 * Obsidian's frontmatter cache leaves dates as strings, so `2026-09-16` arrives
 * as written; a Date object is handled in case a future cache types them.
 * Anything else — a word, an empty value, a list — is no deadline.
 */
export function noteDeadline(value: unknown): string | null {
  if (Array.isArray(value)) value = value.length ? value[0] : null;
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return text;
}

/** `Description:` is capital-D on 128 notes and lowercase on 4 — read both. */
export function noteDescription(frontmatter: Record<string, unknown>): string | null {
  for (const key of ["Description", "description"]) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
