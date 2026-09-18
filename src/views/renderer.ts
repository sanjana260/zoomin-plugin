/* GraphRenderer — a thin adapter over force-graph.
 *
 * Everything the plugin knows about drawing lives here, behind setData/
 * applyFocus/onSelect. Keeping that interface small is what makes swapping in
 * a WebGL renderer later a contained job rather than a rewrite.
 *
 * Visual language (design.md §1, "structure should show everything; activity
 * should be focused on priority regions"):
 *
 *   - Size is STRUCTURAL and nothing else. A node's radius says how much of the
 *     vault hangs off it — never how important you decided it was this week.
 *     When priority moved geometry, the map changed shape every time you changed
 *     your mind, and a map you cannot memorise is not a map.
 *   - Priority is carried by chroma and alpha. design.md decision 6 warned that
 *     alpha "vanishes into the background"; the answer is not to avoid alpha but
 *     to floor it. Suppressed nodes composite to a value that stays well clear
 *     of both the light and the dark graph background — they stop competing,
 *     they never stop existing, and they stay clickable.
 *   - Labels are governed by ZOOM, not by priority. Gating them on focus meant
 *     promoting a domain dumped fifty names on you at once. Now zoom decides how
 *     much text the view can hold, and priority only picks the ink. Zoom far
 *     enough and every label is there, including inside suppressed regions.
 *
 * Domains are abstract groupings the user created, not notes, so they have no
 * node to hang a label on. Their names are drawn as an overlay at the centroid
 * of their members — see paintDomainLabels.
 *
 * This is web/graph.js from the pywebview app, ported line for line. What
 * changed: the theme is read from Obsidian's body class rather than
 * matchMedia, resize is the view's to call, and there is a destroy().
 */

import ForceGraph from "force-graph";
import type { GraphPayload } from "../types";

const SUPPRESSED = 0, NORMAL = 1, PRIORITY = 2;
const PHANTOM = 1;

// Status, a second axis crossing focus. Focus says which region of your life
// you chose; status says how far through a thing you are. They are read
// together: a suppressed explored note is the quietest thing on the map, a
// priority exploring note the loudest.
//
// NO_STATUS deliberately renders identically to EXPLORING. 92 of 314 notes set
// no usable status, and giving them a look of their own would restyle a third
// of the map on a property their author never set.
const NO_STATUS = 0, UNEXPLORED = 1, EXPLORING = 2, EXPLORED = 3;

// Alpha, indexed by focus then status. The map is for deciding what to do
// next, so both of the states that are not "in progress" fall back: explored
// hardest, unexplored a clear step behind exploring — and far enough behind
// that the two stop reading as the same colour at a glance. The floor stays
// at 0.38 because nothing is ever hidden and everything stays clickable, and
// unexplored is kept a further step above that floor at every tier (0.60 vs
// 0.50, 0.52 vs 0.45, 0.42 vs 0.38) so "not started" never gets quieter than
// "done" — measured contrast against the canvas confirms the ordering holds
// in both themes: exploring 7.0/4.5/3.0, unexplored 3.7/2.6/2.1, explored
// 2.7/2.1/1.8 (priority/normal/suppressed).
const STATUS_ALPHA: Record<number, number[]> = {
  [PRIORITY]: [1.0, 0.6, 1.0, 0.5],
  [NORMAL]: [0.88, 0.52, 0.88, 0.45],
  [SUPPRESSED]: [0.66, 0.42, 0.66, 0.38],
};

// How far a status has receded, for anything that has to follow the quieter
// of two nodes — a link, for one. none/exploring 0, unexplored 1, explored 2.
const STATUS_QUIET = [0, 1, 0, 2];

// Chroma multiplier. Explored goes essentially grey; unexplored keeps its
// domain hue but reads quieter than the thing actually in progress.
const STATUS_CHROMA = [1, 0.55, 1, 0.1];

// Lightness shift toward the background, in HSL points.
const STATUS_FADE = [0, 5, 0, 0];
const HIERARCHY = 1;
const NEUTRAL_HUE = 40; // notes outside every promoted domain

// Canvas text cannot use a CSS variable, so the interface font Obsidian has
// resolved for the host element is read from its computed style (see
// `readFont`) and this is only the fallback.
const FALLBACK_FONT = "ui-sans-serif, -apple-system, system-ui, sans-serif";

// Graph units per unit of payload size (payload size is 1 + sqrt(direct
// children), so 1 for a leaf and 6.1 for the vault's biggest parent). The layout
// spreads over about ±900 units and loads via zoomToFit, which lands near
// globalScale 0.5 — at 1 unit per size a leaf note would be half a screen
// pixel across, i.e. invisible, which is not "present".
const BASE_RADIUS = 2.0;
const PHANTOM_SCALE = 0.45; // an intention not yet written reads smaller
const MIN_RADIUS = 1.5;

// Hover target, in *screen* pixels. Nodes are drawn small on purpose, but a
// 2px dot is not a thing a mouse can catch, and the design says suppressed
// regions must stay clickable. Zoomed out these circles overlap — the
// last-painted node wins — which is the right trade: at that zoom you are
// aiming at a region, and one more click gets you the neighbour.
const MIN_HIT_PX = 11;

// Semantic zoom thresholds. zoomToFit on this vault opens near globalScale
// 0.4-0.6, so both sit comfortably above the initial view: it stays calm,
// showing domain names only. PROJECT_ZOOM is roughly a doubling from there —
// one deliberate scroll — and at that scale a viewport holds ~60 nodes, of
// which only the project subset gets named. NOTE_ZOOM doubles again; a
// viewport then holds ~15 nodes on average, which is few enough that every
// one of them can carry its title without the labels colliding.
export const PROJECT_ZOOM = 1.1;
export const NOTE_ZOOM = 2.2;

// A further doubling, for unexplored notes only. Exploring work earns a name
// at NOTE_ZOOM because it is what you are doing; unexplored work has not
// been picked up yet, so it waits for one more deliberate scroll before it
// starts competing for the same attention. Explored notes never reach this
// tier at all — see shouldLabel — because no amount of zooming turns
// finished work back into something worth naming on the map.
const UNEXPLORED_ZOOM = 4.4;

