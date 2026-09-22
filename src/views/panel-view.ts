/**
 * The panel: priorities, domains and projects, in the right sidebar — and,
 * while a note is under the lens, that note's dossier instead; or, in tracker
 * mode, the map itself, kept framed on the note open in the editor. The map
 * answers "where am I"; the dossier answers "what is this, and what is it
 * wired to"; the tracker keeps "where am I" answered while you surf.
 *
 * Rendering is imperative rebuild-from-scratch on every model change, as the
 * app did it: the lists are short and the code stays one function per list.
 * The dossier reads the model synchronously — the cache already has the
 * fields — so there is no second render to guard.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ZoomInPlugin from "../main";
import type { DomainView, NoteView, ProjectView } from "../model";
import { labelFor } from "../model";
import { GraphRenderer } from "./renderer";
import { isDarkTheme } from "./graph-view";
import { checkbox, discloseButton, el, emptyNote, errorMessage, iconButton, row, shapeDot, swatch, tag, toast } from "./ui";

export const VIEW_PANEL = "zoomin-panel";

// The project list is ranked, and the tail is almost never what you came for.
// Showing a head keeps the panel readable; the rest is one click away.
const PROJECT_HEAD = 20;

// Which domains are folded open, and which priority rows are opened up. Both
// are per-viewer convenience; nothing depends on them surviving. Empty by
// default: a domain's member list opens only once you ask for it, so the
// panel is a scannable list of names on first load.
export const DOMAIN_OPEN_KEY = "zoomin.open-domains";
export const PRIORITY_OPEN_KEY = "zoomin.priority-domains-open";

// Whether the panel is showing the map instead of the sections. Per device:
// it is a property of this screen's arrangement, like a fold.
export const TRACKER_KEY = "zoomin.tracker";

export class PanelView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private projectLimit = PROJECT_HEAD;
  private projectFilter: "all" | "none" = "all";
  private domainOpen: Record<string, true> = {};
  private priorityOpen: Record<string, true> = {};
  sectionsEl: HTMLElement | null = null;
  /** The sections' head. The tracker carries its own, so this one steps
   *  aside while the map is up — two "ZoomIn"s was one too many. */
  private sectionsHead: HTMLElement | null = null;
  private dossierRenderer: DossierRenderer | null = null;
  private tracking = false;
  /** The user's standing choice (persisted): the map in the sidebar while reading. */
  private preferred = false;
  /** Whether a note is being read — the tracker's home ground. */
  private editorActive = true;
  private trackerRoot: HTMLElement | null = null;
  private trackerHost: HTMLElement | null = null;
  private tracker: GraphRenderer | null = null;
  private lastTracked: string | null = null;
  private els: {
    slotSummary: HTMLElement;
    priorityEmpty: HTMLElement;
    priorityProjectsGroup: HTMLElement;
    priorityProjects: HTMLElement;
    priorityDomainsGroup: HTMLElement;
    priorityDomains: HTMLElement;
    domainName: HTMLInputElement;
    domainsEmpty: HTMLElement;
    domainList: HTMLElement;
    unassignedBox: HTMLInputElement;
    unassignedCount: HTMLElement;
    filterNote: HTMLElement;
    projectsEmpty: HTMLElement;
    projectList: HTMLElement;
    projectMore: HTMLButtonElement;
  } | null = null;

  constructor(leaf: WorkspaceLeaf, readonly plugin: ZoomInPlugin) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_PANEL;
  }

  getDisplayText(): string {
    return "ZoomIn";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    const local = this.plugin.local;
    this.domainOpen = local.idSet(DOMAIN_OPEN_KEY);
    this.priorityOpen = local.idSet(PRIORITY_OPEN_KEY);
    this.preferred = local.flag(TRACKER_KEY);
    this.tracking = this.preferred;

    const root = this.contentEl;
    root.empty();
    root.addClass("zoomin-view", "zoomin-panel");
    this.build(root);
    this.buildTracker(root);
    this.dossierRenderer = new DossierRenderer(this);
    this.unsubscribe = this.plugin.model.onChange((structural) => this.render(structural));
    this.render();
  }

  /** Called by the plugin after a lens move; the model subscription would
   *  not fire, because a lens is a view, not a model change. */
  refreshFocus(): void {
    this.render();
  }

  onResize(): void {
    this.tracker?.resize();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.els = null;
    this.sectionsEl = null;
    this.dossierRenderer = null;
    this.tracker?.destroy();
    this.tracker = null;
    this.contentEl.empty();
  }

  /* --- skeleton ----------------------------------------------------------- */

  private build(root: HTMLElement): void {
    const head = root.createDiv({ cls: "zoomin-panel-head" });
    this.sectionsHead = head;
    const line = head.createDiv({ cls: "zoomin-head-line" });
    line.createEl("h2", { text: "ZoomIn" });
    const datatypes = line.createEl("button", { cls: "zoomin-ghost", text: "Datatypes", attr: { type: "button" } });
    datatypes.onclick = () => this.plugin.openDatatypes();
    const map = line.createEl("button", {
      cls: "zoomin-ghost",
      attr: { type: "button", "aria-label": "Show the map here", title: "Show the map here" },
    });
    setIcon(map, "map");
    map.onclick = () => this.setTrackerMode(true);

    // Priorities.
    const priorities = root.createEl("section", { cls: "zoomin-section" });
    const ph = priorities.createEl("h3", { text: "Priorities " });
    const slotSummary = ph.createSpan({ cls: "zoomin-slot-summary" });
    const priorityEmpty = priorities.createEl("p", {
      cls: "zoomin-hint",
      text: "Nothing prioritised yet, so the whole map reads at full strength. Star a domain to bring it forward and let the rest recede.",
    });
    const priorityProjectsGroup = priorities.createDiv({ cls: "zoomin-priority-group" });
    priorityProjectsGroup.createEl("h4", { cls: "zoomin-group-label", text: "Projects" });
    const priorityProjects = priorityProjectsGroup.createEl("ul", { cls: "zoomin-list" });
    const priorityDomainsGroup = priorities.createDiv({ cls: "zoomin-priority-group" });
    priorityDomainsGroup.createEl("h4", { cls: "zoomin-group-label", text: "Domains" });
    const priorityDomains = priorityDomainsGroup.createEl("ul", { cls: "zoomin-list" });

    // Domains.
    const domains = root.createEl("section", { cls: "zoomin-section" });
    domains.createEl("h3", { text: "Your domains" });
    const newDomain = domains.createDiv({ cls: "zoomin-new-domain" });
    const domainName = newDomain.createEl("input", {
      attr: { type: "text", placeholder: "Name a domain", spellcheck: "false", autocomplete: "off", "aria-label": "New domain name" },
    });
    const add = newDomain.createEl("button", { cls: "zoomin-ghost", text: "Add", attr: { type: "button" } });
    add.onclick = () => this.createDomain();
    domainName.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.createDomain();
      }
    };
    const domainsEmpty = domains.createEl("p", {
      cls: "zoomin-hint",
      text: "No domains yet. A domain is a region of your life, not a note — name it the way you'd say it out loud, then give it projects below.",
    });
    const domainList = domains.createEl("ul", { cls: "zoomin-list" });

    // Projects.
    const projects = root.createEl("section", { cls: "zoomin-section" });
    projects.createEl("h3", { text: "Projects" });
    const filterRow = projects.createDiv({ cls: "zoomin-filter-row" });
    const filterLabel = filterRow.createEl("label", { cls: "zoomin-check-label" });
    const unassignedBox = filterLabel.createEl("input", { attr: { type: "checkbox" } });
    filterLabel.appendText(" Unassigned only ");
    const unassignedCount = filterLabel.createSpan({ cls: "zoomin-count" });
    unassignedBox.onchange = () => {
      this.projectFilter = unassignedBox.checked ? "none" : "all";
      this.projectLimit = PROJECT_HEAD;
      this.renderProjects();
    };
    projects.createEl("p", {
      cls: "zoomin-hint",
      text: "Ranked by how much of your vault hangs off them. Put the ones that belong to a domain into it; a project can sit in only one.",
    });
    const filterNote = projects.createEl("p", { cls: "zoomin-hint" });
    const projectsEmpty = projects.createEl("p", { cls: "zoomin-hint" });
    const projectList = projects.createEl("ul", { cls: "zoomin-list" });
    const projectMore = projects.createEl("button", { cls: "zoomin-linkish zoomin-more", attr: { type: "button" } });
    projectMore.onclick = () => {
      this.projectLimit = Infinity;
      this.renderProjects();
    };

    this.els = {
      slotSummary, priorityEmpty, priorityProjectsGroup, priorityProjects, priorityDomainsGroup,
      priorityDomains, domainName, domainsEmpty, domainList, unassignedBox, unassignedCount, filterNote,
      projectsEmpty, projectList, projectMore,
    };
    this.sectionsEl = root.createDiv({ cls: "zoomin-sections" });
    // Re-parent the three panels under a wrapper the dossier can step aside.
    for (const section of [priorities, domains, projects]) this.sectionsEl.appendChild(section);
  }

  /* --- actions ------------------------------------------------------------ */

  private act(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      toast(errorMessage(error));
      // The control may be left showing a choice the model refused; put it back.
      this.render();
    }
  }

  private createDomain(): void {
    const input = this.els!.domainName;
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    this.act(() => {
      this.plugin.model.createDomain(name);
      input.value = "";
      input.focus(); // naming several in a row should not need the mouse
    });
  }

  private starButton(kind: "domain" | "project", id: string, selected: boolean): HTMLButtonElement {
    const title = selected ? "Remove from priorities" : "Make a priority";
    const button = iconButton("zoomin-star", selected ? "★" : "☆", title, () => {
      this.act(() => this.plugin.model.setSlot(kind, id, !selected));
    });
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    return button;
  }

  private editButton(domain: DomainView): HTMLButtonElement {
    return iconButton("zoomin-icon", "✎", "Edit domain — rename and assign projects", () => this.plugin.openDomain(domain.id));
  }

  // Deleting a domain drops every assignment under it and there is no undo, so
  // the button asks once rather than acting on a stray click.
  private deleteButton(domain: DomainView): HTMLButtonElement {
    const button = el("button", "zoomin-icon danger", "×");
    button.type = "button";
    let armed = false;
    let timer: number | null = null;
    const disarm = () => {
      if (timer !== null) window.clearTimeout(timer);
      armed = false;
      button.textContent = "×";
      button.classList.remove("armed");
      button.title = "Delete domain";
      button.setAttribute("aria-label", "Delete domain " + domain.name);
    };
    disarm();
    button.onclick = () => {
      if (!armed) {
        armed = true;
        button.textContent = "Delete?";
        button.classList.add("armed");
        button.title = "Click again to delete";
        button.setAttribute("aria-label", "Confirm deleting domain " + domain.name);
        timer = window.setTimeout(disarm, 4000);
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      this.act(() => this.plugin.model.deleteDomain(domain.id));
    };
    return button;
  }

  /* --- rendering ---------------------------------------------------------- */

  render(structural = false): void {
    if (!this.els) return;
    // The tracker is a place, not a list: the leaf stops scrolling and the
    // map takes what is left under its head.
    if (this.tracking) this.contentEl.addClass("zoomin-tracking");
    else this.contentEl.removeClass("zoomin-tracking");
    if (this.tracking) {
      this.renderTracker(structural);
      return;
    }
    if (this.plugin.focusId !== null) {
      this.sectionsHead?.show();
      this.dossierRenderer?.render(this.plugin.focusId);
      return;
    }
    this.contentEl.removeClass("zoomin-focusing");
    this.dossierRenderer?.hide();
    this.sectionsHead?.show();
    this.sectionsEl?.show();
    this.renderPriorities();
    this.renderDomains();
    this.renderProjects();
  }

  /* --- the tracker: the map, living in the sidebar ------------------------- */

  /** Whether the panel is showing the map instead of the sections. */
  get trackerMode(): boolean {
    return this.tracking;
  }

  /** The user's toggle: a standing choice to have the map in the sidebar
   *  while reading. Shown at once, whatever the surface; where it lives from
   *  here is setEditorActive's to say. */
  setTrackerMode(on: boolean): void {
    this.preferred = on;
    this.plugin.local.saveFlag(TRACKER_KEY, on);
    this.applyTracking(on);
  }

  /** The plugin reports whether a note is being read. The tracker is a
   *  reading companion: on the map or the dashboard the sections come back,
   *  and returning to a note brings the tracker with you. */
  setEditorActive(active: boolean): void {
    if (this.editorActive === active) return;
    this.editorActive = active;
    this.applyTracking(this.preferred && active);
  }

  private applyTracking(on: boolean): void {
    if (on === this.tracking) return;
    this.tracking = on;
    if (!on) {
      // The tracker's simulation is not worth keeping idle: a fresh one costs
      // nothing and re-seeds from the saved positions.
      this.tracker?.destroy();
      this.tracker = null;
      this.lastTracked = null;
      this.trackerRoot?.hide();
    }
    this.render(true);
  }

  /** The note open in the editor moved; frame it, when we are the tracker. */
  trackPath(path: string): void {
    if (!this.tracking) return;
    this.framePath(path);
  }

  /** The plugin noticed a theme change; the tracker cannot see it itself. */
  retint(): void {
    this.tracker?.setDark(isDarkTheme());
  }

  private renderTracker(structural: boolean): void {
    this.contentEl.removeClass("zoomin-focusing");
    this.dossierRenderer?.hide();
    this.sectionsHead?.hide();
    this.sectionsEl?.hide();
    this.trackerRoot?.show();
    if (!this.trackerHost) return;
    if (!this.tracker) {
      // A host the environment cannot draw on (tests, exotic shells) must not
      // take the mode down with it: probe before handing the host over.
      if (!document.createElement("canvas").getContext("2d")) return;
      try {
        this.tracker = new GraphRenderer(this.trackerHost, {
          dark: isDarkTheme(),
          // No hover card, no position saves, no background click: the tracker
          // is a place, not a second dashboard. A node click is where you go:
          // you are already in the editor, so the map is the way you move.
          onSelect: (node) => this.plugin.openNote(node.id),
        });
        this.tracker.setFilter({});
        this.tracker.setData(this.plugin.model.payload());
      } catch {
        this.tracker = null;
        return;
      }
      // The leaf may not have been measured when the data landed.
      requestAnimationFrame(() => this.tracker?.resize());
    }
    if (structural) this.tracker.setData(this.plugin.model.payload());
    else this.tracker.applyFocus(this.plugin.model.payload());
    this.trackActive(true);
  }

  /** Frame the note being read. */
  private trackActive(force: boolean): void {
    const file = this.plugin.app?.workspace.getActiveFile?.() ?? null;
    if (file) this.framePath(file.path, force);
  }

  private framePath(path: string, force = false): void {
    if (!this.tracker || (path === this.lastTracked && !force)) return;
    this.lastTracked = path;
    // The lens treatment: where you are is lit, its neighbourhood with it,
    // everything else receding — "you are here", said the map's own way.
    this.tracker.setFocus(path);
    this.tracker.centerOnNode(path);
  }

  private buildTracker(root: HTMLElement): void {
    const rootEl = root.createDiv({ cls: "zoomin-tracker" });
    rootEl.hide();
    const line = rootEl.createDiv({ cls: "zoomin-head-line zoomin-tracker-head" });
    line.createEl("h2", { text: "ZoomIn" });
    const back = line.createEl("button", {
      cls: "zoomin-ghost",
      attr: { type: "button", "aria-label": "Back to priorities", title: "Back to priorities" },
    });
    setIcon(back, "list-tree");
    back.onclick = () => this.setTrackerMode(false);
    this.trackerHost = rootEl.createDiv({ cls: "zoomin-tracker-map" });
    this.trackerRoot = rootEl;
  }

  private inheritedTag(project: { inherited: boolean; path: string }, domainName: string) {
    if (!project.inherited) return null;
    return { text: "inherited", title: "In " + domainName + " because " + this.parentLabel(project.path) + " is." };
  }

  private parentLabel(path: string): string {
    const parent = this.plugin.model.hierarchy.parentOf.get(path);
    if (!parent) return "its parent";
    return this.plugin.model.snapshot.notes.get(parent)?.title ?? labelFor(parent);
  }

  // The members of a domain, as shown under it and under a priority slot.
  // Read-only in both places: filing happens in the dialog.
  private memberList(domain: DomainView, controlsFor: ((project: DomainView["projects"][number]) => HTMLElement[]) | null): HTMLUListElement {
    const nested = el("ul", "zoomin-list");
    for (const project of domain.projects) {
      nested.appendChild(
        row(project.label, {
          nested: true,
          hue: domain.hue,
          tag: this.inheritedTag(project, domain.name),
          count: project.size ? String(project.size) : "",
          onLabelClick: () => this.plugin.zoomToNote(project.path),
          controls: controlsFor ? controlsFor(project) : [],
        }),
      );
    }
    if (!domain.projects.length) nested.appendChild(emptyNote("Nothing assigned yet."));
    return nested;
  }

  // What's actively being worked on under a priority project — a glance-level
  // answer to "what should I actually touch today" without opening the graph.
  private exploringList(entries: { path: string; label: string; shape: string | null }[], hue: number | null): HTMLUListElement {
    const nested = el("ul", "zoomin-list");
    for (const entry of entries) {
      nested.appendChild(
        row(entry.label, { nested: true, dotIcon: shapeDot(entry.shape, hue), onLabelClick: () => this.plugin.zoomToNote(entry.path) }),
      );
    }
    if (!entries.length) nested.appendChild(emptyNote("Nothing exploring right now."));
    return nested;
  }

  private renderPriorities(): void {
    const e = this.els!;
    const model = this.plugin.model;
    const priorities = model.priorities();
    const domains = model.domains();
    const projects = model.projects();
    const domainById = (id: string | null) => domains.find((d) => d.id === id) ?? null;
    const local = this.plugin.local;

    e.slotSummary.setText(`${priorities.domains.length}/${priorities.domainSlots} · ${priorities.projects.length}/${priorities.projectSlots}`);
    e.priorityProjects.empty();
    e.priorityDomains.empty();
    e.priorityEmpty.toggle(priorities.domains.length + priorities.projects.length === 0);
    e.priorityProjectsGroup.toggle(priorities.projects.length > 0);
    e.priorityDomainsGroup.toggle(priorities.domains.length > 0);
    e.priorityDomainsGroup.classList.toggle("after-projects", priorities.projects.length > 0 && priorities.domains.length > 0);

    for (const path of priorities.projects) {
      const project = projects.find((p) => p.path === path) ?? null;
      const owner = project ? domainById(project.domainId) : null;
      const openKey = "proj:" + path;
      const entries = priorities.exploring[path] ?? [];
      const open = !!this.priorityOpen[openKey];
      const details = this.exploringList(entries, owner ? owner.hue : null);
      details.toggle(open);
      const label = project ? project.label : labelFor(path);
      const item = row(label, {
        hue: owner ? owner.hue : null,
        count: owner ? owner.name : "",
        title: owner ? path + " — in " + owner.name : path,
        onLabelClick: project ? () => this.plugin.zoomToNote(path) : null,
        leading: [
          discloseButton(open, "Show what is exploring under " + label, (button) => {
            local.toggleIn(PRIORITY_OPEN_KEY, this.priorityOpen, openKey);
            const nowOpen = !!this.priorityOpen[openKey];
            button.setAttribute("aria-expanded", nowOpen ? "true" : "false");
            details.toggle(nowOpen);
          }),
        ],
        controls: [this.starButton("project", path, true)],
      });
      item.appendChild(details);
      e.priorityProjects.appendChild(item);
    }

    for (const id of priorities.domains) {
      const domain = domainById(id);
      if (!domain) {
        e.priorityDomains.appendChild(row(id, { count: "missing", controls: [this.starButton("domain", id, true)] }));
        continue;
      }
      const open = !!this.priorityOpen[id];
      const members = this.memberList(domain, null);
      members.toggle(open);
      const item = row(domain.name, {
        hue: domain.hue,
        count: domain.projects.length ? String(domain.projects.length) : "",
        title: "Zoom to " + domain.name + " on the map",
        onLabelClick: () => this.plugin.zoomToDomain(domain.id),
        leading: [
          discloseButton(open, "Show what is in " + domain.name, (button) => {
            local.toggleIn(PRIORITY_OPEN_KEY, this.priorityOpen, id);
            const nowOpen = !!this.priorityOpen[id];
            button.setAttribute("aria-expanded", nowOpen ? "true" : "false");
            members.toggle(nowOpen);
          }),
        ],
        controls: [this.editButton(domain), this.starButton("domain", id, true)],
      });
      item.appendChild(members);
      e.priorityDomains.appendChild(item);
    }
  }

  private renderDomains(): void {
    const e = this.els!;
    const model = this.plugin.model;
    const priorities = model.priorities();
    const domains = model.domains();
    const local = this.plugin.local;
    e.domainList.empty();
    e.domainsEmpty.toggle(domains.length === 0);

    for (const domain of domains) {
      const collapsed = !this.domainOpen[domain.id];
      const members = this.memberList(domain, (project) => [
        this.starButton("project", project.path, priorities.projects.includes(project.path)),
        iconButton("zoomin-icon", "−", "Remove from this domain", () => this.act(() => model.assign(project.path, null))),
      ]);
      members.toggle(!collapsed);
      const item = row(domain.name, {
        hue: domain.hue,
        count: domain.projects.length ? String(domain.projects.length) : "",
        title: "Zoom to " + domain.name + " on the map",
        onLabelClick: () => this.plugin.zoomToDomain(domain.id),
        leading: [
          discloseButton(!collapsed, "Show the projects in " + domain.name, (button) => {
            local.toggleIn(DOMAIN_OPEN_KEY, this.domainOpen, domain.id);
            const open = !!this.domainOpen[domain.id];
            button.setAttribute("aria-expanded", open ? "true" : "false");
            members.toggle(open);
          }),
        ],
        controls: [this.editButton(domain), this.starButton("domain", domain.id, priorities.domains.includes(domain.id)), this.deleteButton(domain)],
      });
      item.appendChild(members);
      e.domainList.appendChild(item);
    }
  }

  private renderProjects(): void {
    const e = this.els!;
    const model = this.plugin.model;
    const projects = model.projects();
    const domains = model.domains();
    const slotted = model.priorities().projects;
    const unassigned = projects.filter((p) => !p.domainId);
    const visible: ProjectView[] = this.projectFilter === "none" ? unassigned : projects;
    const filtering = this.projectFilter !== "all";

    e.unassignedBox.checked = filtering;
    // Always shown, zero included: "(0)" says everything is filed, whereas a
    // blank space just reads as a control that failed to render.
    e.unassignedCount.setText("(" + unassigned.length + ")");
    e.projectList.empty();

    e.projectsEmpty.toggle(visible.length === 0);
    e.projectsEmpty.setText(
      !projects.length ? "No projects in this vault yet." : filtering ? "Every project is filed in a domain." : "No projects in this vault yet.",
    );
    e.filterNote.toggle(filtering);
    if (filtering) e.filterNote.setText(visible.length + " unassigned of " + projects.length + " projects.");

    for (const project of visible.slice(0, this.projectLimit)) {
      const owner = domains.find((d) => d.id === project.domainId) ?? null;
      const item = row(project.label, {
        hue: owner ? owner.hue : null,
        title: project.path,
        tag: owner ? this.inheritedTag(project, owner.name) : null,
        count: project.size ? String(project.size) : "",
        onLabelClick: () => this.plugin.zoomToNote(project.path),
        controls: [this.starButton("project", project.path, slotted.includes(project.path))],
      });

      const field = el("div", "zoomin-assign");
      field.appendChild(el("label", "zoomin-assign-label", "Domain"));
      const select = el("select", "zoomin-assign-select");
      select.setAttribute("aria-label", "Domain for " + project.label);
      const none = el("option", null, "Unassigned");
      none.value = "";
      select.appendChild(none);
      for (const domain of domains) {
        const option = el("option", null, domain.name);
        option.value = domain.id;
        select.appendChild(option);
      }
      select.value = project.domainId ?? "";
      select.onchange = () => this.act(() => model.assign(project.path, select.value || null));
      field.appendChild(select);
      item.appendChild(field);
      e.projectList.appendChild(item);
    }

    const remaining = visible.length - Math.min(this.projectLimit, visible.length);
    e.projectMore.toggle(remaining > 0);
    if (remaining > 0) e.projectMore.setText("Show " + remaining + " more");
  }
}

