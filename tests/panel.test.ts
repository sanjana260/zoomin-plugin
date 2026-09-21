/**
 * The panel, mounted and driven by clicks in jsdom: naming a domain, filing a
 * project into it, starring the project from its row, and the dossier leaving
 * no ghost behind when the lens closes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ZoomInModel, labelFor } from "../src/model";
import { LocalState } from "../src/state/local";
import { Store, emptyStore } from "../src/state/store";
import { PanelView } from "../src/views/panel-view";
import { fakeSource, note } from "./fake-cache";

function harness() {
  const model = new ZoomInModel(
    fakeSource({
      "Work.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
      "Prepay.md": note("Work", { frontmatter: { categories: ["[[Projects]]"] } }),
      "Ship.md": note("Work", { frontmatter: { categories: ["Task"], status: "Exploring" } }),
      "Chess.md": note(null, { frontmatter: { categories: ["[[Projects]]"] } }),
      "Categories/Projects.md": note(),
    }),
    new Store(emptyStore(), () => {}),
  );
  model.caps = { domainSlots: 2, projectSlots: 1 };
  model.reload();
  const saved: Record<string, unknown> = {};
  const local = new LocalState({
    loadLocalStorage: (key: string) => (key in saved ? saved[key] : null),
    saveLocalStorage: (key: string, value: unknown) => {
      saved[key] = value;
    },
  } as never);
  const focus: { id: string | null } = { id: null };
  const plugin = {
    model,
    local,
    settings: { followActiveFile: true },
    get focusId() {
      return focus.id;
    },
    set focusId(value: string | null) {
      focus.id = value;
    },
    openDomain: () => {},
    openDatatypes: () => {},
    zoomToNote: () => {},
    zoomToDomain: () => {},
    enterFocus: () => {},
    // The real exitFocus clears the id and re-renders the panel; mirror it.
    exitFocus: () => {
      focus.id = null;
      view.render();
    },
    cycleStatus: async () => {},
    openNote: () => {},
    pickParent: () => {},
    openSearch: () => {},
  };
  const view = new PanelView({} as never, plugin as never);
  return { model, view, plugin: plugin as never, focus, saved };
}

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  h = harness();
  document.body.appendChild(h.view.contentEl);
  await h.view.onOpen();
});

const q = (selector: string) => h.view.contentEl.querySelector(selector) as HTMLElement;
const qa = (selector: string) => [...h.view.contentEl.querySelectorAll(selector)] as HTMLElement[];

async function createDomain(name: string) {
  const input = q('.zoomin-new-domain input[type="text"]') as HTMLInputElement;
  input.value = name;
  (q(".zoomin-new-domain button") as HTMLButtonElement).click();
}

/** Expand a domain's member list, then click the star on one of its rows. */
function starProjectInDomain(domainName: string, index = 0) {
  const domainRow = qa(".zoomin-section .zoomin-list > li > .zoomin-row").find((el) => el.textContent?.includes(domainName));
  if (!domainRow) throw new Error("domain row not found");
  (domainRow.querySelector(".zoomin-disclose") as HTMLButtonElement).click();
  const rows = [...domainRow.parentElement!.querySelectorAll(".zoomin-row.nested .zoomin-star")];
  (rows[index] as HTMLButtonElement).click();
}

