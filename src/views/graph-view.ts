/**
 * The map, as a workspace leaf.
 *
 * The canvas and its overlays are laid out the way the pywebview app did it:
 * the renderer gets a div of its own, and every overlay (the tools, later the
 * filter popover and the hover card) is a *sibling* of that div inside the
 * wrap — force-graph wipes the element it is handed on init and would take
 * anything inside it along.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ZoomInPlugin from "../main";
import { GraphRenderer } from "./renderer";

export const VIEW_GRAPH = "zoomin-graph";

export function isDarkTheme(): boolean {
  return document.body.classList.contains("theme-dark");
}

export class GraphView extends ItemView {
  renderer: GraphRenderer | null = null;
  private unsubscribe: (() => void) | null = null;
  private graphEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ZoomInPlugin) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_GRAPH;
  }

  getDisplayText(): string {
    return "ZoomIn map";
  }

  getIcon(): string {
    return "scan-search";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("zoomin-view", "zoomin-graph-wrap");

    const graphEl = root.createDiv({ cls: "zoomin-graph" });
    this.graphEl = graphEl;

    const tools = root.createDiv({ cls: "zoomin-graph-tools zoomin-right" });
    const fit = tools.createEl("button", { cls: "zoomin-graph-btn", attr: { "aria-label": "Fit graph in view", title: "Fit graph in view" } });
    setIcon(fit, "maximize");
    fit.addEventListener("click", () => this.renderer?.fitAll());

    // The census, so a reader can compare the map with what they expect of
    // the vault: "107 notes · 91 links · 1 unwritten".
    this.statsEl = root.createDiv({ cls: "zoomin-graph-stats" });

    this.renderer = new GraphRenderer(graphEl, {
      dark: isDarkTheme(),
      onSelect: (node) => this.plugin.focusNode(node.id),
      onSettled: (positions) => this.plugin.savePositions(positions),
      onBackgroundClick: () => this.plugin.exitFocus(),
    });

    this.registerEvent(this.app.workspace.on("css-change", () => this.renderer?.setDark(isDarkTheme())));

    const model = this.plugin.model;
    this.unsubscribe = model.onChange((structural) => this.refresh(structural));
    this.refresh(true);
  }

  /** Structural changes reload the simulation; everything else only recolours. */
  refresh(structural: boolean): void {
    if (!this.renderer) return;
    const payload = this.plugin.model.payload();
    if (structural) this.renderer.setData(payload);
    else this.renderer.applyFocus(payload);
    const stats = payload.stats;
    this.statsEl?.setText(`${stats.notes} notes · ${stats.links} links · ${stats.phantoms} unwritten`);
    // The leaf may not have been laid out when the data landed; a 0x0 canvas
    // is a blank view, so re-measure once the frame has been painted.
    requestAnimationFrame(() => this.renderer?.resize());
  }

  onResize(): void {
    this.renderer?.resize();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.graphEl = null;
    this.statsEl = null;
    this.contentEl.empty();
  }
}