/* --- the dossier, as a mode of this panel ----------------------------------- */
//
// One note under the lens: what it is, where it sits, what it is wired to.
// Fields that can be changed are controls; the rest is read from the vault.
// Everything comes from the model synchronously — the cache already has the
// fields — so the dossier renders once, not twice.

function dossierStatusLabel(status: number): string {
  return ["Set status", "Unexplored", "Exploring", "Explored"][status || 0];
}

// A value with an optional "clear" beside it, for fields that can be empty.
function clearable(control: HTMLElement, onClear: (() => void) | null, title: string): HTMLElement {
  const wrap = el("div", "zoomin-field-value");
  wrap.appendChild(control);
  if (onClear) wrap.appendChild(iconButton("zoomin-icon", "×", title, onClear));
  return wrap;
}

class DossierRenderer {
  private dossierEl: {
    root: HTMLElement;
    eyebrow: HTMLElement;
    title: HTMLElement;
    desc: HTMLElement;
    open: HTMLButtonElement;
    fields: HTMLElement;
    kids: HTMLElement;
    out: HTMLElement;
    in: HTMLElement;
    count: HTMLElement;
  } | null = null;

  constructor(private readonly panel: PanelView) {}

  /** Leaving the lens: the dossier goes away entirely, not just the sections
   *  coming back — it is a mode, not a section that waits below the fold. */
  hide(): void {
    this.dossierEl?.root.hide();
  }

