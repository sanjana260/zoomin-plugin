/**
 * The vault as ZoomIn sees it, read from Obsidian's metadata cache.
 *
 * This replaces the Python scanner, parser, resolver and masker outright.
 * Obsidian has already parsed every note's frontmatter, found every link and
 * embed in its body (code fences and inline code excluded), and resolves a
 * link the way only Obsidian can — vault-absolute first, aliases never, case-
 * insensitive, NFC. What is left for us is the *rules* about which of those
 * become edges, which are the same rules the Python app measured its way to:
 *
 *   * `Parent:` is a hierarchy edge; every other link is associative;
 *   * an embed only becomes an edge when its target is a note. Every project
 *     note in the reference vault embeds the same six `.base` files, and as
 *     edges those collapse the whole graph into one false hub (Trap 1);
 *   * `categories:` values are never edges — 113 notes share `Task`;
 *   * an unresolved link is a phantom: an intention not yet written;
 *   * a note linking to itself is not an edge, and duplicates collapse.
 *
 * Reading goes through a small `CacheSource` interface so the rules can be
 * tested against a hand-built cache without Obsidian.
 */

import type { App, CachedMetadata, TFile } from "obsidian";
import { parseLinktext } from "obsidian";
import { Edge, LinkKind, Note, PHANTOM_PREFIX, VaultSnapshot, fold, nfc } from "../types";
import { categoryNames, frontmatterLinks, noteDeadline, noteDescription, noteStatus } from "./categories";

export interface CacheFile {
  path: string;
  basename: string;
  extension: string;
}

export interface CacheSource {
  /** Every markdown file Obsidian indexes. */
  markdownFiles(): CacheFile[];
  /** Obsidian's parsed metadata for a file, or null while it is still indexing. */
  cache(path: string): CachedMetadata | null;
  /** Resolve a link path the way Obsidian does, from a source file. */
  resolve(linkpath: string, sourcePath: string): CacheFile | null;
}

/** The real thing. */
export function appSource(app: App): CacheSource {
  const asFile = (file: TFile): CacheFile => ({ path: file.path, basename: file.basename, extension: file.extension });
  return {
    markdownFiles: () => app.vault.getMarkdownFiles().map(asFile),
    cache: (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.metadataCache.getFileCache(file) : null;
    },
    resolve: (linkpath, sourcePath) => {
      const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      return file ? asFile(file) : null;
    },
  };
}

// Skipped because they are scaffolding, not thinking. Templates are boilerplate
// whose links are copies of each other; Attachments are binaries. Root-level
// only, as the Python scanner had it.
export const DEFAULT_EXCLUDED_DIRS = ["Templates", "Attachments"];

// Obsidian does not index dot-folders, so `.trash`, `.git` and the config
// folder never reach us; sync tools' conflict copies still can.
const SYNC_CONFLICT = ".sync-conflict-";

/** Where an Obsidian vault conventionally keeps one note per note-type. */
export const CATEGORY_DIR = "Categories";

/** A link target is a note when it has no extension or an explicit `.md`. */
function isNoteTarget(target: string): boolean {
  const name = target.split("/").pop() ?? target;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true;
  return name.slice(dot).toLowerCase() === ".md";
}

export function included(path: string, excludedDirs: string[] = DEFAULT_EXCLUDED_DIRS): boolean {
  if (path.includes(SYNC_CONFLICT)) return false;
  const top = path.split("/", 1)[0];
  return !(path.includes("/") && excludedDirs.includes(top));
}

function readNote(file: CacheFile, cache: CachedMetadata | null): Note {
  const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const parents = frontmatterLinks(frontmatter["Parent"]);
  return {
    path: nfc(file.path),
    title: nfc(file.basename),
    frontmatter,
    categories: categoryNames(frontmatter["categories"]),
    status: noteStatus(frontmatter["status"]),
    deadline: noteDeadline(frontmatter["deadline"]),
    parentLink: parents.length ? parents[0] : null,
    description: noteDescription(frontmatter),
  };
}

const URL_SCHEMES = ["http://", "https://", "mailto:", "obsidian://", "data:", "ftp://"];

/** Strip an alias and a subpath from a cached link, unescape a table pipe,
 *  and decode a markdown link's percent-encoding. */
function bareTarget(link: string): string | null {
  if (URL_SCHEMES.some((scheme) => link.startsWith(scheme))) return null;
  let text = link.replace(/\\\|/g, "|").split("|", 1)[0];
  if (text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      /* not encoded after all; use it as written */
    }
  }
  const { path } = parseLinktext(text);
  const target = path.trim();
  return target || null;
}

export function buildSnapshot(source: CacheSource, excludedDirs: string[] = DEFAULT_EXCLUDED_DIRS): VaultSnapshot {
  const snapshot: VaultSnapshot = { notes: new Map(), edges: [], phantoms: new Map() };
  const files = source
    .markdownFiles()
    .filter((f) => included(f.path, excludedDirs))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const caches = new Map<string, CachedMetadata | null>();
  for (const file of files) {
    const cache = source.cache(file.path);
    caches.set(file.path, cache);
    const note = readNote(file, cache);
    snapshot.notes.set(note.path, note);
  }

  const seen = new Set<string>();
  const addEdge = (sourcePath: string, target: string, kind: LinkKind, mustBeNote: boolean) => {
    if (!target) return;
    const resolved = source.resolve(target, sourcePath);
    let targetId: string;
    if (resolved) {
      // A resolved target that is not a markdown note — a `.base`, an image,
      // a PDF — is parsed but never an edge, whatever the link's form.
      if (resolved.extension !== "md") return;
      targetId = nfc(resolved.path);
      // Resolved into a folder we exclude (a template): still not a node.
      if (!snapshot.notes.has(targetId)) return;
    } else {
      if (mustBeNote && !isNoteTarget(target)) return;
      targetId = PHANTOM_PREFIX + fold(target);
      if (!snapshot.phantoms.has(targetId)) snapshot.phantoms.set(targetId, nfc(target));
    }
    if (targetId === sourcePath) return; // a note linking to itself is not an edge
    const key = sourcePath + "\n" + targetId + "\n" + kind;
    if (seen.has(key)) return;
    seen.add(key);
    snapshot.edges.push({ source: sourcePath, target: targetId, kind });
  };

  for (const file of files) {
    const path = nfc(file.path);
    const cache = caches.get(file.path);
    const note = snapshot.notes.get(path)!;

    // Hierarchy first: `Parent:` is the backbone of the vault. Read from the
    // frontmatter value itself rather than Obsidian's `frontmatterLinks`, so
    // the rule does not depend on how the property was quoted.
    for (const target of frontmatterLinks(note.frontmatter["Parent"])) {
      addEdge(path, target, LinkKind.HIERARCHY, true);
    }

    if (!cache) continue;
    for (const link of cache.links ?? []) {
      const target = bareTarget(link.link);
      if (target) addEdge(path, target, LinkKind.ASSOCIATIVE, true);
    }
    for (const embed of cache.embeds ?? []) {
      const target = bareTarget(embed.link);
      if (target) addEdge(path, target, LinkKind.ASSOCIATIVE, true);
    }
    // `frontmatterLinks` would add `Parent:` again (handled above) and any
    // wikilinked `categories:` — which must never be edges — so it is not read.
  }

  return snapshot;
}