describe("priority projects, driven through the panel", () => {
  it("stars a project from its domain row and lands it in the dashboard's focus", async () => {
    const { model } = h;
    await createDomain("One");
    model.assign("Work.md", model.domains()[0].id);
    h.view.render(); // the model changed outside the panel; a click would have re-rendered
    starProjectInDomain("One"); // Work's member row

    // The slot took it, the priorities section lists it, the slot summary says so.
    expect(model.priorities().projects).toEqual(["Work.md"]);
    expect(q(".zoomin-slot-summary").textContent).toBe("0/2 · 1/1");
    const group = qa(".zoomin-priority-group")[0]; // built first: the projects group
    expect(group.querySelector(".zoomin-row")!.textContent).toContain("Work");
    // The star shows it is selected now.
    expect(group.querySelector(".zoomin-star")!.getAttribute("aria-pressed")).toBe("true");

    // And the dashboard's focus box carries the project and its task.
    const tasks = model.tasks(new Date());
    expect(tasks.focus.map((f) => f.project.label)).toEqual(["Work"]);
    expect(tasks.focus[0].tasks.map((t) => t.label)).toEqual(["Ship"]);
  });

  it("stars a project straight from the Projects section", async () => {
    const { model } = h;
    // The Projects section lists every ranked project, stars included; no
    // domain or expansion is required to reach one.
    const projectRow = qa(".zoomin-section .zoomin-list > li > .zoomin-row").find((el) => el.textContent?.includes("Work"))!;
    (projectRow.querySelector(".zoomin-star") as HTMLButtonElement).click();
    expect(model.priorities().projects).toEqual(["Work.md"]);
    // The click re-rendered the list under the pointer; the new row's star
    // reads as selected.
    const rendered = qa(".zoomin-section .zoomin-list > li > .zoomin-row").find((el) => el.textContent?.includes("Work"))!;
    expect(rendered.querySelector(".zoomin-star")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("removes a priority from the same star, recording both moves", async () => {
    const { model } = h;
    model.setSlot("project", "Work.md", true);
    h.view.render();
    const group = qa(".zoomin-priority-group")[0];
    (group.querySelector(".zoomin-star") as HTMLButtonElement).click();
    expect(model.priorities().projects).toEqual([]);
    expect(model.store.data.slotHistory.map((s) => s.action)).toEqual(["fill", "clear"]);
  });
});

describe("the dossier leaves nothing behind", () => {
  it("hides the dossier entirely when the lens closes", async () => {
    h.focus.id = "Work.md";
    h.view.render();
    const dossier = q(".zoomin-dossier");
    expect(dossier.isShown()).toBe(true);
    expect(q(".zoomin-dossier-title").textContent).toBe("Work");

    // Back to the map: the sections return and the dossier is gone — not
    // waiting below the fold.
    h.focus.id = null;
    h.view.render();
    expect(dossier.isShown()).toBe(false);
    expect(q(".zoomin-sections").isShown()).toBe(true);
  });

  it("exits through the back link, which clears the plugin's focus", async () => {
    const { plugin } = h;
    plugin.focusId = "Work.md";
    h.view.render();
    (q(".zoomin-back") as HTMLButtonElement).click();
    expect(plugin.focusId).toBeNull();
    expect(q(".zoomin-dossier").isShown()).toBe(false);
  });
});

describe("the lens learns the dossier's labels", () => {
  it("renders the eyebrow from the note's own category and its domain", async () => {
    const { model } = h;
    const d = model.createDomain("One");
    model.assign("Work.md", d);
    h.focus.id = "Ship.md";
    h.view.render();
    const eyebrow = q(".zoomin-dossier-eyebrow").textContent ?? "";
    expect(eyebrow).toContain("Task");
    expect(eyebrow).toContain("One");
    expect(q(".zoomin-dossier-title").textContent).toBe("Ship");
  });
});

describe("the panel's tracker mode", () => {
  it("swaps the sections for a map frame and back, remembering which", () => {
    h.view.setTrackerMode(true);
    expect(h.view.trackerMode).toBe(true);
    expect(q(".zoomin-tracker").isShown()).toBe(true);
    expect(q(".zoomin-sections").isShown()).toBe(false);
    // The tracker carries its own head; the sections' would stack a second
    // "ZoomIn" above it.
    expect(q(".zoomin-panel-head").isShown()).toBe(false);
    expect(h.saved["zoomin.tracker"]).toBe(true);

    h.view.setTrackerMode(false);
    expect(h.view.trackerMode).toBe(false);
    expect(q(".zoomin-tracker").isShown()).toBe(false);
    expect(q(".zoomin-sections").isShown()).toBe(true);
    expect(q(".zoomin-panel-head").isShown()).toBe(true);
    expect(h.saved["zoomin.tracker"]).toBe(false);
  });

  it("tracks the editor quietly when no canvas can exist here", () => {
    h.view.setTrackerMode(true);
    // jsdom has no 2d canvas, so the tracker has no renderer; following the
    // editor must still be a no-op, not a crash.
    expect(() => h.view.trackPath("Work.md")).not.toThrow();
  });
});

describe("the dossier's direct children", () => {
  it("lists the notes filed under the note, ahead of the link lists", () => {
    h.focus.id = "Work.md";
    h.view.render();
    const labels = qa(".zoomin-dossier-links .zoomin-group-label").map((el) => el.textContent);
    expect(labels).toEqual(["Direct children", "Points to", "Pointed at by"]);
    const kids = qa(".zoomin-dossier-links ul")[0];
    expect(kids.textContent).toContain("Prepay");
    expect(kids.textContent).toContain("Ship");
    // The section title already says what every row is; the rows carry no tag.
    expect(qa(".zoomin-dossier-links ul")[0].textContent).not.toContain("child");
  });

  it("says nothing for a note nothing is filed under", () => {
    h.focus.id = "Chess.md";
    h.view.render();
    const kids = qa(".zoomin-dossier-links ul")[0];
    expect(kids.textContent).toContain("Nothing.");
  });
});

void labelFor;