  render(id: string): void {
    const plugin = this.panel.plugin;
    const model = plugin.model;
    const info = model.nodeInfo(id);
    if (!info) {
      plugin.exitFocus();
      return;
    }
    const note = model.snapshot.notes.has(id) ? model.note(id) : null;
    const phantom = info.kind !== 0;
    const colour = swatch(info.hue);

    this.panel.contentEl.addClass("zoomin-focusing");
    this.panel.sectionsEl?.hide();
    if (!this.dossierEl) this.build(this.panel.contentEl);
    const d = this.dossierEl!;
    d.root.show();
    // The hue washes the top of the panel, the same colour the halo wears on
    // the map: one note, one colour, in both places.
    d.root.style.setProperty("--hue", colour || "var(--ink-faint)");

    // What it is: the category the note itself declares, whether or not a
    // shape was ever given to it; "note" only when it says nothing.
    const declared = note && note.categories.length ? note.categories[0] : info.datatype >= 0 ? model.payload().datatypes[info.datatype].name : null;
    d.eyebrow.textContent = "";
    const parts = [phantom ? "unwritten" : declared || "note"];
    if (info.domainLabel) parts.push(info.domainLabel);
    parts.forEach((text, i) => {
      if (i) d.eyebrow.appendChild(el("span", "zoomin-sep", "·"));
      d.eyebrow.appendChild(el("span", null, text));
    });

    d.title.setText(info.label);
    d.desc.setText(note?.description ?? "");
    d.desc.toggle(!!(note && note.description));
    d.open.toggle(!phantom);
    if (!phantom) d.open.onclick = () => plugin.openNote(id);

    const fields = d.fields;
    fields.textContent = "";
    const add = (label: string, control: HTMLElement) => {
      fields.appendChild(el("dt", null, label));
      const dd = el("dd");
      dd.appendChild(control);
      fields.appendChild(dd);
    };

    if (!phantom && note) {
      // Status: the same chip as the hover card, and the same write.
      const status = el("button", "zoomin-card-status s" + (info.status || 0), dossierStatusLabel(info.status));
      status.type = "button";
      status.title = "Click to cycle";
      status.onclick = async () => {
        status.disabled = true;
        await plugin.cycleStatus(id);
        status.disabled = false;
      };
      add("Status", status);

      // Parent: a picker over every written note, and a clear.
      const parent = el("button", "zoomin-field-button", note.parent ? note.parent.label : "None");
      parent.type = "button";
      parent.title = note.parent ? note.parent.path + " — click to change" : "Choose a parent";
      parent.onclick = () => plugin.pickParent(id);
      add("Parent", clearable(parent, note.parent ? () => this.edit("parent", null) : null, "Remove parent"));

      // Domain is derived from the parent chain, so it is read, never set.
      const dom = el("div", "zoomin-field-static");
      const dot = el("span", "zoomin-dot");
      if (colour) dot.style.background = colour;
      dom.appendChild(dot);
      dom.appendChild(el("span", null, note.domain ? note.domain.name : "Unfiled"));
      if (!note.domain) dom.title = "File this note's parent under a domain to colour it.";
      add("Domain", dom);

      // Datatype: the category, from the vault's own vocabulary.
      const select = el("select", "zoomin-assign-select");
      select.setAttribute("aria-label", "Datatype");
      const noneOption = el("option", null, "None");
      noneOption.value = "";
      select.appendChild(noneOption);
      const seen = new Set<string>();
      for (const cat of model.categories()) {
        const option = el("option", null, cat.name);
        option.value = cat.name;
        seen.add(cat.name.toLowerCase());
        select.appendChild(option);
      }
      const current = note.categories.length ? note.categories[0] : info.datatype >= 0 ? model.payload().datatypes[info.datatype].name : "";
      if (current && !seen.has(current.toLowerCase())) {
        const extra = el("option", null, current);
        extra.value = current;
        select.appendChild(extra);
      }
      select.value = current || "";
      select.onchange = () => this.edit("category", select.value || null);
      add("Datatype", select);

      // Deadline: the calendar, or nothing.
      const date = el("input", "zoomin-field-date");
      date.type = "date";
      date.setAttribute("aria-label", "Deadline");
      date.value = note.deadline ?? "";
      date.onchange = () => {
        if (date.value) this.edit("deadline", date.value);
      };
      add("Deadline", clearable(date, note.deadline ? () => this.edit("deadline", null) : null, "Clear deadline"));

      // Project-ness: one button that flips it. Three sources can answer (your
      // ruling, the datatype's flag, children) and the flip writes a ruling —
      // except when the answer it wants is what the automatic sources already
      // give, in which case it clears the ruling instead, so a note is never
      // pinned to what the tree would have said anyway.
      const box = el("div", "zoomin-field-project");
      const flip = el("button", "zoomin-field-button", note.project.is ? "Remove from projects" : "Make a project");
      flip.type = "button";
      flip.onclick = () => {
        const want = !note.project.is;
        const value = want === note.project.automatic ? null : want;
        try {
          const result = model.setProjectOverride(id, value);
          if (result.slotCleared) toast("Removed from projects — its priority slot is free again", "ok");
        } catch (error) {
          toast(errorMessage(error));
        }
      };
      box.appendChild(flip);
      add("Project", box);
    }

    // Links, both ways. A hierarchy edge is named for what it means from
    // here: the note this one hangs off, or a note that hangs off this one.
    // The children come first, as their own question — "what is filed under
    // this" — before the raw neighbourhood; the lists below stay the full
    // link set the map draws, so the count and the sections can't disagree.
    const links = model.neighbours(id);
    const sort = (a: { path: string; kind: number }, b: { path: string; kind: number }) => {
      const la = model.nodeInfo(a.path), lb = model.nodeInfo(b.path);
      return b.kind - a.kind || (la && lb ? la.label.localeCompare(lb.label, undefined, { sensitivity: "base" }) : 0);
    };
    this.fill(d.kids, model.childrenOf(id).map((path) => ({ path, kind: 1 })), null);
    this.fill(d.out, links.out.sort(sort), "parent");
    this.fill(d.in, links.in.sort(sort), "child");
    d.count.setText(String(links.out.length + links.in.length) || "");
  }

