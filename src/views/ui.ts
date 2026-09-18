/**
 * The small pieces every panel is built from: shape swatches, a list row and
 * its buttons. Ported from app.js; the markup is built by hand (no innerHTML)
 * so the plugin reviewer and the CSP are both happy.
 */

import { Notice } from "obsidian";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function toast(message: string, tone: "ok" | "error" = "error"): void {
  // An acknowledgement has been read the moment it appears; a problem has not.
  new Notice(message, tone === "ok" ? 1800 : 4000);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --- shape icons ---------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

// The same equal-area factors the renderer uses, so the swatch in this list
// and the node on the map are recognisably one thing. Keep in sync with
// renderer.ts SHAPE_SCALE.
const SHAPE_SCALE: Record<string, number> = {
  circle: 1, square: 0.8862, diamond: 1.2533, triangle: 1.5554,
  "triangle-down": 1.5554, pentagon: 1.1495, hexagon: 1.0996,
  star: 1.6727, cross: 1.189,
};

const SHAPE_SIDES: Record<string, number> = { triangle: 3, "triangle-down": 3, pentagon: 5, hexagon: 6 };

function shapePoints(shape: string, c: number, s: number): string {
  let points: [number, number][] = [];
  if (shape === "diamond") {
    points = [[c, c - s], [c + s, c], [c, c + s], [c - s, c]];
  } else if (shape === "star") {
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 ? s * 0.382 : s;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      points.push([c + radius * Math.cos(angle), c + radius * Math.sin(angle)]);
    }
  } else if (shape === "cross") {
    const t = s / 3;
    const raw: [number, number][] = [
      [-t, -s], [t, -s], [t, -t], [s, -t], [s, t], [t, t],
      [t, s], [-t, s], [-t, t], [-s, t], [-s, -t], [-t, -t],
    ];
    points = raw.map((p) => [c + p[0], c + p[1]]);
  } else {
    const sides = SHAPE_SIDES[shape] || 6;
    const start = shape === "triangle-down" ? Math.PI / 2 : -Math.PI / 2;
    for (let i = 0; i < sides; i++) {
      const angle = start + (i * 2 * Math.PI) / sides;
      points.push([c + s * Math.cos(angle), c + s * Math.sin(angle)]);
    }
  }
  return points.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
}

export function shapeLabel(shape: string): string {
  return shape
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function shapeSvg(shape: string | null, cls: string): { svg: SVGSVGElement; node: SVGElement } {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const centre = 9, size = 5 * (SHAPE_SCALE[shape ?? ""] || 1);
  let node: SVGElement;
  if (!shape || shape === "circle") {
    node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("cx", String(centre));
    node.setAttribute("cy", String(centre));
    node.setAttribute("r", String(size));
  } else if (shape === "square") {
    node = document.createElementNS(SVG_NS, "rect");
    node.setAttribute("x", String(centre - size));
    node.setAttribute("y", String(centre - size));
    node.setAttribute("width", String(size * 2));
    node.setAttribute("height", String(size * 2));
  } else {
    node = document.createElementNS(SVG_NS, "polygon");
    node.setAttribute("points", shapePoints(shape, centre, size));
  }
  svg.appendChild(node);
  return { svg, node };
}

/** Hollow swatch for a category's shape; an undefined category still shows a
 *  circle — but hollow, so "no shape chosen" is distinguishable from
 *  "deliberately a circle". */
export function shapeIcon(shape: string | null): SVGSVGElement {
  const { svg } = shapeSvg(shape, "zoomin-shape-icon");
  if (shape) svg.classList.add("set");
  return svg;
}

/** Same geometry, solid-filled in a domain colour, sized to replace a row's
 *  plain dot — so a note in a list reads as the same kind of thing its node on
 *  the map is. */
export function shapeDot(shape: string | null, hue: number | null): SVGSVGElement {
  const { svg, node } = shapeSvg(shape, "zoomin-shape-dot");
  node.setAttribute("fill", swatch(hue) || "var(--ink-faint)");
  return svg;
}

/* --- lookups -------------------------------------------------------------- */

/** The same hue the renderer paints the region with. */
export function swatch(hue: number | null | undefined): string {
  return hue === null || hue === undefined ? "" : "hsl(" + hue + ",55%,52%)";
}

/* --- rows ----------------------------------------------------------------- */

export function tag(text: string, title?: string, hue?: number | null): HTMLElement {
  const node = el("span", "zoomin-tag", text);
  if (title) node.title = title;
  const colour = swatch(hue);
  if (colour) {
    node.style.borderColor = colour;
    node.style.color = colour;
  }
  return node;
}

export interface RowOptions {
  nested?: boolean;
  hue?: number | null;
  count?: string;
  tag?: { text: string; title?: string; hue?: number | null } | null;
  leading?: HTMLElement[];
  controls?: HTMLElement[];
  onLabelClick?: (() => void) | null;
  title?: string;
  dotIcon?: SVGSVGElement;
}

export function row(label: string, options: RowOptions): HTMLLIElement {
  const item = el("li");
  const line = el("div", "zoomin-row" + (options.nested ? " nested" : ""));
  for (const control of options.leading ?? []) line.appendChild(control);

  // dotIcon lets a caller draw the marker itself — a datatype's shape,
  // solid-filled — instead of the plain hue-coloured circle every other row
  // gets by default.
  const dot: Element = options.dotIcon ?? el("span", "zoomin-dot");
  if (!options.dotIcon) {
    const colour = swatch(options.hue);
    if (colour) (dot as HTMLElement).style.background = colour;
  }
  line.appendChild(dot);

  let name: HTMLElement;
  if (options.onLabelClick) {
    // The name is the way into the domain's dialog, so it has to be a real
    // button: a click target that can't be tabbed to doesn't exist for anyone
    // not using a mouse.
    const button = el("button", "zoomin-row-label zoomin-name-button", label);
    button.type = "button";
    button.onclick = options.onLabelClick;
    name = button;
  } else {
    name = el("span", "zoomin-row-label", label);
  }
  name.title = options.title || label;
  line.appendChild(name);

  if (options.tag) line.appendChild(tag(options.tag.text, options.tag.title, options.tag.hue));
  if (options.count) line.appendChild(el("span", "zoomin-count", options.count));
  for (const control of options.controls ?? []) line.appendChild(control);
  item.appendChild(line);
  return item;
}

export function iconButton(className: string, glyph: string, title: string, handler: () => void): HTMLButtonElement {
  const button = el("button", className, glyph);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.onclick = handler;
  return button;
}

/** A disclosure, not a checkbox: it owns the list it opens, and says so. */
export function discloseButton(open: boolean, label: string, onToggle: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const button = el("button", "zoomin-disclose", "");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.onclick = () => onToggle(button);
  return button;
}

export function emptyNote(text: string): HTMLLIElement {
  const blank = el("li");
  blank.appendChild(el("div", "zoomin-row nested zoomin-empty-note", text));
  return blank;
}

export function checkbox(className = "zoomin-check"): HTMLInputElement {
  const box = el("input", className);
  box.type = "checkbox";
  return box;
}
