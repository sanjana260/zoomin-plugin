/**
 * The dashboard: what to do next, as three lists.
 *
 * Focus is the slotted project's own to-dos, washed in its domain's hue; the
 * middle is everything exploring under the priority domains, one chip per
 * domain above it; the right is the deadline feed, the calendar's order,
 * never the user's. The view never scrolls; each region does.
 *
 * Checking a box writes `status: Explored` (or back to `Exploring`) — a set,
 * which cascades to the subtree, as on the map. The row stays struck through
 * until the next render rather than vanishing, so a mis-click is undoable.
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ZoomInPlugin from "../main";
import type { FocusBox, TaskRow } from "../model";
import type { TasksModelView as TasksData } from "../model";
import { checkbox, discloseButton, el, errorMessage, shapeDot, swatch, toast } from "./ui";

export const VIEW_TASKS = "zoomin-tasks";

const TASK_DOMAINS_HIDDEN_KEY = "zoomin.task-domains-hidden";
/** Which focus boxes show their underside — unexplored work and raw material. */
const FOCUS_OPEN_KEY = "zoomin.focus-open";

/** "3d", "today", "overdue 2d": the number is what you scan for, so it leads. */
function dueLabel(row: TaskRow): string {
  if (row.days === null) return "";
  if (row.days < 0) return "overdue " + -row.days + "d";
  if (row.days === 0) return "today";
  if (row.days === 1) return "tomorrow";
  return row.days + "d";
}

