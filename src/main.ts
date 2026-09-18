/**
 * ZoomIn as an Obsidian plugin.
 *
 * The map answers "where am I"; the task view answers "what do I do next"; the
 * lens answers "what is this, and what is it wired to". Each is a workspace
 * leaf — open, split and arrange them like any other view — and a panel in the
 * right sidebar carries priorities, domains and projects, or the dossier of
 * the note under the lens.
 *
 * This file wires the plugin into Obsidian: views, commands, settings, the
 * store's persistence, and the vault events that keep the model current.
 * Everything ZoomIn *knows* lives in the model; everything it *draws* lives
 * in the views.
 */

import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { ZoomInModel } from "./model";
import { DEFAULT_SETTINGS, ZoomInSettingTab, ZoomInSettings } from "./settings";
import { LocalState } from "./state/local";
import { Store, StoreData, upgrade } from "./state/store";
import { appSource } from "./vault/snapshot";
import { STATUS_LABELS, appWriter } from "./vault/write";
import { DatatypesModal } from "./views/datatypes-modal";
import { DomainModal } from "./views/domain-modal";
import { GraphView, VIEW_GRAPH } from "./views/graph-view";
import { PanelView, VIEW_PANEL } from "./views/panel-view";

// How long to wait after the last vault event before rebuilding. Obsidian
// fires `changed` per save; a save is a few events close together.
const REBUILD_DEBOUNCE_MS = 300;

// The store saves on every mutation; the file write is coalesced so a run
// of clicks is one write.
const SAVE_DEBOUNCE_MS = 400;

/** The shape of data.json: the store plus the settings, one file. */
interface PluginData {
  settings?: Partial<ZoomInSettings>;
  store?: unknown;
  /** written by scripts/migrate_state.py; imported once into per-device storage, then dropped */
  positions?: Record<string, [number, number]>;
}

export default class ZoomInPlugin extends Plugin {
  model!: ZoomInModel;
  local!: LocalState;
  settings: ZoomInSettings = { ...DEFAULT_SETTINGS };
  private storeData!: StoreData;
  private scheduleReload!: () => void;
  private scheduleSave!: () => void;

  async onload(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
    this.storeData = upgrade(raw.store);
    this.scheduleSave = debounce(() => void this.persist(), SAVE_DEBOUNCE_MS, true);
    const store = new Store(this.storeData, () => this.scheduleSave());

    this.local = new LocalState(this.app);
    if (raw.positions && typeof raw.positions === "object") {
      // A migrated layout arrives in data.json because that is the file the
      // migration can write; it belongs to this device, so it moves to local
      // storage on first load and the key is dropped from the synced file.
      this.local.savePositions(raw.positions);
      this.scheduleSave();
    }
    this.model = new ZoomInModel(appSource(this.app), store, appWriter(this.app));
    this.model.positions = this.local.positions();
    this.applyCaps();

    this.registerView(VIEW_GRAPH, (leaf: WorkspaceLeaf) => new GraphView(leaf, this));
    this.registerView(VIEW_PANEL, (leaf: WorkspaceLeaf) => new PanelView(leaf, this));
    this.addSettingTab(new ZoomInSettingTab(this.app, this));

    this.addRibbonIcon("scan-search", "Open ZoomIn map", () => void this.openGraph());
    this.addCommand({ id: "open-graph", name: "Open map", callback: () => void this.openGraph() });
    this.addCommand({ id: "open-panel", name: "Open panel", callback: () => void this.openPanel() });
    this.addCommand({ id: "open-datatypes", name: "Edit datatypes", callback: () => this.openDatatypes() });
    this.addCommand({
      id: "cycle-status-active",
      name: "Cycle status of the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.model.snapshot.notes.has(file.path)) return false;
        if (!checking) void this.cycleStatus(file.path);
        return true;
      },
    });

    // The cache is not complete while Obsidian is still starting; build once
    // the workspace is up, then follow the vault. `changed` covers a new or
    // edited note's metadata; `deleted` and `rename` are the vault's. Each is
    // debounced into one reload — the model works out whether the structure
    // moved.
    this.scheduleReload = debounce(() => this.model.reload(), REBUILD_DEBOUNCE_MS, true);
    this.app.workspace.onLayoutReady(() => {
      this.model.reload();
      this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleReload()));
      this.registerEvent(this.app.metadataCache.on("deleted", () => this.scheduleReload()));
      this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => this.onRename(file, oldPath)));
    });
  }

  onunload(): void {
    // Obsidian detaches our leaves itself; the views release their renderers.
  }

  /* --- persistence -------------------------------------------------------- */

  private async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, store: this.storeData };
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    this.applyCaps();
    await this.persist();
    this.model.rebuild(false);
  }

  private applyCaps(): void {
    this.model.caps = { domainSlots: this.settings.domainSlots, projectSlots: this.settings.projectSlots };
  }

  /** The layout settled: remembered per device, and kept in the model so a
   *  rebuild seeds from where things are rather than where they started. */
  savePositions(positions: Record<string, [number, number]>): void {
    this.model.setPositions(positions);
    this.local.savePositions(positions);
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    // Every path-keyed row follows the note; the reload redraws the map. A
    // folder rename arrives as one event per file inside it, so nothing
    // special is needed for folders.
    if (file instanceof TFile) this.model.rename(oldPath, file.path);
    this.scheduleReload();
  }

  /* --- views -------------------------------------------------------------- */

  async openGraph(): Promise<GraphView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_GRAPH);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return existing[0].view as GraphView;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_GRAPH, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as GraphView;
  }

  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_PANEL);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_PANEL, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  openDomain(id: string): void {
    new DomainModal(this.app, this, id).open();
  }

  openDatatypes(): void {
    new DatatypesModal(this.app, this).open();
  }

  /** A panel row was clicked: show the map and go there. A click that zooms
   *  a canvas you cannot see is a click that did nothing. */
  zoomToNote(path: string): void {
    void this.openGraph().then((view) => {
      // The leaf may have just been created and its canvas measured at 0x0.
      requestAnimationFrame(() => {
        view?.renderer?.resize();
        view?.renderer?.centerOnNode(path);
      });
    });
  }

  zoomToDomain(id: string): void {
    void this.openGraph().then((view) => {
      requestAnimationFrame(() => {
        view?.renderer?.resize();
        view?.renderer?.centerOnDomainById(id);
      });
    });
  }

  /* --- hooks filled in by later phases ------------------------------------ */

  /** A node click. Focus mode arrives in phase 5. */
  focusNode(_id: string): void {}

  exitFocus(): void {}

  /** Whether the vault can be written from here. */
  canWrite(): boolean {
    return this.model.canWrite;
  }

  /** Advance a note's status and everything under it; say so if it cascaded. */
  async cycleStatus(path: string): Promise<void> {
    try {
      const result = await this.model.setStatus(path);
      // A click that just rewrote a subtree should say so.
      if (result.cascaded > 0) {
        new Notice(`${STATUS_LABELS[result.status]} — and ${result.cascaded} note${result.cascaded === 1 ? "" : "s"} under it`, 1800);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 4000);
    }
  }
}
