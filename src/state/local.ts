/**
 * Per-device, per-vault state: things that are true of this screen and this
 * viewer rather than of the vault. Node positions, and the sidebar's
 * remembered folds and filters.
 *
 * Kept out of `data.json` on purpose (decision 39): positions settled on a
 * 27-inch display are the wrong answer on a laptop, and a synced fold state
 * is a fold the other machine did not ask for. Nothing here has to survive —
 * an absent store is a valid store: nothing collapsed, nothing hidden, every
 * note at its seed.
 *
 * Obsidian's `loadLocalStorage`/`saveLocalStorage` are already scoped to the
 * vault, so keys need no vault prefix.
 */

import type { App } from "obsidian";
import type { Positions } from "../types";

const POSITIONS_KEY = "zoomin.positions";

export type IdSet = Record<string, true>;

export class LocalState {
  constructor(private readonly app: App) {}

  private read(key: string): unknown {
    try {
      return this.app.loadLocalStorage(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.app.saveLocalStorage(key, value);
    } catch {
      /* the screen already shows it; only the memory is lost */
    }
  }

  positions(): Positions {
    const raw = this.read(POSITIONS_KEY);
    const out: Positions = new Map();
    if (raw && typeof raw === "object") {
      for (const [id, xy] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(xy) && xy.length === 2 && typeof xy[0] === "number" && typeof xy[1] === "number") {
          out.set(id, [xy[0], xy[1]]);
        }
      }
    }
    return out;
  }

  savePositions(positions: Record<string, [number, number]>): void {
    // Merge rather than replace: a filtered view settles only what it shows,
    // and the hidden notes must not lose their places for it.
    const merged: Record<string, [number, number]> = {};
    for (const [id, xy] of this.positions()) merged[id] = xy;
    Object.assign(merged, positions);
    this.write(POSITIONS_KEY, merged);
  }

  /** A remembered set of ids (open domains, hidden filters…). */
  idSet(key: string): IdSet {
    const raw = this.read(key);
    const set: IdSet = {};
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") set[id] = true;
    return set;
  }

  saveIdSet(key: string, set: IdSet): void {
    this.write(key, Object.keys(set));
  }

  toggleIn(key: string, set: IdSet, id: string): void {
    if (set[id]) delete set[id];
    else set[id] = true;
    this.saveIdSet(key, set);
  }

  flag(key: string): boolean {
    return this.read(key) === true;
  }

  saveFlag(key: string, value: boolean): void {
    this.write(key, value);
  }
}
