/**
 * The palette — a quick-switcher style picker over a list of items, ported
 * from search.js with its ranking intact: start of label > start of a word >
 * anywhere > subsequence ("ptd" finds "Prepay Task Dashboard"), a hit in the
 * muted line sits a whole ladder below any hit in the label, ties go to the
 * shorter label then alphabetical, and an empty query shows the first forty
 * in the order given (parents first, biggest first — the caller sorts).
 *
 * Obsidian's own FuzzySuggestModal was not used because its ranking is its
 * own; the tiers above are what made the palette feel right, and the parent
 * picker depends on the same behaviour.
 */

import { App, Modal } from "obsidian";
import { el } from "./ui";

// The list is capped where a scan stops being a scan: past forty rows you
// are not looking, you are typing another letter.
const LIMIT = 40;

// Tiers, best first. A hit in `sub` sits a whole ladder below any hit in the
// label, so a path fragment never outranks a name.
const PREFIX = 0, WORD = 1, ANYWHERE = 2, SUBSEQ = 3, SUB_PENALTY = 4;

export interface SearchItem {
  id: string;
  label: string;
  /** the muted line under the label (the vault path) */
  sub?: string;
  /** an optional short tag on the right ("unwritten", "Task") */
  kind?: string;
}

export interface SearchOptions {
  items: SearchItem[];
  placeholder: string;
  title?: string;
  emptyText: string;
  icon?: (item: SearchItem) => Element;
  onPick: (item: SearchItem) => void;
}

/** Where `q` sits in `text` (both lowercased): the tier, and the [start, end)
 *  spans to highlight. Null when it is not there at all. */
export function locate(text: string, q: string): { tier: number; spans: [number, number][] } | null {
  const i = text.indexOf(q);
  if (i === 0) return { tier: PREFIX, spans: [[0, q.length]] };
  if (i > 0) {
    // Prefer a word-start hit over an earlier mid-word one: "com" in
    // "Income Computing" should light the C, not hide inside "Income".
    let j = i;
    while (j > -1 && /[a-z0-9]/.test(text.charAt(j - 1))) j = text.indexOf(q, j + 1);
    if (j > -1) return { tier: WORD, spans: [[j, j + q.length]] };
    return { tier: ANYWHERE, spans: [[i, i + q.length]] };
  }
  const spans: [number, number][] = [];
  let from = 0;
  for (const ch of q) {
    const at = text.indexOf(ch, from);
    if (at < 0) return null;
    spans.push([at, at + 1]);
    from = at + 1;
  }
  return { tier: SUBSEQ, spans };
}

interface Hit {
  item: SearchItem;
  lower: string;
  tier: number;
  spans: [number, number][] | null;
}

export class ZoomInSearch extends Modal {
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private empty!: HTMLElement;
  private eyebrow: HTMLElement | null = null;
  private prepared: { item: SearchItem; label: string; sub: string }[] = [];
  private ranked: Hit[] = [];
  private active = 0;
  private picked = false;

  constructor(
    app: App,
    private readonly options: SearchOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("zoomin-view", "zoomin-palette");
    const { contentEl } = this;
    contentEl.empty();
    if (this.options.title) {
      this.eyebrow = contentEl.createDiv({ cls: "zoomin-palette-eyebrow", text: this.options.title.toUpperCase() });
    }
    this.input = contentEl.createEl("input", {
      attr: { type: "text", spellcheck: "false", autocomplete: "off", placeholder: this.options.placeholder },
    });
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.move(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const hit = this.ranked[this.active];
        if (hit) {
          this.picked = true;
          this.close();
          this.options.onPick(hit.item);
        }
      }
    });
    this.list = contentEl.createEl("ul", { cls: "zoomin-palette-list", attr: { role: "listbox" } });
    this.empty = contentEl.createEl("p", { cls: "zoomin-palette-empty", text: this.options.emptyText });
    // Pre-sort: an empty query shows the first forty in the order given.
    this.prepared = this.options.items.map((item) => ({ item, label: item.label.toLowerCase(), sub: (item.sub ?? "").toLowerCase() }));
    this.filter();
    this.input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private move(delta: number): void {
    if (!this.ranked.length) return;
    this.active = (this.active + delta + this.ranked.length) % this.ranked.length;
    this.renderList(true);
  }

  private filter(): void {
    const q = this.input.value.trim().toLowerCase();
    let hits: Hit[];
    if (!q) {
      hits = this.prepared.slice(0, LIMIT).map((p) => ({ item: p.item, lower: p.label, tier: 0, spans: null }));
    } else {
      hits = [];
      for (const p of this.prepared) {
        let hit = locate(p.label, q);
        if (!hit && p.sub) {
          // A hit in `sub` sits a whole ladder below any hit in the label.
          hit = locate(p.sub, q);
          if (hit) hit = { tier: hit.tier + SUB_PENALTY, spans: hit.spans };
        }
        if (hit) hits.push({ item: p.item, lower: p.label, tier: hit.tier, spans: hit.spans });
      }
      hits = hits
        .sort((a, b) => a.tier - b.tier || a.lower.length - b.lower.length || a.lower.localeCompare(b.lower))
        .slice(0, LIMIT);
    }
    this.ranked = hits;
    this.active = 0;
    this.renderList();
  }

  /** Writes `text` into `node` with the spans wrapped in <mark>. Adjacent
   *  single-character hits (a subsequence running through a word) merge into
   *  one run so the highlight reads as a stroke, not confetti. */
  private withMarks(node: HTMLElement, text: string, spans: [number, number][] | null): void {
    node.textContent = "";
    let at = 0;
    for (const span of spans ?? []) {
      if (span[0] > at) node.appendChild(document.createTextNode(text.slice(at, span[0])));
      const last = node.lastChild;
      if (last && last.nodeName === "MARK" && span[0] === at) last.textContent += text.slice(span[0], span[1]);
      else node.appendChild(el("mark", null, text.slice(span[0], span[1])));
      at = span[1];
    }
    if (at < text.length) node.appendChild(document.createTextNode(text.slice(at)));
  }

  private renderList(keepScroll = false): void {
    const scroll = this.list.scrollTop;
    this.list.empty();
    this.empty.toggle(this.ranked.length === 0);
    this.ranked.forEach((hit, i) => {
      const row = el("li", "zoomin-palette-row" + (i === this.active ? " active" : ""));
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === this.active ? "true" : "false");
      const slot = el("span", "zoomin-cat-icon");
      slot.appendChild(this.options.icon ? this.options.icon(hit.item) : el("span", "zoomin-dot"));
      row.appendChild(slot);
      const text = el("div", "zoomin-palette-text");
      const label = el("div", "zoomin-palette-label");
      this.withMarks(label, hit.item.label, hit.spans);
      text.appendChild(label);
      if (hit.item.sub) text.appendChild(el("div", "zoomin-palette-sub", hit.item.sub));
      row.appendChild(text);
      if (hit.item.kind) row.appendChild(el("span", "zoomin-tag", hit.item.kind));
      row.addEventListener("click", () => {
        this.picked = true;
        this.close();
        this.options.onPick(hit.item);
      });
      row.addEventListener("mousemove", () => {
        if (this.active !== i) {
          this.active = i;
          this.renderList(true);
        }
      });
      this.list.appendChild(row);
    });
    if (keepScroll) this.list.scrollTop = scroll;
    const activeRow = this.list.querySelector(".active");
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
  }
}
