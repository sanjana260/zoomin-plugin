/**
 * Filing a domain: the whole project tree at once, because what ends up in a
 * domain is decided as much by the tree as by any single checkbox.
 *
 * Every control applies the moment it is touched. The list re-renders on
 * each model change, keeping the scroll and the focused checkbox.
 */

import { App, Modal } from "obsidian";
import type ZoomInPlugin from "../main";
import type { DomainView, ProjectView } from "../model";
import { labelFor } from "../model";
import { checkbox, el, errorMessage, swatch, tag, toast } from "./ui";

export class DomainModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private unassignedFilter = false;
  private focusPath: string | null = null;
  private boxes: Record<string, HTMLInputElement> = {};
  private els: { title: HTMLElement; name: HTMLInputElement; error: HTMLElement; list: HTMLElement; empty: HTMLElement } | null = null;

  constructor(
    app: App,
    private readonly plugin: ZoomInPlugin,
    private readonly domainId: string,
  ) {
    super(app);
  }

  private domain(): DomainView | null {
    return this.plugin.model.domains().find((d) => d.id === this.domainId) ?? null;
  }

  onOpen(): void {
    const domain = this.domain();
    if (!domain) {
      this.close();
      return;
    }
    this.modalEl.addClass("zoomin-view", "zoomin-dialog");
    const { contentEl } = this;
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "zoomin-dialog-head" });
    const title = head.createEl("h2", { text: domain.name });

    const rename = contentEl.createDiv({ cls: "zoomin-dialog-rename" });
    rename.createEl("label", { cls: "zoomin-field-label", text: "Name" });
    const renameRow = rename.createDiv({ cls: "zoomin-rename-row" });
    const name = renameRow.createEl("input", { attr: { type: "text", spellcheck: "false", autocomplete: "off" } });
    name.value = domain.name;
    const renameButton = renameRow.createEl("button", { cls: "zoomin-ghost", text: "Rename", attr: { type: "button" } });
    const error = rename.createEl("p", { cls: "zoomin-error" });
    error.hide();
    renameButton.onclick = () => this.rename();
    name.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.rename();
      }
    };

    contentEl.createEl("p", {
      cls: "zoomin-hint zoomin-dialog-hint",
      text: "Every project in the vault. Ticking one files it here — if it already sits in another domain, that moves it rather than copying it. Subprojects inherit their parent's domain until you say otherwise.",
    });

    const filter = contentEl.createDiv({ cls: "zoomin-dialog-filter" });
    const filterLabel = filter.createEl("label", { cls: "zoomin-check-label" });
    const filterBox = filterLabel.createEl("input", { attr: { type: "checkbox" } });
    filterLabel.appendText(" Unassigned only");
    filterBox.onchange = () => {
      this.unassignedFilter = filterBox.checked;
      this.render();
    };

    const list = contentEl.createEl("ul", { cls: "zoomin-tree zoomin-dialog-projects" });
    const empty = contentEl.createEl("p", { cls: "zoomin-hint", text: "No projects in this vault yet." });

    this.els = { title, name, error, list, empty };
    this.unsubscribe = this.plugin.model.onChange(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.els = null;
    this.contentEl.empty();
  }

  private rename(): void {
    const domain = this.domain();
    if (!domain || !this.els) return;
    const { name: input, error } = this.els;
    const name = input.value.trim();
    if (!name) {
      error.setText("A domain needs a name.");
      error.show();
      input.focus();
      return;
    }
    error.hide();
    if (name === domain.name) return;
    try {
      this.plugin.model.renameDomain(domain.id, name);
      toast("Renamed", "ok");
    } catch (failure) {
      error.setText(errorMessage(failure));
      error.show();
    }
  }

  private assign(path: string, id: string | null): void {
    try {
      this.plugin.model.assign(path, id);
    } catch (failure) {
      toast(errorMessage(failure));
      this.render();
    }
  }

  private parentLabel(project: ProjectView, projects: ProjectView[]): string {
    if (!project.parent) return "its parent";
    const parent = projects.find((p) => p.path === project.parent);
    return parent ? parent.label : labelFor(project.parent);
  }

  // How a project's current membership reads from inside one domain's dialog:
  // nothing to say when it is unassigned or plainly filed here, a note when the
  // tree put it here, and a warning when ticking it would move it out of
  // somewhere else.
  private membershipTag(project: ProjectView, domain: DomainView, projects: ProjectView[], domains: DomainView[]) {
    if (project.domainId === domain.id) {
      return project.inherited
        ? {
            text: "inherited",
            title: "In " + domain.name + " because " + this.parentLabel(project, projects) + " is, not because you filed it. Unticking takes it out for good.",
          }
        : null;
    }
    const owner = domains.find((d) => d.id === project.domainId);
    if (!owner) return null;
    return {
      text: "in " + owner.name + (project.inherited ? " (inherited)" : ""),
      hue: owner.hue,
      title: project.inherited
        ? "Inherited " + owner.name + " from " + this.parentLabel(project, projects) + ". Ticking this moves it to " + domain.name + "."
        : "Filed in " + owner.name + ". Ticking this moves it to " + domain.name + " — a project sits in one domain only.",
    };
  }

  private dialogRow(project: ProjectView, domain: DomainView, projects: ProjectView[], domains: DomainView[]): HTMLElement {
    const line = el("div", "zoomin-tree-row");
    const label = el("label", "zoomin-tree-label");
    const box = checkbox();
    box.checked = project.domainId === domain.id;
    box.onchange = () => {
      // Remember where the user was: answering rebuilds this whole list.
      this.focusPath = project.path;
      box.disabled = true;
      this.assign(project.path, box.checked ? domain.id : null);
    };
    this.boxes[project.path] = box;

    const dot = el("span", "zoomin-dot");
    const owner = domains.find((d) => d.id === project.domainId);
    const colour = swatch(owner ? owner.hue : null);
    if (colour) dot.style.background = colour;

    const name = el("span", "zoomin-tree-name", project.label);
    name.title = project.path;
    label.appendChild(box);
    label.appendChild(dot);
    label.appendChild(name);
    line.appendChild(label);

    const note = this.membershipTag(project, domain, projects, domains);
    if (note) line.appendChild(tag(note.text, note.title, note.hue));
    if (project.size) line.appendChild(el("span", "zoomin-count", String(project.size)));
    return line;
  }

  render(): void {
    if (!this.els) return;
    const domain = this.domain();
    if (!domain) {
      // Deleted from under us — there is nothing left to file into.
      this.close();
      return;
    }
    const { title, name, list, empty } = this.els;
    title.setText(domain.name);
    // Never overwrite a name being typed; a rename elsewhere is not urgent.
    if (document.activeElement !== name) name.value = domain.name;

    const projects = this.plugin.model.projects();
    const domains = this.plugin.model.domains();
    const scroll = list.scrollTop;
    list.empty();
    this.boxes = {};

    // The list arrives in rank order, flat, each row naming its nearest
    // offered ancestor; the dialog wants the shape of the tree, because
    // inheritance is the reason half the memberships exist.
    const known = new Set(projects.map((p) => p.path));
    const children = new Map<string, ProjectView[]>();
    const roots: ProjectView[] = [];
    for (const project of projects) {
      if (project.parent && known.has(project.parent)) {
        const list = children.get(project.parent) ?? [];
        list.push(project);
        children.set(project.parent, list);
      } else {
        roots.push(project);
      }
    }
    // When "unassigned only" is on: show a project if it's unassigned or
    // already in this domain (so you can uncheck it), or if any descendant
    // would show.
    const visible = (project: ProjectView): boolean => {
      if (!this.unassignedFilter) return true;
      if (!project.domainId || project.domainId === domain.id) return true;
      return (children.get(project.path) ?? []).some(visible);
    };
    const seen = new Set<string>();
    const renderTree = (container: HTMLElement, nodes: ProjectView[]) => {
      for (const project of nodes) {
        if (seen.has(project.path)) continue; // `Parent:` is hand-written; a cycle is one typo away
        seen.add(project.path);
        if (!visible(project)) continue;
        const item = el("li");
        item.appendChild(this.dialogRow(project, domain, projects, domains));
        const kids = children.get(project.path) ?? [];
        if (kids.length) {
          const sub = el("ul", "zoomin-tree");
          renderTree(sub, kids);
          item.appendChild(sub);
        }
        container.appendChild(item);
      }
    };
    renderTree(list, roots);
    empty.toggle(projects.length === 0);

    list.scrollTop = scroll;
    const focused = this.focusPath ? this.boxes[this.focusPath] : null;
    if (focused) focused.focus();
    this.focusPath = null;
  }
}
