/**
 * A `CacheSource` built from note specs, the way the Python tests built a
 * vault from strings with `assemble()`. It resolves links the way Obsidian's
 * cache would for these simple cases: exact path, path without extension, or a
 * bare stem (root-first, then alphabetical) — case-insensitive.
 */

import type { CachedMetadata, EmbedCache, LinkCache } from "obsidian";
import { buildSnapshot, CacheFile, CacheSource } from "../src/vault/snapshot";
import type { VaultSnapshot } from "../src/types";

export interface NoteSpec {
  frontmatter?: Record<string, unknown>;
  /** body wikilinks and markdown links, as the link text Obsidian caches */
  links?: string[];
  /** body embeds, as their link text */
  embeds?: string[];
}

/** A note, optionally hanging off a parent, with body links. */
export function note(parent: string | null = null, extra: NoteSpec = {}): NoteSpec {
  const frontmatter: Record<string, unknown> = { ...(extra.frontmatter ?? {}) };
  if (parent) frontmatter["Parent"] = `[[${parent}]]`;
  return { ...extra, frontmatter };
}

function cacheOf(spec: NoteSpec): CachedMetadata {
  const link = (text: string, i: number): LinkCache => ({
    link: text,
    original: `[[${text}]]`,
    displayText: text,
    position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: 0, offset: 0 } },
  });
  const embed = (text: string, i: number): EmbedCache => ({ ...link(text, i), original: `![[${text}]]` });
  const cache: CachedMetadata = {};
  if (spec.frontmatter && Object.keys(spec.frontmatter).length) cache.frontmatter = spec.frontmatter as never;
  if (spec.links?.length) cache.links = spec.links.map(link);
  if (spec.embeds?.length) cache.embeds = spec.embeds.map(embed);
  return cache;
}

export function fakeSource(files: Record<string, NoteSpec | string>): CacheSource {
  // A string value stands for a non-markdown file (`Tasks.base`, an image):
  // present in the vault, resolvable, never a note.
  const all: CacheFile[] = Object.keys(files).map((path) => {
    const name = path.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    return { path, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "" };
  });
  const byLower = new Map<string, CacheFile>();
  for (const f of all) byLower.set(f.path.toLowerCase(), f);
  const noExt = new Map<string, CacheFile>();
  for (const f of all) {
    const key = f.path.toLowerCase().replace(/\.[^./]+$/, "");
    if (!noExt.has(key)) noExt.set(key, f);
  }
  const rank = (f: CacheFile) => [f.path.split("/").length, f.path.toLowerCase()] as const;

  return {
    markdownFiles: () => all.filter((f) => f.extension === "md"),
    cache: (path) => {
      const spec = files[path];
      return typeof spec === "string" || !spec ? null : cacheOf(spec);
    },
    resolve: (linkpath) => {
      const target = linkpath.replace(/^\//, "");
      const exact = byLower.get(target.toLowerCase()) ?? noExt.get(target.toLowerCase());
      if (exact) return exact;
      if (target.includes("/")) return null;
      const stem = target.toLowerCase();
      const options = all.filter((f) => f.basename.toLowerCase() === stem);
      if (!options.length) return null;
      options.sort((a, b) => {
        const [da, pa] = rank(a), [db, pb] = rank(b);
        return da - db || (pa < pb ? -1 : pa > pb ? 1 : 0);
      });
      return options[0];
    },
  };
}

export function assemble(files: Record<string, NoteSpec | string>): VaultSnapshot {
  return buildSnapshot(fakeSource(files));
}
