/**
 * The map, as a workspace leaf.
 *
 * The canvas and its overlays are laid out the way the pywebview app did it:
 * the renderer gets a div of its own, and every overlay (the tools, the
 * filter popover, the hover card) is a *sibling* of that div inside the wrap
 * — force-graph wipes the element it is handed on init and would take
 * anything inside it along.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ZoomInPlugin from "../main";
import { GraphRenderer, RNode } from "./renderer";
import { checkbox, discloseButton, el, shapeIcon } from "./ui";

export const VIEW_GRAPH = "zoomin-graph";

export function isDarkTheme(): boolean {
  return document.body.classList.contains("theme-dark");
}

// Prefixed keys, so a datatype called "untyped" cannot collide with the row
// for notes that have none, and a status number cannot collide with a name.
const UNTYPED_KEY = "untyped";
const typeKey = (name: string) => "type:" + name;
const statusKey = (status: number) => "status:" + status;
const STATUS_ROWS: [number, string][] = [[2, "Exploring"], [1, "Unexplored"], [3, "Explored"], [0, "No status"]];

export const HIDDEN_KEY = "zoomin.hidden";
export const FILTER_COLLAPSED_KEY = "zoomin.filter-collapsed";

// Long enough to cross the gap from node to card without the card vanishing,
// short enough that it does not linger once you have moved on.
const CARD_GRACE = 260;

export function statusLabel(status: number): string {
  return ["Set status", "Unexplored", "Exploring", "Explored"][status || 0];
}

export class GraphView extends ItemView {
  renderer: GraphRenderer | null = null;
  private unsubscribe: (() => void) | null = null;
  private statsEl: HTMLElement | null = null;
  private hidden: Record<string, true> = {};
  private filterCollapsed: Record<string, true> = {};
  private filter: { button: HTMLButtonElement; panel: HTMLElement; sections: HTMLElement; clear: HTMLButtonElement } | null = null;
  private card: {
    el: HTMLElement;
    name: HTMLElement;
    type: HTMLElement;
    status: HTMLButtonElement;
    id: string | null;
    over: boolean;
    timer: number | null;
    frame: number | null;
  } | null = null;

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
    const local = this.plugin.local;
    this.hidden = local.idSet(HIDDEN_KEY);
    this.filterCollapsed = local.idSet(FILTER_COLLAPSED_KEY);

    const root = this.contentEl;
    root.empty();
    root.addClass("zoomin-view", "zoomin-graph-wrap");

    const graphEl = root.createDiv({ cls: "zoomin-graph" });

    // Tools: the funnel on the left; the magnifier and fit-all on the right.
    const left = root.createDiv({ cls: "zoomin-graph-tools zoomin-left" });
    const filterButton = left.createEl("button", { cls: "zoomin-graph-btn", attr: { type: "button", "aria-label": "Filter", title: "Filter", "aria-expanded": "false" } });
    setIcon(filterButton, "filter");
    const right = root.createDiv({ cls: "zoomin-graph-tools zoomin-right" });
    const search = right.createEl("button", { cls: "zoomin-graph-btn", attr: { type: "button", "aria-label": "Search notes", title: "Search notes", "aria-haspopup": "dialog" } });
    setIcon(search, "search");
    search.addEventListener("click", (event) => {
      event.stopPropagation();
      this.plugin.openSearch({ onPick: (item) => this.plugin.enterFocus(item.id, { explicit: true }) });
    });
    const fit = right.createEl("button", { cls: "zoomin-graph-btn", attr: { type: "button", "aria-label": "Fit graph in view", title: "Fit graph in view" } });
    setIcon(fit, "maximize");
    fit.addEventListener("click", () => this.renderer?.fitAll());

    // Anchored under the funnel rather than modal: a filter is something you
    // adjust while watching the map react, not a decision you step away to make.
    const panel = root.createDiv({ cls: "zoomin-popover", attr: { role: "dialog", "aria-label": "Filter" } });
    panel.hide();
    const head = panel.createDiv({ cls: "zoomin-popover-head" });
    head.createEl("h3", { text: "Filter" });
    // Only shown while something is hidden: in the default state the
    // sections' own All/None are the only controls, and that is enough.
    const clear = head.createEl("button", { cls: "zoomin-linkish", text: "Clear", attr: { type: "button" } });
    const sections = panel.createDiv({ cls: "zoomin-filter-sections" });
    this.filter = { button: filterButton, panel, sections, clear };
    filterButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.isShown()) this.closeFilter();
      else this.openFilter();
    });
    panel.addEventListener("click", (event) => event.stopPropagation());
    clear.addEventListener("click", () => {
      this.hidden = {};
      this.applyFilter();
      this.renderFilterPanel();
    });
    // A popover that only closes by its own button is one people leave open.
    this.registerDomEvent(document, "click", () => {
      if (panel.isShown()) this.closeFilter();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && panel.isShown()) this.closeFilter();
    });

    // Hover card. Interactive, so it has to survive the pointer leaving the
    // node on its way here — hence the grace period.
    const cardEl = root.createDiv({ cls: "zoomin-node-card" });
    cardEl.hide();
    const cardName = cardEl.createDiv({ cls: "zoomin-card-name" });
    const meta = cardEl.createDiv({ cls: "zoomin-card-meta" });
    const cardType = meta.createSpan({ cls: "zoomin-card-type" });
    const cardStatus = meta.createEl("button", { cls: "zoomin-card-status", attr: { type: "button" } });
    cardStatus.addEventListener("click", () => this.cycleStatus());
    this.card = { el: cardEl, name: cardName, type: cardType, status: cardStatus, id: null, over: false, timer: null, frame: null };
    cardEl.addEventListener("mouseenter", () => {
      this.card!.over = true;
      if (this.card!.timer !== null) window.clearTimeout(this.card!.timer);
    });
    cardEl.addEventListener("mouseleave", () => {
      this.card!.over = false;
      this.hideCard(false);
    });

    // The census, so a reader can compare the map with what they expect of the vault.
    this.statsEl = root.createDiv({ cls: "zoomin-graph-stats" });

    this.renderer = new GraphRenderer(graphEl, {
      dark: isDarkTheme(),
      onSelect: (node) => this.plugin.focusNode(node.id),
      onSettled: (positions) => this.plugin.savePositions(positions),
      onBackgroundClick: () => this.plugin.exitFocus(),
      onHover: (node) => {
        // Zoomed out, only parents earn the card; other nodes get their name
        // from the canvas label and nothing else in the way.
        if (node && this.renderer?.detailHover(node)) this.showCard(node);
        else this.hideCard(false);
      },
    });
    this.renderer.setFilter(this.hidden);
    filterButton.classList.toggle("active", this.anyHidden());

    this.registerEvent(this.app.workspace.on("css-change", () => this.renderer?.setDark(isDarkTheme())));

    this.unsubscribe = this.plugin.model.onChange((structural) => this.refresh(structural));
    this.refresh(true);
    // The lens may already be on before this leaf existed (the active-file
    // follower never opens leaves); catching up costs one repaint — and means
    // landing on the note, the same camera a click on its node would give.
    if (this.plugin.focusId !== null) {
      this.renderer.setFocus(this.plugin.focusId);
      this.renderer.focusOn(this.plugin.focusId);
    }
  }

  /** Structural changes reload the simulation; everything else only recolours. */
  refresh(structural: boolean): void {
    if (!this.renderer) return;
    const payload = this.plugin.model.payload();
    if (structural) this.renderer.setData(payload);
    else this.renderer.applyFocus(payload);
    const stats = payload.stats;
    this.statsEl?.setText(`${stats.notes} notes · ${stats.links} links · ${stats.phantoms} unwritten`);
    if (this.filter?.panel.isShown()) this.renderFilterPanel();
    // A card left showing a node that just changed should say what it now says.
    if (this.card?.id) {
      const node = this.renderer.byId[this.card.id];
      if (node) this.showCard(node);
      else this.hideCard(true);
    }
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
    this.hideCard(true);
    this.renderer?.destroy();
    this.renderer = null;
    this.statsEl = null;
    this.filter = null;
    this.card = null;
    this.contentEl.empty();
  }

  /* --- filters ------------------------------------------------------------ */

  private anyHidden(): boolean {
    return Object.keys(this.hidden).length > 0;
  }

  private applyFilter(): void {
    this.renderer?.setFilter(this.hidden);
    // A filter that hides things has to announce itself, or a map missing half
    // its nodes reads as a bug rather than a choice.
    this.filter?.button.classList.toggle("active", this.anyHidden());
    this.filter?.clear.toggle(this.anyHidden());
    this.plugin.local.saveIdSet(HIDDEN_KEY, this.hidden);
  }

  private filterRow(key: string, label: string, icon: Element): HTMLElement {
    const item = el("li");
    const line = el("label", "zoomin-filter-item");
    const box = checkbox();
    box.checked = !this.hidden[key];
    box.onchange = () => {
      if (box.checked) delete this.hidden[key];
      else this.hidden[key] = true;
      this.applyFilter();
      this.renderFilterPanel();
    };
    line.appendChild(box);
    const slot = el("span", "zoomin-cat-icon");
    slot.appendChild(icon);
    line.appendChild(slot);
    line.appendChild(el("span", "zoomin-filter-name", label));
    item.appendChild(line);
    return item;
  }

  // One collapsible group. `rows` is [key, label, icon] triples; the group's
  // All/None act on exactly those keys and nothing else.
  private filterSection(id: string, title: string, rows: [string, string, Element][]): HTMLElement {
    const section = el("section", "zoomin-filter-section");
    const collapsed = !!this.filterCollapsed[id];
    const hiddenHere = rows.filter((r) => this.hidden[r[0]]).length;
    const head = el("div", "zoomin-filter-section-head");
    const list = el("ul", "zoomin-list");
    list.toggle(!collapsed);
    head.appendChild(
      discloseButton(!collapsed, "Show " + title + " filters", () => {
        this.plugin.local.toggleIn(FILTER_COLLAPSED_KEY, this.filterCollapsed, id);
        this.renderFilterPanel();
      }),
    );
    head.appendChild(el("span", "zoomin-filter-section-title", title));
    if (collapsed) {
      // Folded shut, the only thing worth saying is whether it is doing
      // anything — a collapsed filter silently hiding half the map is the
      // worst kind of surprise.
      if (hiddenHere) head.appendChild(el("span", "zoomin-filter-summary", hiddenHere + " hidden"));
    } else {
      const all = el("button", "zoomin-linkish tiny", "All");
      all.type = "button";
      all.onclick = () => {
        for (const r of rows) delete this.hidden[r[0]];
        this.applyFilter();
        this.renderFilterPanel();
      };
      const none = el("button", "zoomin-linkish tiny", "None");
      none.type = "button";
      none.onclick = () => {
        for (const r of rows) this.hidden[r[0]] = true;
        this.applyFilter();
        this.renderFilterPanel();
      };
      const controls = el("span", "zoomin-filter-controls");
      controls.appendChild(all);
      controls.appendChild(el("span", "zoomin-filter-sep", "·"));
      controls.appendChild(none);
      head.appendChild(controls);
    }
    for (const r of rows) list.appendChild(this.filterRow(r[0], r[1], r[2]));
    section.appendChild(head);
    section.appendChild(list);
    return section;
  }

  private renderFilterPanel(): void {
    if (!this.filter) return;
    const host = this.filter.sections;
    host.empty();
    const seen = new Set<string>();
    const typeRows: [string, string, Element][] = [];
    for (const d of this.plugin.model.payload().datatypes) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      typeRows.push([typeKey(d.name), d.name, shapeIcon(d.shape)]);
    }
    // Untyped notes are most of the vault, so they need a row of their own —
    // otherwise the filter can only ever hide the minority.
    typeRows.push([UNTYPED_KEY, "No datatype", shapeIcon(null)]);
    host.appendChild(this.filterSection("datatype", "Datatype", typeRows));
    host.appendChild(
      this.filterSection(
        "status",
        "Status",
        STATUS_ROWS.map((r) => [statusKey(r[0]), r[1], el("span", "zoomin-status-swatch s" + r[0])]),
      ),
    );
    this.filter.clear.toggle(this.anyHidden());
  }

  private openFilter(): void {
    if (!this.filter) return;
    this.renderFilterPanel();
    this.filter.panel.show();
    this.filter.button.setAttribute("aria-expanded", "true");
  }

  private closeFilter(): void {
    if (!this.filter) return;
    this.filter.panel.hide();
    this.filter.button.setAttribute("aria-expanded", "false");
  }

  /* --- the hover card ----------------------------------------------------- */

  private trackCard(): void {
    const card = this.card;
    if (!card || !this.renderer) return;
    // The node moves while the simulation settles and whenever you pan, so the
    // card follows it rather than being placed once and left behind.
    const at = card.id ? this.renderer.screenPos(card.id) : null;
    if (!at) {
      this.hideCard(true);
      return;
    }
    card.el.style.left = at.x + "px";
    card.el.style.top = at.y - at.r - 10 + "px";
    card.frame = requestAnimationFrame(() => this.trackCard());
  }

  showCard(node: RNode): void {
    const card = this.card;
    if (!card) return;
    if (card.timer !== null) window.clearTimeout(card.timer);
    card.id = node.id;
    card.name.setText(node.label);
    const datatypes = this.plugin.model.payload().datatypes;
    const datatype = node.datatype >= 0 ? datatypes[node.datatype] : null;
    card.type.setText(datatype ? datatype.name : "");
    card.type.toggle(!!datatype);
    const phantom = node.kind !== 0;
    card.status.setText(statusLabel(node.status));
    card.status.className = "zoomin-card-status s" + (node.status || 0);
    // A phantom is a link to a note that does not exist yet — there is no file
    // to carry a status, so the control is absent rather than broken.
    card.status.toggle(!phantom);
    card.status.disabled = !this.plugin.canWrite();
    card.el.show();
    if (card.frame !== null) cancelAnimationFrame(card.frame);
    this.trackCard();
  }

  hideCard(now: boolean): void {
    const card = this.card;
    if (!card) return;
    if (card.timer !== null) window.clearTimeout(card.timer);
    card.timer = window.setTimeout(
      () => {
        if (card.over) return;
        card.id = null;
        if (card.frame !== null) cancelAnimationFrame(card.frame);
        card.el.hide();
      },
      now ? 0 : CARD_GRACE,
    );
  }

  private cycleStatus(): void {
    const card = this.card;
    if (!card || !card.id) return;
    card.status.disabled = true;
    void this.plugin.cycleStatus(card.id).finally(() => {
      if (this.card) this.card.status.disabled = !this.plugin.canWrite();
    });
  }
}
