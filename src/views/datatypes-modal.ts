/**
 * Datatypes: a category gets a shape, and every note carrying it is drawn
 * that way. The list is the vault's own vocabulary, not ours.
 */

import { App, Modal } from "obsidian";
import { SHAPES } from "../graph/build";
import type ZoomInPlugin from "../main";
import type { CategoryView } from "../model";
import { checkbox, el, errorMessage, shapeIcon, shapeLabel, tag, toast } from "./ui";

export class DatatypesModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private list: HTMLElement | null = null;
  private empty: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: ZoomInPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("zoomin-view", "zoomin-dialog");
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createDiv({ cls: "zoomin-dialog-head" });
    head.createEl("h2", { text: "Datatypes" });
    const hint = contentEl.createEl("p", { cls: "zoomin-hint zoomin-dialog-hint" });
    hint.appendText("Give a category a shape and every note with it in its ");
    hint.createEl("code", { text: "categories:" });
    hint.appendText(
      " field is drawn that way, so you can tell a task from a meeting at a glance. Shapes carry the same ink as a circle — a shape says what a note is, never how big it is. Zoom in to tell them apart; far out they are all dots. Tick ",
    );
    hint.createEl("em", { text: "Projects" });
    hint.appendText(
      " and every note with that category counts as a project — filable, slottable — even with nothing hanging off it; a note's own dossier can still say otherwise.",
    );
    this.list = contentEl.createEl("ul", { cls: "zoomin-list zoomin-category-list" });
    const empty = contentEl.createEl("p", { cls: "zoomin-hint" });
    empty.appendText("No categories in this vault yet. ZoomIn reads them from the ");
    empty.createEl("code", { text: "Categories/" });
    empty.appendText(" folder and from what notes actually write.");
    this.empty = empty;
    this.unsubscribe = this.plugin.model.onChange(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.list = null;
    this.empty = null;
    this.contentEl.empty();
  }

  private set(name: string, patch: { shape?: string | null; project?: boolean }): void {
    try {
      this.plugin.model.setDatatype(name, patch);
    } catch (error) {
      toast(errorMessage(error));
      this.render();
    }
  }

  private categoryRow(category: CategoryView): HTMLElement {
    const line = el("div", "zoomin-cat-row");
    const icon = el("span", "zoomin-cat-icon");
    icon.appendChild(shapeIcon(category.shape));
    line.appendChild(icon);
    const name = el("span", "zoomin-cat-name", category.name);
    name.title = category.name;
    line.appendChild(name);

    // A category nothing uses can still be given a shape — it just will not
    // show up anywhere, and saying so beats letting the user wonder.
    if (category.count) line.appendChild(el("span", "zoomin-count", String(category.count)));
    else line.appendChild(tag("unused", "No note in this vault carries this category."));
    if (category.inFolder) line.appendChild(tag("Categories/", "There is a note for this in the Categories folder."));

    // Project flag: every note carrying this category counts as a project,
    // whether or not anything hangs off it — unless a note says otherwise.
    const flag = el("label", "zoomin-check-label zoomin-cat-project");
    const box = checkbox();
    box.checked = category.project;
    box.setAttribute("aria-label", "Notes with " + category.name + " are projects");
    box.onchange = () => {
      box.disabled = true;
      this.set(category.name, { project: box.checked });
    };
    flag.appendChild(box);
    flag.appendChild(document.createTextNode("Projects"));
    flag.title = "Treat every note with this category as a project";
    line.appendChild(flag);

    const select = el("select", "zoomin-assign-select zoomin-shape-select");
    select.setAttribute("aria-label", "Shape for " + category.name);
    const none = el("option", null, "No shape");
    none.value = "";
    select.appendChild(none);
    for (const shape of SHAPES) {
      const option = el("option", null, shapeLabel(shape));
      option.value = shape;
      select.appendChild(option);
    }
    select.value = category.shape ?? "";
    select.onchange = () => this.set(category.name, { shape: select.value || null });
    line.appendChild(select);
    return line;
  }

  render(): void {
    if (!this.list || !this.empty) return;
    const categories = this.plugin.model.categories();
    this.list.empty();
    this.empty.toggle(categories.length === 0);
    for (const category of categories) {
      const item = el("li");
      item.appendChild(this.categoryRow(category));
      this.list.appendChild(item);
    }
  }
}
