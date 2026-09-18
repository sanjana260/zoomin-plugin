/**
 * The one place ZoomIn writes to the vault.
 *
 * Every other module in this plugin is read-only and stays that way. This
 * one exists because marking a note explored, moving it under a different
 * parent, calling it a task, giving it a date — these are acts of attention
 * management, and making you leave the map to do them defeats the point of
 * the map (design.md §1, decisions 17 and 34).
 *
 * It writes four frontmatter fields, and no others:
 *
 *   * `status:`     — cycled from a node's hover card, ticked on the dashboard;
 *   * `Parent:`     — the note's place in the tree, moved from the dossier;
 *   * `categories:` — what kind of note it is;
 *   * `deadline:`   — the date the dashboard's feed sorts by.
 *
 * How they are written changed with the plugin (decision 40): the Python app
 * spliced one line of the file under a byte-level guarantee; here each field
 * goes through Obsidian's own `processFrontMatter`, which parses the block,
 * takes the new value, and serialises the block back with the same YAML
 * writer the properties editor uses. The guarantee is therefore "an edit
 * indistinguishable from one made in Obsidian's property editor", and the
 * concurrency story is Obsidian's: the write goes through its file layer, so
 * a note open in an editor is updated in place rather than clobbered.
 *
 * What stays ours is the *value*: each field is written in the form the
 * vault was measured to use — `Parent: "[[Stem]]"`, a one-item list under
 * `categories:` (bare or wikilinked by that category's own habit),
 * an ISO date, a capitalised status — and clearing sets the key to null,
 * which is what the vault's own empties look like (`Parent:` with nothing
 * after it) rather than deleting the line.
 */

import type { App } from "obsidian";
import { STATUSES, Status } from "../types";

/** The four keys, spelled as the vault spells them. Nothing else is ever written. */
export const WRITABLE_KEYS = ["status", "Parent", "categories", "deadline"] as const;

export type Frontmatter = Record<string, unknown>;

/** What the writer needs from Obsidian: read-modify-write of one note's frontmatter. */
export interface FrontmatterWriter {
  process(path: string, edit: (frontmatter: Frontmatter) => void): Promise<void>;
}

export function appWriter(app: App): FrontmatterWriter {
  return {
    async process(path, edit) {
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error(`no such note: ${path}`);
      await app.fileManager.processFrontMatter(file, (frontmatter: Frontmatter) => edit(frontmatter));
    },
  };
}

// The vault writes these capitalised, and every one of the 220 notes that sets a
// usable status agrees. A ZoomIn edit should look like the ones already there.
export const STATUS_LABELS: Record<Status, string> = { unexplored: "Unexplored", exploring: "Exploring", explored: "Explored" };

// Click order. Unexplored -> exploring -> explored, then round again, which is
// the order the words describe and the order work actually happens in.
const CYCLE: Status[] = ["unexplored", "exploring", "explored"];

/**
 * The status a click moves to. A note with no usable status enters at the
 * start of the cycle rather than somewhere in the middle: the first click
 * should say "I have looked at this and it is not started".
 */
export function nextStatus(current: Status | null): Status {
  const i = current ? CYCLE.indexOf(current) : -1;
  return i < 0 ? CYCLE[0] : CYCLE[(i + 1) % CYCLE.length];
}

/* --- value renderers: the form each field takes, pure --------------------- */

/** `status: Exploring`. A list-valued status (46 notes) is replaced whole. */
export function statusValue(status: Status): string {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`unknown status ${status}`);
  return STATUS_LABELS[status];
}

/**
 * `Parent: "[[Stem]]"` — one wikilink, bare stem. A pathed target
 * (`[[Projects/Work]]`) is for the caller to choose when the stem alone would
 * be ambiguous. Obsidian quotes the string when it serialises it.
 */
export function parentValue(target: string | null): string | null {
  return target ? `[[${target}]]` : null;
}

/**
 * A one-item list. Whether the item is bare or a wikilink is the vault's
 * habit per category (Task is always bare, Meetings always linked), so the
 * caller decides from a count and this only spells it.
 */
export function categoryValue(name: string | null, wikilink: boolean): string[] | null {
  if (!name) return null;
  return [wikilink ? `[[${name}]]` : name];
}

/** `deadline: 2026-09-16`. */
export function deadlineValue(day: string | null): string | null {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a date: ${day}`);
  return day;
}

/* --- the write path ------------------------------------------------------- */

export async function setStatus(writer: FrontmatterWriter, path: string, status: Status): Promise<void> {
  const value = statusValue(status);
  await writer.process(path, (fm) => {
    fm["status"] = value;
  });
}

export async function setParent(writer: FrontmatterWriter, path: string, target: string | null): Promise<void> {
  const value = parentValue(target);
  await writer.process(path, (fm) => {
    fm["Parent"] = value;
  });
}

export async function setCategory(writer: FrontmatterWriter, path: string, name: string | null, wikilink: boolean): Promise<void> {
  const value = categoryValue(name, wikilink);
  await writer.process(path, (fm) => {
    fm["categories"] = value;
  });
}

export async function setDeadline(writer: FrontmatterWriter, path: string, day: string | null): Promise<void> {
  const value = deadlineValue(day);
  await writer.process(path, (fm) => {
    fm["deadline"] = value;
  });
}