  private fill(list: HTMLElement, entries: { path: string; kind: number }[], hierarchyWord: string | null): void {
    const model = this.panel.plugin.model;
    list.textContent = "";
    for (const entry of entries) {
      const other = model.nodeInfo(entry.path);
      if (!other) continue;
      const shape = other.datatype >= 0 ? model.payload().datatypes[other.datatype].shape : null;
      list.appendChild(
        row(other.label, {
          dotIcon: shapeDot(shape, other.hue),
          title: entry.path,
          // A word per hierarchy edge ("parent"/"child") only where the
          // section title does not already say it: every row of the direct
          // children list is a child by definition.
          tag: entry.kind === 1 && hierarchyWord ? { text: hierarchyWord } : other.kind !== 0 ? { text: "unwritten" } : null,
          onLabelClick: () => this.panel.plugin.enterFocus(entry.path),
        }),
      );
    }
    if (!entries.length) {
      const blank = el("li");
      blank.appendChild(el("div", "zoomin-row zoomin-empty-note", "Nothing."));
      list.appendChild(blank);
    }
  }

  private edit(field: "parent" | "category" | "deadline", value: string | null): void {
    const id = this.panel.plugin.focusId;
    if (!id) return;
    void this.panel.plugin.model
      .editNote(id, field, value)
      .then(() => this.panel.render())
      .catch((error) => {
        toast(errorMessage(error));
        this.panel.render();
      });
  }

