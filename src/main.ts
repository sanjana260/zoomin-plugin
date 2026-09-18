/**
 * ZoomIn as an Obsidian plugin.
 *
 * The map answers "where am I"; the task view answers "what do I do next"; the
 * lens answers "what is this, and what is it wired to". Each is a workspace
 * leaf — open, split and arrange them like any other view — and a panel in the
 * right sidebar carries priorities, domains and projects, or the dossier of
 * the note under the lens.
 *
 * This file wires the plugin into Obsidian: views, commands, settings and the
 * vault events that keep the model current. Everything ZoomIn *knows* lives in
 * the model; everything it *draws* lives in the views.
 */

import { Plugin, TAbstractFile, WorkspaceLeaf, debounce } from "obsidian";
import { ZoomInModel } from "./model";
import { appSource } from "./vault/snapshot";
import { GraphView, VIEW_GRAPH } from "./views/graph-view";

// How long to wait after the last vault event before rebuilding. Obsidian
// fires `changed` per keystroke-save; a save is a few events close together.
const REBUILD_DEBOUNCE_MS = 300;

export default class ZoomInPlugin extends Plugin {
  model!: ZoomInModel;
  private scheduleReload!: () => void;

  async onload(): Promise<void> {
    this.model = new ZoomInModel(appSource(this.app));

    this.registerView(VIEW_GRAPH, (leaf: WorkspaceLeaf) => new GraphView(leaf, this));

    this.addRibbonIcon("scan-search", "Open ZoomIn map", () => {
      void this.openView(VIEW_GRAPH);
    });
    this.addCommand({
      id: "open-graph",
      name: "Open map",
      callback: () => void this.openView(VIEW_GRAPH),
    });

    // The cache is not complete while Obsidian is still starting; build once
    // the workspace is up and every link has been resolved, then follow the
    // vault. `changed` covers a new or edited note's metadata; `deleted` and
    // `rename` are the vault's. Each is debounced into one reload — the
    // model works out whether the structure moved.
    this.scheduleReload = debounce(() => this.model.reload(), REBUILD_DEBOUNCE_MS, true);
    this.app.workspace.onLayoutReady(() => {
      this.model.reload();
      this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleReload()));
      this.registerEvent(this.app.metadataCache.on("deleted", () => this.scheduleReload()));
      this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile) => this.onRename(file)));
    });
  }

  onunload(): void {
    // Obsidian detaches our leaves itself; the views release their renderers.
  }

  private onRename(_file: TAbstractFile): void {
    // Phase 2 rewrites path-keyed state here; the reload alone is enough for the map.
    this.scheduleReload();
  }

  /** Reveal an existing leaf of this type, or open one in the main area. */
  async openView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /* --- hooks the views call; filled in by later phases -------------------- */

  /** A node click. Focus mode arrives in phase 5; until then, nothing. */
  focusNode(_id: string): void {}

  exitFocus(): void {}

  /** The layout settled. Persisted per device in phase 2. */
  savePositions(_positions: Record<string, [number, number]>): void {}
}