// Focus mode: one node and its immediate neighbours are the whole map for a
// moment. Everything else drops to this alpha — present enough to keep the
// shape of the vault under the neighbourhood, quiet enough to stop competing
// with it. Well below the 0.38 suppression floor on purpose: suppression is
// "not chosen this week", this is "not the thing being looked at right now",
// and the two must not read alike. Links outside the neighbourhood go
// fainter still; the neighbourhood's own links come up to a weight no other
// state uses, so the wiring of one note is legible against everything.
const FOCUS_DIM_ALPHA = 0.16;
const FOCUS_DIM_LINK_ALPHA = 0.035;
const FOCUS_LINK_ALPHA = 0.9;
const FOCUS_LINK_WIDTH = 1.7;
const FOCUS_ARROW = 4.2;

// How the camera frames a neighbourhood: fit the box that holds every lit
// neighbour, then cap. The whole neighbourhood, not a quantile of it —
// under the lens the lit nodes *are* the answer, and one that is off screen
// is an answer withheld; if a body mention sits across the map, the zoom
// is whatever brings it in. There is no floor for the same reason. The
// ceiling sits just past NOTE_ZOOM so a two-node neighbourhood is not a
// wall of pixels and the subject is unmistakably the subject.
//
// The pad is screen pixels, not map units, because what it protects is
// drawn in screen pixels: a neighbour's name hangs 3px under it at 10–13px
// and is centred, so a node placed on the very edge would keep its dot and
// lose half its label. 56 covers a ~100px label's half-width plus a hub's
// radius at the ceiling. (Decision 37.)
const FOCUS_FIT_PAD = 56;
const FOCUS_ZOOM_MAX = 4.6;

// Centroids are recomputed every Nth frame rather than every frame. At ~7Hz
// they track a settling layout closely enough that a 16px label never appears
// to lag, and it keeps the render hook honest about doing no real work.
const CENTROID_EVERY = 9;

// What fraction of nodes "fit" is required to frame. Isolated notes — daily
// notes, unlinked captures — are pushed outward by charge repulsion with
// nothing pulling them back, so the layout's true extent is set by a diffuse
// halo rather than by anything you navigate to, and fitting to it shrinks the
// part you actually read. CENTERING below does the real work now; this is a
// guard for the vault whose outliers are genuine. On the reference vault,
// after centering: fitting everything gave 0.454 against 0.545 for the 80%
// trim, costing 3 nodes. Nothing is hidden either way; the rest is one scroll out.
const FIT_QUANTILE = 0.8;

// Below this there is no meaningful tail to trim, so fit the lot.
const FIT_MIN_NODES = 8;

// How hard every node is pulled toward the origin.
//
// force-graph ships a `center` force, but d3's forceCenter only translates the
// whole system so its centroid sits at the origin — it creates no attraction,
// so nothing at all counteracts charge repulsion on a note that no link holds
// in place. Unlinked notes therefore drift outward indefinitely: measured on
// the reference vault, 310 nodes spread over ~5000 units, fitting at zoom
// 0.115, which draws every leaf note at under one screen pixel.
//
// Chosen by sweeping 0.01-0.30 and settling 300 ticks at each. At 0.05 the
// opening fit lands at 0.545 — back inside the 0.4-0.6 band that PROJECT_ZOOM
// and NOTE_ZOOM were calibrated against — with nodes ~4x larger on screen and
// domain labels further apart on screen than before (62px -> 125px). Stronger
// settings flatten the map toward a single disc and push the opening view up
// against PROJECT_ZOOM.
const CENTERING = 0.05;

// How hard members of one domain pull together. The hierarchy link force is
// 0.75, so this has to be far weaker: it should gather a domain into a region
// without crushing the project stars that carry the vault's real structure.
const DOMAIN_COHESION = 0.2;

// Shape radii as a multiple of the circle carrying the same area.
//
// Size is structural and nothing else: a node's radius says how much of the
// vault hangs off it. Drawing a square at the circle's radius would cover 27%
// more ink and read as a bigger node, so giving a category a shape would
// silently look like promoting every note in it. Each factor below solves
// <shape area> = pi*r^2 for that shape's defining radius. Duplicated in ui.ts
// for the sidebar swatches — keep in sync.
export const SHAPE_SCALE: Record<string, number> = {
  circle: 1,
  square: 0.8862, // half-side,     sqrt(pi)/2
  diamond: 1.2533, // half-diagonal, sqrt(pi/2)
  triangle: 1.5554, // circumradius,  sqrt(4pi/(3*sqrt3))
  "triangle-down": 1.5554, // the same triangle, rotated
  pentagon: 1.1495, // circumradius,  sqrt(pi/(2.5*sin72))
  hexagon: 1.0996, // circumradius,  sqrt(2pi/(3*sqrt3))
  star: 1.6727, // outer radius,  sqrt(pi/(5*0.382*sin36))
  cross: 1.189, // half-span,     sqrt(pi/(20/9)), arm width span/3
};

const STAR_WAIST = 0.382; // golden ratio; a fatter star reads as a blob
const CROSS_ARM = 1 / 3; // of the half-span; the area factor above assumes it

export interface RNode {
  id: string;
  label: string;
  kind: number;
  size: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  domain: number;
  isParent: boolean;
  isSlotted: boolean;
  datatype: number;
  status: number;
  focus: number;
}

export interface RLink {
  index: number;
  source: string | RNode;
  target: string | RNode;
  kind: number;
}

export interface RendererOptions {
  onSelect?: (node: RNode) => void;
  onSettled?: (positions: Record<string, [number, number]>) => void;
  onHover?: (node: RNode | null) => void;
  onBackgroundClick?: () => void;
  /** Whether the host is in a dark theme. Re-read via `setDark`. */
  dark?: boolean;
}

function tracePolygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, start: number) {
  for (let i = 0; i < sides; i++) {
    const angle = start + (i * 2 * Math.PI) / sides;
    const px = x + r * Math.cos(angle), py = y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function traceCross(ctx: CanvasRenderingContext2D, x: number, y: number, span: number) {
  const t = span * CROSS_ARM;
  const points = [
    [-t, -span], [t, -span], [t, -t], [span, -t], [span, t], [t, t],
    [t, span], [-t, span], [-t, t], [-span, t], [-span, -t], [-t, -t],
  ];
  for (let i = 0; i < points.length; i++) {
    const px = x + points[i][0], py = y + points[i][1];
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function traceStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? r * STAR_WAIST : r;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + radius * Math.cos(angle), py = y + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Trace a node outline, beginPath included. `r` is the circle-equivalent. */
export function traceShape(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number) {
  const s = r * (SHAPE_SCALE[shape] || 1);
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(x - s, y - s, s * 2, s * 2);
  } else if (shape === "diamond") {
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
  } else if (shape === "triangle") {
    tracePolygon(ctx, x, y, s, 3, -Math.PI / 2);
  } else if (shape === "triangle-down") {
    tracePolygon(ctx, x, y, s, 3, Math.PI / 2);
  } else if (shape === "pentagon") {
    tracePolygon(ctx, x, y, s, 5, -Math.PI / 2);
  } else if (shape === "hexagon") {
    tracePolygon(ctx, x, y, s, 6, -Math.PI / 2);
  } else if (shape === "star") {
    traceStar(ctx, x, y, s);
  } else if (shape === "cross") {
    traceCross(ctx, x, y, s);
  } else {
    ctx.arc(x, y, s, 0, 2 * Math.PI);
  }
}

function hsl(h: number, s: number, l: number, a?: number): string {
  return "hsla(" + h + "," + s + "%," + l + "%," + (a === undefined ? 1 : a) + ")";
}

type Force = ((alpha: number) => void) & { initialize?: (nodes: RNode[]) => void };

/**
 * Pull each domain's members toward their shared centroid.
 *
 * Domains are user-defined and cut across the vault's `Parent:` hierarchy — a
 * "Data Science" domain can hold projects from three different branches. Without
 * this the layout has no idea those notes belong together, so the domain's
 * centroid lands in empty space between unrelated clusters and its label is
 * meaningless. Making domains into actual regions is also the honest reading of
 * "the map is for situating yourself": if you declared the grouping, the map
 * should show it as a place.
 */
function domainForce(strength: number): Force {
  let nodes: RNode[] = [];
  const force: Force = (alpha) => {
    const sums: Record<number, { x: number; y: number; n: number }> = {};
    const k = alpha * strength;
    for (const node of nodes) {
      if (node.domain < 0) continue; // unfiled notes are left entirely alone
      const sum = sums[node.domain] || (sums[node.domain] = { x: 0, y: 0, n: 0 });
      sum.x += node.x;
      sum.y += node.y;
      sum.n++;
    }
    for (const node of nodes) {
      if (node.domain < 0) continue;
      const sum = sums[node.domain];
      node.vx = (node.vx ?? 0) + (sum.x / sum.n - node.x) * k;
      node.vy = (node.vy ?? 0) + (sum.y / sum.n - node.y) * k;
    }
  };
  force.initialize = (n) => { nodes = n; };
  return force;
}

/**
 * Pull every node toward the origin. This is what a linked note gets from its
 * links and an isolated note gets from nothing: without it, charge repulsion
 * is the only force acting on the unlinked half of a vault and they leave.
 */
function centeringForce(strength: number): Force {
  let nodes: RNode[] = [];
  const force: Force = (alpha) => {
    const k = alpha * strength;
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - node.x * k;
      node.vy = (node.vy ?? 0) - node.y * k;
    }
  };
  force.initialize = (n) => { nodes = n; };
  return force;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function placed(node: RNode): boolean {
  return typeof node.x === "number" && isFinite(node.x) && isFinite(node.y);
}

function endpointId(end: string | RNode): string {
  return typeof end === "object" ? end.id : end;
}

// Grey a step brighter than the ordinary out-of-priority line, for a
// hierarchy edge whose child is explored but which is not itself suppressed.
// "Explored" is still a real structural claim — this note organised that
// one — so it outranks a passing mention and sits a little above the
// regular associative baseline (0.26) rather than folding into the same
// near-invisible grey as a plain suppressed edge (0.10).
const EXPLORED_HIERARCHY_ALPHA = 0.32;

export class GraphRenderer {
  el: HTMLElement;
  graph: ForceGraph<RNode, RLink>;
  onSelect: (node: RNode) => void;
  onSettled: (positions: Record<string, [number, number]>) => void;
  onHover: (node: RNode | null) => void;
  onBackgroundClick: () => void;
  domains: GraphPayload["domains"] = [];
  datatypes: GraphPayload["datatypes"] = [];
  /** datatype name → true for hidden. "untyped" covers notes with no datatype
   *  and phantoms, which have no frontmatter to carry one. */
  hidden: Record<string, boolean> = {};
  nodes: RNode[] = [];
  byId: Record<string, RNode> = {};
  links: RLink[] = [];
  hovered: RNode | null = null;
  // Focus mode. `focusId` is the subject; `focusSet` is it plus every
  // immediate neighbour (either direction); `focusLinks` is keyed by link
  // index. All three are null/empty when not focusing.
  focusId: string | null = null;
  focusSet: Record<string, boolean> = {};
  focusLinks: Record<number, boolean> = {};
  dark: boolean;
  private font = FALLBACK_FONT;
  private _fitted = false;
  // Set once the user has deliberately navigated somewhere. The opening fit
  // arrives whenever the layout happens to settle, which on a large vault is
  // seconds after the sidebar is usable — long enough to steal a view the
  // user chose on purpose.
  private _userMoved = false;
  private _frame = 0;
  private _centroids: ({ x: number; y: number } | null)[] = [];
  private _centroidsStale = true;

  constructor(element: HTMLElement, options: RendererOptions = {}) {
    this.el = element;
    this.onSelect = options.onSelect || (() => {});
    this.onSettled = options.onSettled || (() => {});
    this.onHover = options.onHover || (() => {});
    this.onBackgroundClick = options.onBackgroundClick || (() => {});
    this.dark = !!options.dark;
    this.readFont();

    const graph = new ForceGraph<RNode, RLink>(element)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeRelSize(3)
      .nodeId("id")
      .nodeLabel((n) => n.label)
      .nodeCanvasObject((n, ctx, scale) => this.paintNode(n, ctx, scale))
      .nodeVisibility((n) => this.visible(n))
      // A link to something filtered out would dangle into empty space, so it
      // goes with it. Endpoints arrive as ids before the first tick resolves
      // them into objects, hence the type check inside visible().
      .linkVisibility((l) => this.visible(l.source) && this.visible(l.target))
      .nodePointerAreaPaint((n, color, ctx, scale) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, this.hitRadius(n, scale), 0, 2 * Math.PI);
        ctx.fill();
      })
      // Domain names are an overlay, not a node: drawn after everything else so
      // they sit on top of their own cluster rather than under it.
      .onRenderFramePost((ctx, scale) => this.paintDomainLabels(ctx, scale))
      .linkColor((l) => this.linkColor(l))
      .linkWidth((l) => {
        if (this.focusLinks[l.index]) return FOCUS_LINK_WIDTH;
        return l.kind === HIERARCHY ? 1.1 : 0.45;
      })
      // A neighbourhood link always carries an arrow, associative or not: in
      // focus mode the question is "which way does this connection run", and
      // an unarrowed mention answers it with nothing.
      .linkDirectionalArrowLength((l) => {
        if (this.focusLinks[l.index]) return FOCUS_ARROW;
        return l.kind === HIERARCHY ? 3.2 : 0;
      })
      .linkDirectionalArrowRelPos(1)
      // Redraw every frame. At a few hundred nodes this is free, and it means a
      // focus change repaints without having to poke the simulation.
      .autoPauseRedraw(false)
      .d3AlphaDecay(0.03)
      .onNodeHover((n) => {
        this.hovered = n;
        element.style.cursor = n ? "pointer" : "";
        this.onHover(n);
      })
      .onNodeClick((n) => this.onSelect(n))
      .onBackgroundClick(() => this.onBackgroundClick())
      .onEngineStop(() => {
        // Same framing as the Fit all button: the view you open on and the view
        // that button returns you to have to be the same place. Skipped once the
        // user has navigated — landing somewhere on purpose outranks the default
        // view, and settling is far too late to overrule them.
        if (!this._fitted && !this._userMoved) this.fitAll();
        this._fitted = true;
        this.onSettled(this.positions());
      });

    // Hierarchy edges pull hard and sit close, so a project visibly belongs to
    // its domain. Associative links are long and weak: they should suggest a
    // relationship without dragging the structure out of shape.
    const link = graph.d3Force("link") as unknown as {
      distance(fn: (l: RLink) => number): unknown;
      strength(fn: (l: RLink) => number): unknown;
    };
    link.distance((l) => (l.kind === HIERARCHY ? 34 : 95));
    link.strength((l) => (l.kind === HIERARCHY ? 0.75 : 0.06));
    const charge = graph.d3Force("charge") as unknown as {
      strength(v: number): { distanceMax(v: number): unknown };
    };
    charge.strength(-135).distanceMax(600);
    graph.d3Force("domain", domainForce(DOMAIN_COHESION));
    // A separate force from force-graph's own "center", which is left in place:
    // that one holds the centroid at the origin, this one holds the graph
    // together.
    graph.d3Force("centering", centeringForce(CENTERING));

    this.graph = graph;
  }

  /** The canvas bakes colours and fonts at paint time, so the host tells us
   *  when the theme flips and we re-read both. */
  setDark(dark: boolean): void {
    this.dark = dark;
    this.readFont();
  }

  private readFont(): void {
    try {
      const family = getComputedStyle(this.el).fontFamily;
      if (family) this.font = family;
    } catch {
      /* not attached yet; the fallback stands */
    }
  }

  /** Stop the animation loop and release the canvas. The view owns the element. */
  destroy(): void {
    this.graph._destructor();
  }

  /* --- geometry ----------------------------------------------------------- */

  hueOf(node: RNode): number {
    const domain = node.domain >= 0 ? this.domains[node.domain] : null;
    return domain ? domain.hue : NEUTRAL_HUE;
  }

  /**
   * Structural radius. Focus is deliberately not consulted: how big a note is
   * answers "how much hangs off this", which does not change when you pick a
   * priority. Suppression happens in fill and alpha instead.
   */
  radius(node: RNode): number {
    // No extra nudge for being a parent: size is 1 + sqrt(direct children), so
    // one child already doubles a note against a leaf.
    let r = node.size * BASE_RADIUS;
    if (node.kind === PHANTOM) r *= PHANTOM_SCALE;
    return Math.max(r, MIN_RADIUS);
  }

  /**
   * Hover target in graph units. The floor is expressed in screen pixels and
   * divided back out, so it holds at every zoom: at scale 0.4 a leaf note's
   * visual radius of 2 units is dwarfed by 11/0.4 = 27.5 units, which is still
   * 11px on screen; at scale 3 that floor shrinks to 3.7 units and the visual
   * radius + 2 wins instead, so a big hub keeps a target matching its own edge.
   */
  hitRadius(node: RNode, scale: number): number {
    if (!scale || !isFinite(scale)) scale = 1; // shadow canvas can call in early
    return Math.max(this.radius(node) + 2, MIN_HIT_PX / scale);
  }

  /** The shape a note's datatype gives it, or a circle. A phantom has no
   *  frontmatter to carry a category, so it always stays a circle. */
  shapeOf(node: RNode): string {
    if (node.kind === PHANTOM) return "circle";
    const datatype = node.datatype >= 0 ? this.datatypes[node.datatype] : null;
    return datatype && datatype.shape ? datatype.shape : "circle";
  }

  /** Is this node shown under the current filters? */
  visible(node: RNode | string | undefined): boolean {
    if (!node || typeof node !== "object") return true;
    const datatype = node.datatype >= 0 ? this.datatypes[node.datatype] : null;
    // Prefixed keys, so a datatype named "untyped" cannot shadow the row for
    // notes that have none, and a status number cannot collide with a name.
    if (this.hidden[datatype ? "type:" + datatype.name : "untyped"]) return false;
    return !this.hidden["status:" + (node.status || 0)];
  }

  /**
   * Does hovering this node earn the full card, or just its name? Zoomed out,
   * the map is about regions; parents are the landmarks at that zoom, so they
   * keep the card; everything else waits for the zoom at which individual
   * notes get their labels.
   */
  detailHover(node: RNode | null): boolean {
    if (!node) return false;
    return !!node.isParent || (this.graph.zoom() || 1) >= NOTE_ZOOM;
  }

  /** Where a node currently sits on screen, for anchoring HTML to it. */
  screenPos(id: string): { x: number; y: number; r: number } | null {
    const node = this.byId[id];
    if (!node || typeof node.x !== "number") return null;
    const at = this.graph.graph2ScreenCoords(node.x, node.y);
    return { x: at.x, y: at.y, r: this.radius(node) * (this.graph.zoom() || 1) };
  }

  /* --- colour ------------------------------------------------------------- */

  /**
   * Alpha carries suppression, floored so it never becomes invisibility. The
   * floor was picked by compositing: a suppressed fill at 0.66 alpha lands on
   * rgb(187,182,171) over the light graph background and rgb(105,100,91) over
   * the dark one — contrast 1.78 and 3.16, within a rounding error of what the
   * previous fully opaque suppressed colour achieved.
   */
  alpha(node: RNode): number {
    const row = STATUS_ALPHA[node.focus];
    return (row || STATUS_ALPHA[NORMAL])[node.status || NO_STATUS];
  }

  fill(node: RNode): string {
    const hue = this.hueOf(node);
    const owned = node.domain >= 0;
    const dark = this.dark;
    let alpha = this.alpha(node);
    const status = node.status || NO_STATUS;
    const chroma = STATUS_CHROMA[status];

    if (this.focusId !== null) {
      if (!this.focusSet[node.id]) {
        // Outside the neighbourhood: a grey ghost, whatever its focus or
        // status. Status and priority are questions for the whole map; this
        // is a question about one note.
        return hsl(hue, 6, dark ? 60 : 50, FOCUS_DIM_ALPHA);
      }
      if (node.id === this.focusId) {
        // The subject reads at full priority strength regardless of what the
        // slots say — you asked about it, so it is the loudest thing here.
        return node.kind === PHANTOM
          ? hsl(hue, 8, dark ? 62 : 50, 1)
          : hsl(hue, owned ? 74 : 26, dark ? 66 : 42, 1);
      }
      // A neighbour keeps its own colour — its focus and status still say
      // something — but is never quieter than a normal exploring note, so the
      // neighbourhood stands as one lit thing.
      alpha = Math.max(alpha, STATUS_ALPHA[NORMAL][EXPLORING]);
    }
    // "Lighter" is read as "nearer the background", which is up in light mode
    // and down in dark. Taken literally it would make an unexplored node LOUDER
    // than an exploring one on a dark canvas — the opposite of what a fade for
    // "not started yet" is meant to say.
    const fade = STATUS_FADE[status] * (dark ? -1 : 1);

    if (node.kind === PHANTOM) return hsl(hue, 8, dark ? 52 : 60, alpha);
    if (node.focus === PRIORITY) {
      return hsl(hue, (owned ? 72 : 22) * chroma, (dark ? 64 : 43) + fade, alpha);
    }
    if (node.focus === NORMAL) {
      return hsl(hue, (owned ? 48 : 13) * chroma, (dark ? 56 : 50) + fade, alpha);
    }
    // suppressed: present, not competing
    return hsl(hue, 10 * chroma, (dark ? 54 : 58) + fade, alpha);
  }

  /* --- labels ------------------------------------------------------------- */

  /**
   * Zoom decides how much text the view can hold; priority never enters into it.
   * A hovered node is always named — that is the answer to "which of these dots
   * did my enlarged hitbox just grab".
   *
   * A canvas label is a claim on the reader's attention, so status changes how
   * hard a note has to earn one. Explored notes never earn one no matter how
   * far you zoom. Unexplored notes earn one only past a second, deeper zoom
   * tier. Hover still names anything — that is a question you asked about one
   * dot, not the map volunteering fifty answers at once.
   */
  shouldLabel(node: RNode, scale: number): boolean {
    if (node === this.hovered) return true;
    // In focus mode the neighbourhood is named whatever the zoom and whatever
    // its status — those are the answers to the question being asked — and
    // nothing else is, so the names on screen are exactly the connections.
    if (this.focusId !== null) return !!this.focusSet[node.id];
    // The project in the slot is named at every zoom: a landmark you navigate
    // by, not a detail that earns its place only once you have zoomed in.
    if (node.isSlotted) return true;
    const status = node.status || NO_STATUS;
    if (status === EXPLORED) return false;
    if (status === UNEXPLORED) return scale >= UNEXPLORED_ZOOM;
    if (node.isParent && node.kind !== PHANTOM) return scale >= PROJECT_ZOOM;
    return scale >= NOTE_ZOOM;
  }

  /**
   * The zoom past which a node's label would actually show, mirroring
   * shouldLabel's thresholds. Used to pick where centerOnNode lands, so "zoom
   * to this node" and "the label you zoomed in to see" are the same promise.
   */
  labelZoomFor(node: RNode): number {
    if (node.isSlotted) return PROJECT_ZOOM;
    const status = node.status || NO_STATUS;
    if (status === EXPLORED) return NOTE_ZOOM; // never labels; still frame it normally
    if (status === UNEXPLORED) return UNEXPLORED_ZOOM;
    if (node.isParent && node.kind !== PHANTOM) return PROJECT_ZOOM;
    return NOTE_ZOOM;
  }

  labelInk(node: RNode): string {
    const alpha = node.focus === PRIORITY ? 0.95 : node.focus === NORMAL ? 0.8 : 0.55;
    return this.dark ? "rgba(236,233,228," + alpha + ")" : "rgba(27,26,24," + alpha + ")";
  }

  haloStyle(): string {
    return this.dark ? "rgba(18,18,22,0.88)" : "rgba(242,240,237,0.88)";
  }

  /* --- painting ----------------------------------------------------------- */

  paintNode(node: RNode, ctx: CanvasRenderingContext2D, scale: number): void {
    if (!scale || !isFinite(scale)) scale = 1;
    const r = this.radius(node);
    const shape = this.shapeOf(node);

    if (node.id === this.focusId) {
      // The subject wears a halo: a soft disc in its own hue, then a thin
      // ring, both scale-corrected so they hold at any zoom. The disc is what
      // reads from across the map; the ring is what reads up close. Painted
      // under the node so the shape itself stays crisp.
      const hue = this.hueOf(node);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 9 / scale, 0, 2 * Math.PI);
      ctx.fillStyle = hsl(hue, 60, this.dark ? 62 : 48, 0.16);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4.5 / scale, 0, 2 * Math.PI);
      ctx.strokeStyle = hsl(hue, 62, this.dark ? 70 : 42, 0.85);
      ctx.lineWidth = 1.4 / scale;
      ctx.stroke();
    }

    traceShape(ctx, shape, node.x, node.y, r);
    if (node.kind === PHANTOM) {
      // Hollow: an intention that has not been written yet. The stroke is
      // scale-corrected, or the ring disappears at the zoom you start at.
      ctx.strokeStyle = this.fill(node);
      ctx.lineWidth = 1.1 / scale;
      ctx.stroke();
    } else {
      ctx.fillStyle = this.fill(node);
      ctx.fill();
    }

    if (node === this.hovered) {
      // The hit area is much larger than the dot, so say which dot it caught.
      // Traced in the node's own shape: at the zoom where the dot is too small
      // to read, the ring is what actually shows you its datatype.
      traceShape(ctx, shape, node.x, node.y, r + 3 / scale);
      ctx.strokeStyle = this.dark ? "rgba(236,233,228,0.7)" : "rgba(27,26,24,0.55)";
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
    }

    if (!this.shouldLabel(node, scale)) return;
    // Divide by the zoom scale so labels stay a constant size on screen. Drawn
    // in graph units they shrink to nothing the moment you zoom out, which is
    // exactly when you most need to know which region you are looking at.
    const subject = node.id === this.focusId;
    const size = (node.isSlotted || subject ? 13 : node.isParent ? 11 : 10) / scale;
    ctx.font = (node.isParent || node.isSlotted || subject ? "600 " : "") + size + "px " + this.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const baseline = node.y + r + 3 / scale;
    if (node.isSlotted || subject) {
      // Shown at every zoom, so unlike other node labels it has to survive being
      // drawn straight over its own cluster.
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = this.haloStyle();
      ctx.strokeText(node.label, node.x, baseline);
    }
    ctx.fillStyle = this.labelInk(node);
    ctx.fillText(node.label, node.x, baseline);
  }

  /**
   * Member centroids for every domain, cached. Domains have no node of their
   * own, so their label has to be placed from their members — and it has to
   * keep up while the simulation is still settling, hence the refresh cadence.
   */
  domainCentroids(): ({ x: number; y: number } | null)[] {
    this._frame++;
    if (!this._centroidsStale && this._frame % CENTROID_EVERY !== 0) return this._centroids;
    this._centroidsStale = false;

    const sums = this.domains.map(() => ({ x: 0, y: 0, n: 0 }));
    for (const node of this.nodes) {
      const sum = sums[node.domain]; // domain -1 (unowned) indexes nothing
      // A filtered-out member must not drag its domain's name across the map
      // toward territory that is no longer drawn.
      if (!sum || typeof node.x !== "number" || !this.visible(node)) continue;
      sum.x += node.x;
      sum.y += node.y;
      sum.n++;
    }
    this._centroids = sums.map((sum) => (sum.n ? { x: sum.x / sum.n, y: sum.y / sum.n } : null));
    return this._centroids;
  }

  /**
   * Domain names, drawn over the graph at every zoom level. These are the one
   * label that is never gated: zoomed all the way out the map still has to tell
   * you which regions of your life you are looking at. Non-priority domains are
   * grey and quiet, priority ones take their hue — colour, not presence, is the
   * channel that says which region you chose.
   */
  paintDomainLabels(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!scale || !isFinite(scale)) scale = 1;
    const centroids = this.domainCentroids();
    if (!centroids.length) return;

    ctx.save();
    // Noticeably larger than a note label, so the two never read as one list.
    ctx.font = "700 " + 16 / scale + "px " + this.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Cohesion keeps domains apart, but a user can always build two domains whose
    // members genuinely interleave. A nudged label beats an unreadable one.
    const lineHeight = 16 / scale;
    const slots: { x: number; y: number; half: number; domain: GraphPayload["domains"][number] }[] = [];
    for (let i = 0; i < centroids.length; i++) {
      const at = centroids[i], domain = this.domains[i];
      if (!at || !domain) continue;
      const half = ctx.measureText(domain.label).width / 2;
      let y = at.y;
      for (let attempt = 0; attempt < slots.length; attempt++) {
        let clash: (typeof slots)[number] | null = null;
        for (const other of slots) {
          if (Math.abs(at.x - other.x) < half + other.half && Math.abs(y - other.y) < lineHeight) {
            clash = other;
            break;
          }
        }
        if (!clash) break;
        y = clash.y + lineHeight * 1.15;
      }
      slots.push({ x: at.x, y, half, domain });
    }

    // Region names are a map-level answer; in focus mode they step back so
    // the neighbourhood's own names are the only text at full strength.
    if (this.focusId !== null) ctx.globalAlpha = 0.28;
    for (const slot of slots) {
      ctx.fillStyle = slot.domain.priority
        ? hsl(slot.domain.hue, 58, this.dark ? 70 : 36)
        : this.dark ? "rgba(165,161,154,0.30)" : "rgba(86,83,77,0.30)";
      ctx.fillText(slot.domain.label, slot.x, slot.y);
    }
    ctx.restore();
  }

  /**
   * A link takes the quieter of its two ends, in both focus and status. A
   * greyed-out explored note still drew a coloured line up to its parent, which
   * kept it in the picture the node itself had left — the line is part of the
   * note, and recedes with it. Only hierarchy edges get the elevated grey: a
   * mention is not the structural claim a parent link is.
   */
  linkColor(link: RLink): string {
    const source = link.source, target = link.target;
    const sNode = typeof source === "object", tNode = typeof target === "object";
    if (this.focusId !== null) {
      if (!this.focusLinks[link.index]) {
        return this.dark
          ? "rgba(150,146,140," + FOCUS_DIM_LINK_ALPHA + ")"
          : "rgba(40,38,34," + FOCUS_DIM_LINK_ALPHA + ")";
      }
      // The neighbourhood's wiring, in the subject's own hue: the lines are
      // the answer to "what is this connected to", so they are as loud as the
      // note itself. Hierarchy and mention still differ by width and arrow.
      const subject = this.byId[this.focusId];
      const fh = subject ? this.hueOf(subject) : NEUTRAL_HUE;
      return hsl(fh, subject && subject.domain >= 0 ? 55 : 20, this.dark ? 66 : 42, FOCUS_LINK_ALPHA);
    }
    const focus = Math.min(sNode ? (source as RNode).focus : NORMAL, tNode ? (target as RNode).focus : NORMAL);
    const quiet = Math.max(
      sNode ? STATUS_QUIET[(source as RNode).status || 0] : 0,
      tNode ? STATUS_QUIET[(target as RNode).status || 0] : 0,
    );
    const hierarchy = link.kind === HIERARCHY;
    const dark = this.dark;
    const suppressed = focus === SUPPRESSED;

    // An explored parent link, still in focus: grey, but a note the vault
    // itself says is organised under a done parent still reads as structure —
    // not as light as a plain suppressed line, a little brighter than a
    // regular mention.
    if (hierarchy && quiet === 2 && !suppressed) {
      return dark
        ? "rgba(150,146,140," + EXPLORED_HIERARCHY_ALPHA + ")"
        : "rgba(40,38,34," + (EXPLORED_HIERARCHY_ALPHA * 0.8).toFixed(3) + ")";
    }

    if (suppressed || quiet === 2) {
      // Grey, and fainter still when it is explored work rather than merely
      // out of focus: done is quieter than not-chosen.
      const a = quiet === 2 ? 0.07 : 0.1;
      return dark ? "rgba(150,146,140," + a + ")" : "rgba(40,38,34," + (a * 0.8).toFixed(3) + ")";
    }
    const hue = sNode ? this.hueOf(source as RNode) : NEUTRAL_HUE;
    if (hierarchy) {
      return hsl(hue, focus === PRIORITY ? 52 : 30, dark ? 58 : 46, quiet === 1 ? 0.36 : 0.6);
    }
    const alpha = quiet === 1 ? 0.15 : 0.26;
    return dark ? "rgba(180,176,168," + alpha + ")" : "rgba(40,38,34," + (alpha * 0.77).toFixed(3) + ")";
  }

  /* --- public interface --------------------------------------------------- */

  /** Load a full payload. Resets the simulation. */
  setData(payload: GraphPayload): void {
    const n = payload.nodes;
    this.domains = payload.domains || [];
    this.datatypes = payload.datatypes || [];
    const nodes: RNode[] = n.id.map((id, i) => ({
      id, label: n.label[i], kind: n.kind[i], size: n.size[i],
      x: n.x[i], y: n.y[i], domain: n.domain[i],
      isParent: !!n.isParent[i], isSlotted: !!(n.isSlotted && n.isSlotted[i]),
      datatype: n.datatype ? n.datatype[i] : -1,
      status: n.status ? n.status[i] : 0,
      focus: n.focus[i],
    }));
    this.nodes = nodes;
    this.byId = {};
    for (const node of nodes) this.byId[node.id] = node;
    this._centroidsStale = true;

    const links: RLink[] = payload.links.source.map((s, i) => ({
      index: i, source: n.id[s], target: n.id[payload.links.target[i]], kind: payload.links.kind[i],
    }));
    this.links = links;
    // A rescan renumbers links, so a focus carried across it is recomputed
    // from the id rather than trusted.
    if (this.focusId !== null) this.setFocus(this.byId[this.focusId] ? this.focusId : null);

    this.graph.width(this.el.clientWidth).height(this.el.clientHeight).graphData({ nodes, links });
  }

  /**
   * Update focus and domain colouring in place. Deliberately does not touch
   * positions: choosing a priority should change what stands out, not
   * rearrange the map underneath you.
   */
  applyFocus(payload: GraphPayload): void {
    const n = payload.nodes, byId = this.byId;
    this.domains = payload.domains || [];
    // Shapes are a pure repaint: giving a category a shape changes what a node
    // looks like, never where it sits, so this needs no reheat.
    this.datatypes = payload.datatypes || [];
    let regrouped = false;
    n.id.forEach((id, i) => {
      const node = byId[id];
      if (!node) return;
      node.focus = n.focus[i];
      if (n.datatype) node.datatype = n.datatype[i];
      if (n.status) node.status = n.status[i];
      node.isSlotted = !!(n.isSlotted && n.isSlotted[i]);
      if (node.domain !== n.domain[i]) regrouped = true;
      node.domain = n.domain[i];
      node.isParent = !!n.isParent[i];
    });
    // Membership may have moved between domains, so the centroids owe a redraw
    // even though not a single node has moved.
    this._centroidsStale = true;
    // Filing a project under a domain is a structural claim about the map, so the
    // clusters should re-form. A mere priority change is not, and must leave every
    // position untouched — hence the guard rather than an unconditional reheat.
    if (regrouped) this.graph.d3ReheatSimulation();
  }

  /**
   * Re-read the host's size. Called by the view on resize and when the leaf
   * is shown: a leaf resized while display:none measured the host at 0x0,
   * and a 0x0 canvas is a blank view.
   */
  resize(): void {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w > 0 && h > 0) this.graph.width(w).height(h);
  }

  /**
   * Frame the bulk of the layout — the view you re-orient by. The centre is
   * the median rather than the mean, so the outer halo cannot drag the frame
   * off the mass it is meant to be centred on.
   */
  fitAll(): void {
    const nodes = this.nodes.filter(placed).filter((n) => this.visible(n));
    if (nodes.length < FIT_MIN_NODES) {
      this.graph.zoomToFit(500, 70);
      return;
    }
    const cx = median(nodes.map((n) => n.x));
    const cy = median(nodes.map((n) => n.y));
    const radius = (node: RNode) => {
      const dx = node.x - cx, dy = node.y - cy;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const radii = nodes.map(radius).sort((a, b) => a - b);
    // A quantile of the real radii, so at least one node always qualifies and
    // the filter can never select nothing (which zoomToFit would ignore).
    const cutoff = radii[Math.floor((radii.length - 1) * FIT_QUANTILE)];
    this.graph.zoomToFit(500, 70, (node) => placed(node) && this.visible(node) && radius(node) <= cutoff);
  }

  /** Pan to a node and zoom so its label is actually readable. */
  centerOnNode(id: string): void {
    this._userMoved = true;
    const node = this.byId[id];
    if (!node || typeof node.x !== "number") return;
    this.graph.centerAt(node.x, node.y, 500);
    // Past the threshold, not equal to it — shouldLabel's check is >=, but
    // landing exactly on the boundary is one floating-point rounding away
    // from missing it, which is a worse failure than being a touch closer.
    this.graph.zoom(this.labelZoomFor(node) + 0.15, 500);
  }

  /** Pan to a domain's centroid. */
  centerOnDomainById(domainId: string): void {
    this._userMoved = true;
    const idx = this.domains.findIndex((d) => d.id === domainId);
    if (idx < 0) return;
    const c = this.domainCentroids()[idx];
    if (!c) return;
    this.graph.centerAt(c.x, c.y, 500);
    this.graph.zoom(1.2, 500);
  }

  /* --- focus mode --------------------------------------------------------- */

  /**
   * Make one node the subject: it and its immediate neighbours (both
   * directions) light up, everything else recedes. null clears. Purely a
   * view, like the filter — no position moves, and clearing restores the map
   * exactly.
   */
  setFocus(id: string | null): void {
    this.focusId = null;
    this.focusSet = {};
    this.focusLinks = {};
    if (id === null || !this.byId[id]) {
      this._centroidsStale = true;
      return;
    }
    this.focusId = id;
    this.focusSet[id] = true;
    for (const l of this.links) {
      // Endpoints are ids until the first tick resolves them into objects.
      const s = endpointId(l.source), t = endpointId(l.target);
      if (s === id) { this.focusSet[t] = true; this.focusLinks[l.index] = true; }
      else if (t === id) { this.focusSet[s] = true; this.focusLinks[l.index] = true; }
    }
    this._centroidsStale = true;
  }

  /**
   * The subject's neighbours, split by direction, for the dossier. `out` is
   * what this note points at (its parent included), `in` is what points at it.
   */
  neighbours(id: string): { out: { node: RNode; kind: number }[]; in: { node: RNode; kind: number }[] } {
    const out: { node: RNode; kind: number }[] = [], inn: { node: RNode; kind: number }[] = [];
    for (const l of this.links) {
      const s = endpointId(l.source), t = endpointId(l.target);
      if (s === id && this.byId[t]) out.push({ node: this.byId[t], kind: l.kind });
      else if (t === id && this.byId[s]) inn.push({ node: this.byId[s], kind: l.kind });
    }
    return { out, in: inn };
  }

  /**
   * Frame the current neighbourhood: every lit neighbour on screen, the
   * subject in the middle, capped so a lone note is not a wall of pixels.
   */
  focusOn(id: string): void {
    this._userMoved = true;
    const subject = this.byId[id];
    if (!subject || typeof subject.x !== "number") return;
    // The box is measured as half-extents from the subject, not as the
    // neighbourhood's own bounds: the subject belongs in the middle of the
    // screen, and a box symmetric about it is the one that keeps the
    // neighbours on screen once it is. The farthest neighbour on each axis
    // sets the extent — parent, child or mention alike, whichever direction
    // the edge runs — because every one of them is lit, and lit means shown.
    let ex = 0, ey = 0, any = false;
    for (const nid in this.focusSet) {
      const n = this.byId[nid];
      if (!n || !placed(n) || !this.visible(n) || n === subject) continue;
      any = true;
      ex = Math.max(ex, Math.abs(n.x - subject.x));
      ey = Math.max(ey, Math.abs(n.y - subject.y));
    }
    if (!any) { this.centerOnNode(id); return; }
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    // A zero extent on an axis (every neighbour dead level with the subject)
    // divides to Infinity, and the ceiling takes it from there.
    let k = Math.min(Math.max(w - 2 * FOCUS_FIT_PAD, 1) / (2 * ex), Math.max(h - 2 * FOCUS_FIT_PAD, 1) / (2 * ey));
    k = Math.min(FOCUS_ZOOM_MAX, k);
    this.graph.centerAt(subject.x, subject.y, 600);
    this.graph.zoom(k, 600);
  }

  /**
   * Hide whole datatypes or statuses. Purely a view: nothing is recomputed, no
   * position moves, and clearing the filter restores exactly the map you had.
   */
  setFilter(hidden: Record<string, boolean>): void {
    this.hidden = hidden || {};
    this._centroidsStale = true;
  }

  positions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const id of Object.keys(this.byId)) {
      const node = this.byId[id];
      if (typeof node.x === "number") out[id] = [+node.x.toFixed(2), +node.y.toFixed(2)];
    }
    return out;
  }
}