export class TasksView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private taskDomainsHidden: Record<string, true> = {};
  private focusOpen: Record<string, true> = {};
  /** Set while a tick's own model change is in flight, so the row stays
   *  struck instead of the whole list re-rendering under the pointer. */
  private holdRender = false;
  private els: {
    focusBoxes: HTMLElement;
    focusEmpty: HTMLElement;
    chips: HTMLElement;
    domainTasks: HTMLElement;
    domainEmpty: HTMLElement;
    deadlineTasks: HTMLElement;
    deadlineEmpty: HTMLElement;
  } | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ZoomInPlugin) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TASKS;
  }

  getDisplayText(): string {
    return "ZoomIn tasks";
  }

  getIcon(): string {
    return "check-square";
  }

  async onOpen(): Promise<void> {
    this.taskDomainsHidden = this.plugin.local.idSet(TASK_DOMAINS_HIDDEN_KEY);
    this.focusOpen = this.plugin.local.idSet(FOCUS_OPEN_KEY);
    const root = this.contentEl;
    root.empty();
    root.addClass("zoomin-view", "zoomin-tasks");

    const cols = root.createDiv({ cls: "zoomin-task-cols" });
    const main = cols.createDiv({ cls: "zoomin-task-main" });

    const focus = main.createEl("section", { cls: "zoomin-task-col zoomin-task-focus" });
    focus.createEl("h3", { text: "Focus" });
    const focusBoxes = focus.createDiv({ cls: "zoomin-focus-boxes" });
    const focusEmpty = focus.createEl("p", {
      cls: "zoomin-hint",
      text: "No project in a slot. Star one in the sidebar and its exploring tasks land here.",
    });

    const domains = main.createEl("section", { cls: "zoomin-task-col zoomin-task-domains" });
    // Heading and chips pin together while the list scrolls: a filter you
    // have to scroll back up to reach is half a filter.
    const head = domains.createDiv({ cls: "zoomin-task-head" });
    head.createEl("h3", { text: "Priority domains" });
    const chips = head.createDiv({ cls: "zoomin-chips", attr: { role: "group", "aria-label": "Show domains" } });
    const domainTasks = domains.createEl("ul", { cls: "zoomin-task-list" });
    const domainEmpty = domains.createEl("p", { cls: "zoomin-hint" });

    // A sidebar to the other two: narrower, ruled off, and not draggable.
    const aside = cols.createEl("aside", { cls: "zoomin-task-col zoomin-task-aside", attr: { "aria-label": "Deadlines" } });
    aside.createEl("h3", { text: "Deadlines" });
    const deadlineTasks = aside.createEl("ul", { cls: "zoomin-task-list" });
    const deadlineEmpty = aside.createEl("p", { cls: "zoomin-hint", text: "No task has a deadline." });

    this.els = { focusBoxes, focusEmpty, chips, domainTasks, domainEmpty, deadlineTasks, deadlineEmpty };
    // The domain list persists across renders (only its rows are replaced),
    // so its drag handlers are attached once, here. The focus lists are
    // rebuilt per render and wire their own.
    this.makeSortable(domainTasks, "domains");
    this.unsubscribe = this.plugin.model.onChange(() => {
      if (!this.holdRender) this.render();
    });
    // The feed's tiers are computed against today; a leaf left open past
    // midnight re-asks when the user comes back to it.
    this.registerDomEvent(window, "focus", () => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.els = null;
    this.contentEl.empty();
  }

  /* --- rows --------------------------------------------------------------- */

  private async setTaskStatus(rowEl: HTMLElement, box: HTMLInputElement, row: TaskRow, done: boolean): Promise<void> {
    // Optimistic: the strikethrough lands before the write, and is taken back
    // only if the write fails. The row stays either way — that is what makes
    // a mis-click undoable.
    rowEl.classList.toggle("done", done);
    box.disabled = true;
    this.holdRender = true;
    try {
      await this.plugin.model.setStatus(row.path, done ? "explored" : "exploring");
    } catch (error) {
      rowEl.classList.toggle("done", !done);
      box.checked = !done;
      toast(errorMessage(error));
    } finally {
      box.disabled = false;
      // The model's change event fired while we held the render, so the row
      // keeps its struck state until the next natural render; on failure the
      // catch above already put the checkbox back.
      this.holdRender = false;
    }
  }

  private taskRow(row: TaskRow, options: { draggable?: boolean; showProject?: boolean; checkbox?: boolean }): HTMLLIElement {
    const item = el("li", "zoomin-task-row" + (row.status === "explored" ? " done" : "") + (row.tier ? " tier-" + row.tier : ""));
    item.dataset.path = row.path;
    // The checkbox ring takes the row's own colour: the domain's hue in the
    // working lists, overridden by the tier in the deadline aside.
    const tint = swatch(row.hue);
    if (tint) item.style.setProperty("--hue", tint);

    // The underside's rows carry no checkbox: their one action is the plus —
    // promote it, don't tick it.
    if (options.checkbox !== false) {
      const box = checkbox("zoomin-task-check");
      box.checked = row.status === "explored";
      box.setAttribute("aria-label", "Done: " + row.label);
      box.onchange = () => void this.setTaskStatus(item, box, row, box.checked);
      item.appendChild(box);
    }

    item.appendChild(shapeDot(row.shape, row.hue));

    const label = el("button", "zoomin-task-label", row.label);
    label.type = "button";
    label.title = row.path;
    // A task is a destination, not a lens subject: its own tab, the
    // dashboard left as it stands.
    label.onclick = () => this.plugin.openNoteInNewTab(row.path);
    item.appendChild(label);

    const meta: string[] = [];
    if (options.showProject && row.projectLabel) meta.push(row.projectLabel);
    const metaSpan = el("span", "zoomin-task-meta", meta.join(" · "));
    if (row.deadline) {
      if (meta.length) metaSpan.appendChild(document.createTextNode(" · "));
      metaSpan.appendChild(el("span", "zoomin-task-due", dueLabel(row)));
      metaSpan.title = "Due " + row.deadline;
    }
    if (metaSpan.textContent) item.appendChild(metaSpan);

    if (options.draggable) {
      item.draggable = true;
      item.appendChild(el("span", "zoomin-task-handle", "⋮⋮"));
    }
    return item;
  }

  // Native drag-and-drop, scoped to one list. The list's own key rides along
  // in dataTransfer, so a row dropped on a different list is simply ignored —
  // moving a task between lists has no meaning here.
  private makeSortable(list: HTMLElement, listKey: string): void {
    const line = el("li", "zoomin-drop-line");
    let dragging: HTMLElement | null = null;
    const finish = () => {
      if (dragging) dragging.classList.remove("dragging");
      dragging = null;
      if (line.parentNode) line.parentNode.removeChild(line);
    };

    list.addEventListener("dragstart", (event) => {
      const item = (event.target as HTMLElement).closest(".zoomin-task-row") as HTMLElement | null;
      if (!item) return;
      dragging = item;
      item.classList.add("dragging");
      event.dataTransfer!.effectAllowed = "move";
      event.dataTransfer!.setData("text/plain", listKey);
    });
    list.addEventListener("dragover", (event) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      const over = (event.target as HTMLElement).closest(".zoomin-task-row") as HTMLElement | null;
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      list.insertBefore(line, after ? over.nextSibling : over);
    });
    list.addEventListener("drop", (event) => {
      event.preventDefault();
      if (!dragging || event.dataTransfer!.getData("text/plain") !== listKey) return;
      if (line.parentNode === list) list.insertBefore(dragging, line);
      finish();
      const paths: string[] = [];
      list.querySelectorAll(".zoomin-task-row").forEach((el) => paths.push((el as HTMLElement).dataset.path ?? ""));
      try {
        this.plugin.model.saveTaskOrder(listKey as "domains", paths);
        // What is shown is what was saved: the model applies the saved order,
        // so a render is the truth rather than a bet on the DOM we just moved.
        this.render();
      } catch (error) {
        toast(errorMessage(error));
        this.render();
      }
    });
    list.addEventListener("dragend", finish);
  }

  /* --- rendering ---------------------------------------------------------- */

  render(): void {
    const e = this.els;
    if (!e) return;
    const data: TasksData = this.plugin.model.tasks(new Date());

    // Focus: one box per slotted project, washed in its domain's hue.
    e.focusBoxes.empty();
    e.focusEmpty.toggle(data.focus.length === 0);
    for (const entry of data.focus) {
      e.focusBoxes.appendChild(this.focusBox(entry));
    }

    // Priority domains: one shared list, with a chip per domain above it.
    e.domainTasks.empty();
    for (const row of data.domains) {
      const item = this.taskRow(row, { draggable: true, showProject: true });
      // Hidden, not dropped: the row keeps its place in the DOM so a drag
      // order saved while a domain is filtered out still includes it.
      item.toggle(!this.taskDomainsHidden[row.domainId ?? ""]);
      e.domainTasks.appendChild(item);
    }
    this.renderChips(data);
    const shown = data.domains.filter((row) => !this.taskDomainsHidden[row.domainId ?? ""]).length;
    e.domainEmpty.toggle(shown === 0);
    e.domainEmpty.setText(
      data.domains.length
        ? "Every domain is filtered out."
        : data.focus.length || this.plugin.model.priorities().domains.length
          ? "Nothing exploring under your priority domains."
          : "No priority domains yet. Star one in the sidebar.",
    );

    // Deadlines: the calendar's order, never the user's.
    e.deadlineTasks.empty();
    for (const row of data.deadlines) e.deadlineTasks.appendChild(this.taskRow(row, { showProject: true }));
    e.deadlineEmpty.toggle(data.deadlines.length === 0);
  }

  private focusBox(entry: FocusBox): HTMLElement {
    const box = el("section", "zoomin-focus-box");
    // The hue drives a top-to-bottom wash rather than a border, so the box
    // reads as a lit panel in the domain's colour instead of a framed list.
    const colour = swatch(entry.project.hue);
    if (colour) box.style.setProperty("--hue", colour);

    const open = entry.tasks.filter((t) => t.status !== "explored").length;
    const head = el("div", "zoomin-focus-head");
    // Eyebrow: where this sits and how much is on the board, in the
    // instrument-panel voice; the project's name gets the display size.
    const left = el("div");
    const eyebrow = el("div", "zoomin-focus-eyebrow");
    if (entry.project.domainName) eyebrow.appendChild(el("span", null, entry.project.domainName));
    eyebrow.appendChild(el("span", "zoomin-focus-open", open + " open"));
    left.appendChild(eyebrow);
    left.appendChild(el("h4", "zoomin-focus-title", entry.project.label));
    head.appendChild(left);
    const expanded = !!this.focusOpen[entry.project.path];
    head.appendChild(
      discloseButton(expanded, (expanded ? "Hide" : "Show") + " unexplored work and raw material", () => {
        this.plugin.local.toggleIn(FOCUS_OPEN_KEY, this.focusOpen, entry.project.path);
        this.render();
      }),
    );
    box.appendChild(head);

    const list = el("ul", "zoomin-task-list");
    for (const row of entry.tasks) list.appendChild(this.taskRow(row, { draggable: true }));
    if (!entry.tasks.length) list.appendChild(el("li", "zoomin-hint", "Nothing exploring under " + entry.project.label + "."));
    this.makeSortable(list, "focus:" + entry.project.path);
    box.appendChild(list);

    if (expanded) box.appendChild(this.focusDetailBox(entry));
    return box;
  }

  /**
   * The expanded underside of a focus box: what is not moving yet. Unexplored
   * tasks, then entries and ideas — each with a one-tap promotion to a task,
   * and, when the plugin may create notes, a quick-add that plants a child
   * under the project without leaving the dashboard.
   */
  private focusDetailBox(entry: FocusBox): HTMLElement {
    const model = this.plugin.model;
    const detail = model.focusDetail(entry.project.path, new Date());
    const wrap = el("div", "zoomin-focus-detail");

    // Three columns when the leaf has the room, stacked when it hasn't —
    // auto-fit decides. Each column scrolls on its own, its label pinned
    // above it, so a long ideas list never pushes the quick-add away.
    const groups = el("div", "zoomin-detail-groups");
    const group = (label: string, rows: TaskRow[], dim: boolean): void => {
      if (!rows.length) return;
      const column = el("div", "zoomin-detail-group");
      column.appendChild(el("h5", "zoomin-detail-label", label));
      const list = el("ul", "zoomin-task-list zoomin-detail-list");
      for (const row of rows) list.appendChild(this.detailRow(row, dim));
      column.appendChild(list);
      groups.appendChild(column);
    };
    group("Unexplored", detail.unexplored, true);
    group("Entries", detail.entries, false);
    group("Ideas", detail.ideas, false);
    if (!groups.children.length) {
      wrap.appendChild(el("p", "zoomin-hint", "Nothing unexplored under " + entry.project.label + "."));
    } else {
      wrap.appendChild(groups);
    }

    // Pinned under the columns, whatever their lists are doing.
    if (model.canCreate) wrap.appendChild(this.quickAdd(entry.project.path, entry.project.label));
    return wrap;
  }

  /** A detail row: the dashboard's own row shape, plus the promotion button.
   *  Not draggable — ordering is for work in motion, not material. */
  private detailRow(row: TaskRow, dim: boolean): HTMLLIElement {
    const item = this.taskRow(row, { draggable: false, checkbox: false });
    if (dim) item.addClass("zoomin-task-unexplored");
    const plus = el("button", "zoomin-task-plus");
    plus.type = "button";
    plus.title = "Make this a task — datatype Task, status Exploring";
    plus.setAttribute("aria-label", plus.title);
    setIcon(plus, "plus");
    plus.onclick = () => {
      plus.disabled = true;
      void this.plugin.model
        .promoteToTask(row.path)
        .catch((error) => {
          plus.disabled = false;
          toast(errorMessage(error));
        });
      // The promotion's own change re-renders the dashboard; the row leaves
      // this list without another click.
    };
    item.appendChild(plus);
    return item;
  }

  /** The quick-add: name, optional deadline, optional datatype — a child of
   *  the project, planted in the vault root, Exploring from birth. */
  private quickAdd(projectPath: string, projectLabel: string): HTMLElement {
    const form = el("div", "zoomin-quick-add");
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Add a child to " + projectLabel;
    name.setAttribute("aria-label", "New child note name");
    name.spellcheck = false;
    const due = document.createElement("input");
    due.type = "date";
    due.setAttribute("aria-label", "Deadline (optional)");
    const pick = document.createElement("select");
    pick.setAttribute("aria-label", "Datatype");
    for (const category of this.plugin.model.categories()) {
      const option = document.createElement("option");
      option.value = category.name;
      option.textContent = category.name;
      pick.appendChild(option);
    }
    // The dashboard is made of tasks; default the type to Task when the
    // vault has one, so the common case is type-and-go.
    pick.value = Array.from(pick.options).some((o) => o.value === "Task") ? "Task" : pick.value;
    const add = el("button", "zoomin-ghost", "Add");
    add.type = "button";

    const submit = async (): Promise<void> => {
      if (!name.value.trim()) return;
      add.disabled = true;
      try {
        await this.plugin.model.createChildNote(projectPath, name.value, pick.value || null, due.value || null);
        // The creation's reload re-renders the dashboard with the child in
        // place; this form dies with the render, fresh for the next note.
      } catch (error) {
        add.disabled = false;
        toast(errorMessage(error));
      }
    };
    add.onclick = () => void submit();
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });

    form.appendChild(name);
    form.appendChild(due);
    form.appendChild(pick);
    form.appendChild(add);
    return form;
  }

  // One chip per priority domain: its name, its colour, and how many rows in
  // the list are its. A pressed chip is on; pressing drains the domain out of
  // the list and the colour out of the chip — the same language the map uses.
  private renderChips(data: TasksData): void {
    const e = this.els!;
    e.chips.empty();
    const counts = new Map<string, number>();
    for (const row of data.domains) {
      if (row.domainId) counts.set(row.domainId, (counts.get(row.domainId) ?? 0) + 1);
    }
    const domains = this.plugin.model.priorities().domains;
    for (const id of domains) {
      const domain = this.plugin.model.domains().find((d) => d.id === id);
      if (!domain) continue;
      const on = !this.taskDomainsHidden[id];
      const chip = el("button", "zoomin-chip", domain.name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.title = (on ? "Hide " : "Show ") + domain.name + "'s tasks";
      const colour = swatch(domain.hue);
      if (colour) chip.style.setProperty("--chip", colour);
      chip.appendChild(el("span", "zoomin-chip-count", String(counts.get(id) ?? 0)));
      chip.onclick = () => {
        this.plugin.local.toggleIn(TASK_DOMAINS_HIDDEN_KEY, this.taskDomainsHidden, id);
        this.render();
      };
      e.chips.appendChild(chip);
    }
  }
}
