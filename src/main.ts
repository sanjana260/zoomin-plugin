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

import { ItemView, Plugin, WorkspaceLeaf } from "obsidian";

export const VIEW_GRAPH = "zoomin-graph";

class GraphView extends ItemView {
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
    root.addClass("zoomin-view");
    root.createEl("p", { text: "ZoomIn: the map arrives in phase 1.", cls: "zoomin-placeholder" });
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

export default class ZoomInPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_GRAPH, (leaf: WorkspaceLeaf) => new GraphView(leaf));

    this.addRibbonIcon("scan-search", "Open ZoomIn map", () => {
      void this.openView(VIEW_GRAPH);
    });

    this.addCommand({
      id: "open-graph",
      name: "Open map",
      callback: () => void this.openView(VIEW_GRAPH),
    });
  }

  onunload(): void {
    // Obsidian detaches our leaves itself; nothing else to release yet.
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
}