  private build(root: HTMLElement): void {
    const d = root.createDiv({ cls: "zoomin-dossier", attr: { "aria-live": "polite" } });
    d.hide();
    const bar = d.createDiv({ cls: "zoomin-dossier-bar" });
    const back = bar.createEl("button", { cls: "zoomin-linkish zoomin-back", text: "← Back to the map", attr: { type: "button" } });
    back.onclick = () => this.panel.plugin.exitFocus();
    const open = bar.createEl("button", { cls: "zoomin-ghost", text: "Open ↗", attr: { type: "button" } });
    open.title = "Open this note in the editor";
    const eyebrow = d.createEl("p", { cls: "zoomin-dossier-eyebrow" });
    const title = d.createEl("h2", { cls: "zoomin-dossier-title" });
    const desc = d.createEl("p", { cls: "zoomin-dossier-desc" });
    const fields = d.createEl("dl", { cls: "zoomin-dossier-fields" });
    const links = d.createEl("section", { cls: "zoomin-dossier-links" });
    const count = links.createEl("h3", { text: "Links " }).createSpan({ cls: "zoomin-slot-summary" });
    links.createEl("h4", { cls: "zoomin-group-label", text: "Direct children" });
    const kids = links.createEl("ul", { cls: "zoomin-list" });
    links.createEl("h4", { cls: "zoomin-group-label", text: "Points to" });
    const out = links.createEl("ul", { cls: "zoomin-list" });
    links.createEl("h4", { cls: "zoomin-group-label", text: "Pointed at by" });
    const inn = links.createEl("ul", { cls: "zoomin-list" });
    this.dossierEl = { root: d, eyebrow, title, desc, open, fields, kids, out, in: inn, count };
  }
}
