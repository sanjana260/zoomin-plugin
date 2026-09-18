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

import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { ZoomInModel } from "./model";
import { DEFAULT_SETTINGS, ZoomInSettingTab, ZoomInSettings } from "./settings";
import { LocalState } from "./state/local";
import { Store, StoreData, upgrade } from "./state/store";
import { appSource } from "./vault/snapshot";
import { STATUS_LABELS, appWriter } from "./vault/write";
import { shapeDot } from "./views/ui";
import { DatatypesModal } from "./views/datatypes-modal";
import { DomainModal } from "./views/domain-modal";
import { GraphView, VIEW_GRAPH } from "./views/graph-view";
import { PanelView, VIEW_PANEL } from "./views/panel-view";
import { SearchItem, ZoomInSearch } from "./views/search-modal";
import { TasksView, VIEW_TASKS } from "./views/tasks-view";

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
    this.registerView(VIEW_TASKS, (leaf: WorkspaceLeaf) => new TasksView(leaf, this));
    this.addSettingTab(new ZoomInSettingTab(this.app, this));

    this.addRibbonIcon("scan-search", "Open ZoomIn map", () => void this.openGraph());
    this.addCommand({ id: "open-graph", name: "Open map", callback: () => void this.openGraph() });
    this.addCommand({ id: "open-panel", name: "Open panel", callback: () => void this.openPanel() });
    this.addCommand({ id: "open-tasks", name: "Open tasks", callback: () => void this.openTasks() });
    this.addCommand({ id: "open-datatypes", name: "Edit datatypes", callback: () => this.openDatatypes() });
    this.addCommand({
      id: "focus-on-note",
      name: "Focus on note…",
      callback: () => this.openSearch({ onPick: (item) => this.enterFocus(item.id, { explicit: true }) }),
    });
    this.addCommand({
      id: "focus-active-note",
      name: "Focus the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.model.snapshot.notes.has(file.path)) return false;
        if (!checking) this.enterFocus(file.path, { explicit: true });
        return true;
      },
    });
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
      // The dossier follows the note open in the editor, when it wants to.
      // Not explicit: it never opens a leaf and only moves a lens that is
      // already on the map.
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (!this.settings.followActiveFile) return;
          const file = leaf?.view instanceof MarkdownView ? leaf.view.file : null;
          if (!file || file.path === this.focusId) return;
          if (!this.model.snapshot.notes.has(file.path)) return;
          if (this.focusId === null && !this.app.workspace.getLeavesOfType(VIEW_PANEL).length) return;
          this.enterFocus(file.path);
        }),
      );
      // Escape leaves the lens — unless a dialog owns it.
      this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
        if (event.key === "Escape" && this.focusId !== null && !document.querySelector(".modal-container")) {
          this.exitFocus();
        }
      });
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

  async openTasks(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TASKS);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TASKS, active: true });
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
  /* --- focus mode --------------------------------------------------------- */

  /** The note under the lens, or null. The dossier reads the model through
   *  it; the lens reads the renderer. */
  focusId: string | null = null;

  focusNode(id: string): void {
    this.enterFocus(id);
  }

  /**
   * Put one note under the lens: the map lights its neighbourhood and the
   * panel becomes its dossier. `explicit` is a click, a palette pick or a
   * command — those open whichever leaf they need. The active-file follower
   * is not explicit: it never opens a leaf, and it only moves the lens the
   * map already shows.
   */
  enterFocus(id: string, options: { explicit?: boolean } = {}): void {
    if (!this.model.nodeInfo(id)) return;
    this.focusId = id;
    const graph = options.explicit ? null : this.graphRenderer();
    if (options.explicit) {
      void this.openGraph().then((view) => {
        view?.renderer?.setFocus(id);
        view?.renderer?.focusOn(id);
      });
      void this.openPanel();
    } else if (graph) {
      graph.setFocus(id);
      graph.focusOn(id);
    }
    this.refreshFocusViews();
  }

  /** Leaving the lens keeps the camera: you leave it where you were looking. */
  exitFocus(): void {
    if (this.focusId === null) return;
    this.focusId = null;
    this.graphRenderer()?.setFocus(null);
    this.refreshFocusViews();
  }

  private graphRenderer() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_GRAPH)[0];
    return (leaf?.view as GraphView | undefined)?.renderer ?? null;
  }

  private refreshFocusViews(): void {
    this.panelView()?.refreshFocus();
  }

  private panelView(): PanelView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_PANEL)[0];
    return (leaf?.view as PanelView | undefined) ?? null;
  }

  /** Every note on the map, as palette rows. Parents first, biggest first —
   *  with an empty query the list has to be worth reading, and the notes that
   *  organise the vault are the ones you most often go looking for. */
  searchItems(exclude?: Record<string, true>): SearchItem[] {
    const n = this.model.payload().nodes;
    const items: SearchItem[] = [];
    for (let i = 0; i < n.id.length; i++) {
      if (exclude && exclude[n.id[i]]) continue;
      const phantom = n.kind[i] !== 0;
      const datatype = n.datatype[i] >= 0 ? this.model.payload().datatypes[n.datatype[i]] : null;
      items.push({
        id: n.id[i],
        label: n.label[i],
        sub: phantom ? "linked to, not written yet" : n.id[i],
        kind: phantom ? "unwritten" : datatype ? datatype.name : "",
      });
    }
    const sizeOf = new Map<string, number>();
    for (let i = 0; i < n.id.length; i++) sizeOf.set(n.id[i], n.isParent[i] ? -n.size[i] : 1);
    items.sort(
      (a, b) =>
        (sizeOf.get(a.id)! - sizeOf.get(b.id)!) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return items;
  }

  /** Open a note in the editor — the dossier's one way out of the plugin. */
  openNote(path: string): void {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    void this.app.workspace.getLeaf(false).openFile(file);
  }

  /** The dossier's parent picker: every written note but the subject. */
  pickParent(ofPath: string): void {
    const exclude: Record<string, true> = { [ofPath]: true };
    this.openSearch({
      title: "Parent of " + (this.model.nodeInfo(ofPath)?.label ?? ""),
      placeholder: "Choose a parent…",
      exclude,
      filterPhantoms: true,
      onPick: (item) => {
        void this.model
          .editNote(ofPath, "parent", item.id)
          .then(() => this.panelView()?.render())
          .catch(() => {});
      },
    });
  }

  openSearch(options: { title?: string; placeholder?: string; onPick: (item: SearchItem) => void; exclude?: Record<string, true>; filterPhantoms?: boolean }): void {
    let items = this.searchItems(options.exclude);
    if (options.filterPhantoms) items = items.filter((item) => item.kind !== "unwritten");
    new ZoomInSearch(this.app, {
      items,
      title: options.title,
      placeholder: options.placeholder ?? "Search notes…",
      emptyText: "No note matches.",
      icon: (item) => {
        const info = this.model.nodeInfo(item.id);
        const shape = info && info.datatype >= 0 ? this.model.payload().datatypes[info.datatype].shape : null;
        return shapeDot(shape, info ? info.hue : null);
      },
      onPick: options.onPick,
    }).open();
  }

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
