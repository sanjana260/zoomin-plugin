# ZoomIn — Design

A personal organization app that reads an Obsidian vault **read-only** and re-renders it as
a graph, so you can situate yourself and deliberately choose where your attention goes.

This is a living document. It records not just what we're building, but why — and what each
decision rules out.

---

## 1. Design philosophy

### The map is for situating yourself — not for organizing tasks

The graph answers "where am I, and what is near me?" It is not a to-do list with edges.

*Rules out:* task CRUD, due dates, checkbox toggling, anything that makes the graph a place
where work is recorded rather than located. Tasks live in Obsidian; ZoomIn shows you which
region of your life they sit in.

### Suppression over expansion

Attention is not a limitless quantity. The primary act in this app is deciding what **not**
to look at. Prioritizing a domain is meaningful only because it costs you the others.

*Rules out:* "add everything and filter later." Every feature must answer: does this help
allocate a fixed budget, or does it just add more surface?

### Structure should show everything — activity should be focused on priority regions

You choose which regions to explore. The regions you've explored always stay on the map.
Nothing is deleted from the picture; suppressed regions recede, they don't vanish.

*Rules out:* hiding, filtering-away, or collapsing non-priority nodes. Suppression is
visual (desaturate and fade), never structural — and never a change of *size*, because size
is how the map says "this is structurally central", which priority does not alter.

*Tension to manage:* a 5,000-node force-directed graph is unreadable no matter how it's
coloured. "Show everything" has to mean *nothing is removed*, with representation changing
by zoom level — not 5,000 labelled circles at once.

### Constraints need friction

Force prioritization and make it stick. A cap you can widen the moment it pinches is
decoration.

*v1 status:* deliberately relaxed. Slots are hard-capped but freely changeable, and every
change is recorded in `slot_history`. Friction mechanics (cooldowns, written reasons,
review-gated swaps) are deferred until the caps have been lived with. The record is being
kept from day one so that friction can be added later against real data.

### We read the vault; we write four fields, deliberately

ZoomIn renders your vault differently. Through v1 it wrote nothing at all. That changed in
v2, first for exactly one field — `status:`, editable by clicking it on a node's hover card
— and then, with focus mode, for three more: `Parent:`, `categories:` and `deadline:`,
editable from a note's dossier. The argument is the same each time: marking a thing
explored, moving it under a different parent, calling it a task, giving it a date — these
are acts of attention management, and making you leave the map to do them in Obsidian
defeats the point of the map. Each widening was argued against the standard below and
recorded (decisions 17, 34).

Everything else still holds: no files created, no dotfolder inside the vault, no other
frontmatter key touched. All app state still lives in
`~/Library/Application Support/ZoomIn/`.

The replacement guarantee is narrow and *tested rather than asserted* — see
`vault/write.py` and the tests around it. Every field goes through one splicing primitive,
so there is one guarantee, not four:

* only the named entry changes; every other byte of the file, body included, survives;
* the note's own key spelling, indentation and line endings are preserved, so a ZoomIn edit
  is indistinguishable from one you typed;
* the file is re-read immediately before writing, so an edit made in Obsidian since the last
  scan is carried forward rather than clobbered;
* the result is re-parsed before it is committed, and a write that would not read back as
  the value asked for is abandoned;
* the replacement is atomic, so an interrupted write cannot truncate a note;
* each field is written in the one form the vault was measured to use — quoted bare-stem
  wikilink, one-item block list, unquoted ISO date — and clearing leaves an empty key, as
  the vault itself does.

*Rules out:* still no UUIDs in frontmatter, no MOC notes, no tagging notes with modes.
Identity is still inferred from content.

*Consequences to own:* two editors on one file cannot be arbitrated — if a note is open in
Obsidian with unsaved changes, whichever writes last wins, and Obsidian reloads on an
external change. And the door is open: every future "just one more field" has to be argued
against this same standard, or read-only erodes one convenience at a time. Four is where
it stands; the list above is the whole list.

---

## 2. Vault contract

### Read-only guarantee

All vault file access goes through a single helper that opens files in mode `'r'`. A test
asserts the package contains no write-mode file access, and a second test snapshots
`(path, mtime_ns, size)` for every vault file before and after a full scan to prove nothing
was touched.

### What we read

| Source | Use |
|---|---|
| `.md` files | Nodes |
| `[[wikilinks]]` in body | Associative edges |
| `Project:` frontmatter wikilink | **Hierarchy edges** — child → parent |
| `categories:` frontmatter wikilink | Note type (`[[Projects]]` marks a project note) |
| `tags:` frontmatter | Structural type, kept as metadata |
| `.obsidian/app.json` | Config folder detection, excluded-file patterns |
| `~/Library/Application Support/obsidian/obsidian.json` | Auto-detect the active vault |

### What we deliberately ignore

- **Inline `#tags`** — measured at 3 occurrences across the whole vault. Not a signal here.
- **Non-`.md` embeds** — see trap 1 below.
- **`Templates/` and `Attachments/`** — scaffolding, not thinking.
- **Aliases for link resolution** — Obsidian itself doesn't resolve them (see §3).

### Trap 1 — `.base` embeds are graph poison

Every project note in this vault embeds the same six template bases (`Tasks`, `Ideas`,
`Entries`, `Meetings`, `References`, `Project base`). 111 of 170 embeds point at just those
six files. Treated as edges they create a false hub joining every project to every other,
and the graph turns to mush.

**Rule:** embeds are parsed, but only embeds whose target is a `.md` file become edges.
Never `.base`, images, or PDFs.

### Trap 2 — mtime is dead, git is noisy

The vault syncs via `git-obsi-sync`, which writes bulk commits. Consequences:

- File mtimes are rewritten by sync, so 342 of 344 notes look "edited in the last 30 days."
  **Never trust mtime alone** as an activity signal.
- Per-file commit *counts* remain well differentiated (132 for `Quantum Computing CMU.md`
  vs single digits for most), so git history is usable — but bulk-sync commits (touching
  more than ~20 files) must be discarded first.

Not needed for v1. Recorded here because decay depends on it.

---

## 3. Obsidian format notes

Three rules that reimplementations usually get wrong, all verified against Obsidian's own
docs and issue tracker:

1. **Vault-absolute beats relative-to-source.** With `A.md` at root and `Folder/A.md`, a
   `[[A]]` written inside `Folder/B.md` resolves to the **root** file. Obsidian's stated
   intent: `[[A]]` should mean the same note everywhere in the vault.
2. **Aliases are not consulted during resolution.** `getFirstLinkpathDest` never reads
   `frontmatter.aliases`; Obsidian's maintainers have confirmed this is intentional. A bare
   `[[Alias]]` is an *unresolved* link. Obsidian instead writes `[[Real Note|Alias]]` at
   autocomplete time.
3. **NFC-normalize every path and link target at every boundary.** macOS APFS stores
   filenames NFD-decomposed; text typed elsewhere is NFC. The same mismatch caused a real
   Obsidian regression in 1.13.5 where NFD-named notes vanished from search.

Also: lookup is case-insensitive (`casefold()`), original casing is kept for display, and
paths are sorted before indexing so tie-breaks are deterministic.

**Mask once, extract many.** Before extracting anything, produce a copy of the body with
fenced code blocks, inline code spans, and math replaced by same-length spaces. Then run
every extractor over the masked text. Same-length replacement keeps byte offsets valid, and
one pass means extractors can't contaminate each other.

---

## 4. Model

**Note** — one `.md` file. Identity is a minted `note_id`, never the path.

**Phantom** — a link target that doesn't exist yet. Rendered small and dim. These are
intentions not yet written, which is real signal for an attention app.

**Edges, two kinds, visually distinct:**

- *Hierarchy* — from `Project:` frontmatter. Solid, directed, stronger layout pull.
  62% of notes have one; this is the backbone of the vault.
- *Associative* — body wikilinks and `.md` embeds. Thin, neutral. These are the surprising
  cross-domain connections a map is supposed to reveal.

**Domain** — a region of life. Not a note, and not derived from the vault at all: the user
creates it and types its name, then files projects under it. It has a UUID that never
changes, a name the app never auto-edits, and **no node in the graph** — it reaches the map
only as the colour of the notes beneath it. A project belongs to at most one domain, so
assigning it to a second one moves it.

**Project** — a note the app offers for filing and slotting. Three sources say so, in
order of precedence: your own ruling on that note (made in its dossier, stored in app
state), a *project datatype* (a category flagged so that every note carrying it counts),
and the tree itself (anything something else names in `Parent:`). The app ranks projects
by reach and offers them for filing. The ranking decides what to offer first; it never
decides what belongs with what. (Decisions 18, 36.)

**Slot** — a hard-capped position holding one domain or project. Caps are set at setup.

### Why domains are invented rather than found

The `Project:` tree in this vault has `Personal Projects` as a junk-drawer root holding six
unrelated things (Chess, NYU, Creative World, LLM Project, Life Admin, Better Creativity),
while `Work` is a genuine domain at root level with one project under it. No depth rule
separates those two cases.

An earlier version answered this by ranking candidates and letting the user *promote a note*
to be a domain. That inherited the tree's problem rather than escaping it: a domain could
only ever be as good as some note that already existed, and the junk-drawer root remained the
only available name for its six unrelated children. Domains are now made in the app instead.
"The things I do for money" is a real region of a life with no note behind it — and ZoomIn
must not create one, because we never write to the vault.

---

## 5. Feature roadmap

### v1 — this session

- Setup: vault location (auto-detected), domain slot count, project slot count.
- Full-vault graph with hierarchy and associative edges distinguished.
- Sidebar: your domains, and the ranked projects available to file under them.
- Create and name domains; assign projects; fill priority slots; caps enforced.
- Suppression: non-priority regions desaturate, staying visible and clickable. Size is
  structural only — priority must not make the map rearrange itself when you change
  your mind about it.
- Manual refresh: rescan the vault without restarting, for edits made in Obsidian.
- Deterministic layout, so the graph is the same place every launch.

### Later

*Task view (v2) — landed as the second tab; see decision 28.*

| Feature | Open questions |
|---|---|
| **Node modes** (exploring / active / dormant / priority / distant) | Which are user-set vs derived? Recommendation: `priority` and `exploring` are always user-set; `dormant` and `distant` derived. Automatic promotion is where these systems stop being trustworthy. |
| **Decay** | Half-life on warmth, updated `A ← A·2^(−Δt/H) + w`. Needs de-noised git history, not mtime. Needs hysteresis (enter dormant below 0.15, leave above 0.35) or nodes flicker. Steal FSRS's *stability* idea — notes returned to across long gaps should decay slower — but not its fitted weights, which have no meaning without recall labels. |
| **Weekly review** | Must fit in **five minutes**. See risks. |
| **Output nodes** | What counts as output when the vault is read-only and the output often isn't a note? |
| **Lenses** | Saved priority sets. Cheap once slots exist. |
| **Graph analytics** | Prior art says a panel of numbers goes unused; a single ranked list ("you should probably link these two") gets used. Prefer one Adamic-Adar-style suggestion list over a dashboard. |
| **Agent-generated nodes** | Conflicts with read-only unless generated nodes live only in app state. Decide before building. |
| **Rename recovery** | Match on body-only `content_hash` first (Obsidian doesn't rewrite a moved file's own content), then git `--follow`, then similarity at git's 0.5 threshold, resolved globally not greedily. |
| **Live reload** | v1 has a manual refresh instead: a full rescan is ~20ms per 400 notes, so a button is honest and a file watcher is not yet earned. Automatic would be `watchdog` + FSEvents, debounced ~300ms, excluding `.obsidian/workspace.json` which is rewritten constantly. |
| **Plain-text export** | Not optional — it's the answer to "what happens to my history if ZoomIn dies." |

---

## 6. Decisions log

| # | Decision | Reasoning |
|---|---|---|
| 1 | **pywebview + FastAPI**, hand-written frontend | Every stack that renders thousands of interactive nodes smoothly is WebGL/Canvas; native Python renderers cap out near 1–2k nodes and require hand-writing physics, picking and labels. pywebview uses the system WKWebView, so there's no Chromium to ship. Hand-writing the frontend was chosen over NiceGUI for total control of the visual language, which *is* the product here. |
| 2 | **Vendored `force-graph` UMD, no build step** | Node.js isn't installed on this machine. A single pre-built `.js` file means no npm, no bundler, and it works offline. |
| 3 | **Domains are user-created groupings, not notes** | The tree has a junk-drawer root, no depth rule works, and the domain you actually mean often has no note at all. See §4. |
| 4 | **Notes + phantoms**, minus `Templates/`/`Attachments/`; non-`.md` embeds never become edges | Trap 1. Phantoms are intentions not yet written. |
| 5 | **Slots freely changeable in v1**, but every change recorded | Friction should be designed against lived experience, not guessed. The record costs nothing now and is required later. |
| 6 | **Desaturate**, never hide — and never resize | Directly implements "structure should show everything." Chroma and lightness against a fixed per-domain hue carry the signal. Size stayed structural (in-degree, plus a nudge for being a project) so that choosing a priority recolours the map instead of rearranging it; a graph that reflows on every selection destroys the spatial memory the whole app is built on. |
| 7 | **`note_id` primary key, path as alias** | The one thing genuinely expensive to retrofit. Costs nothing now. |
| 8 | **SQLite + `PRAGMA user_version` migrations** | Alembic's value is autogenerate-from-ORM; there's no ORM here. A 25-line migration ladder is the whole need. |
| 9 | Migration 2 **drops the old `domain`/`slot` rows** instead of converting them | Every old row named a promoted *note*, and there is no honest translation of that into a grouping the user never made. Guessing would put words in their mouth. `note`, `slot_history` and `node_position` are kept, so identity and the attention record survive. |
| 10 | **Labels are gated by zoom, never by priority** | Priority regions used to dump every label at once, which made the thing they were meant to clarify unreadable. Detail is now a function of zoom and structural role — domains always, projects past one threshold, individual notes past another — so zooming far enough reveals *everything*, including inside suppressed regions. Priority speaks only through colour and opacity.  The one exception is the project currently in a slot: it is named at every zoom, at landmark weight with a halo. That node is not a detail you zoom in to find — it is the thing you have committed to, and it works like a domain name. |
| 11 | **A gentle force pulls each domain's members together** | Domains are user-defined and cut across the vault's `Project:` hierarchy, so the layout had no idea those notes belonged together. Measured on a real setup, "Data Science" had a spread radius of 429 while sitting only 203 from "Life"'s centroid: both labels rendered in empty space, on top of each other. Cohesion at 0.20 brought spreads to 147/111/57 against separations of 386–488. It also makes the map honest — if you declared the grouping, it should be a place you can point at. |
| 12 | **Subprojects inherit their parent project's domain** | Filing `Work` should not mean filing `Prepay Anomaly`, `EDA app` and everything else beneath it by hand — the vault's `Project:` tree already says they belong together. An explicit assignment on a child overrides the inherited one. |
| 13 | **Removing an inherited project writes an explicit "unfiled" tombstone** | Otherwise unticking a subproject in a domain's dialog would do nothing: the next read would re-derive the same membership from its parent and the project would silently reappear. A row with a NULL domain means "decided: not in any domain", and it stops the walk up the tree rather than falling through. Deleting a domain clears its tombstones along with its assignments. |
| 14 | **A centering force holds the graph together** | force-graph ships d3's `forceCenter`, which only translates the system so its centroid sits at the origin — it creates no attraction. So nothing counteracted charge repulsion on notes that no link holds in place, and the unlinked half of a vault (daily notes, loose captures) drifted outward indefinitely. Measured: 310 nodes over ~5000 units, fitting at zoom 0.115, which draws every leaf note at under one screen pixel — the map had quietly stopped satisfying the 0.4–0.6 opening zoom that the semantic-zoom thresholds in decision 10 were calibrated against. Swept 0.01–0.30; 0.05 restores the fit to 0.545 and makes nodes ~3x larger. Domains do not smear together — mean spread moves only 71→62 units — and because the fit zoom grows faster than the gaps shrink, domain labels end up *further* apart on screen (62px→150px). Stronger settings flatten the map toward one disc and push the opening view against `PROJECT_ZOOM`. |
| 15 | **Datatypes are categories the user gives a shape to, sourced from both the `Categories/` folder and actual use** | The literal brief was "a list extracted from the Categories folder", but the vault disagrees with itself: the three most-used values — `Task` (113 notes), `Idea` (32), `Reference` (9) — have no note anywhere, while 16 of the 22 notes in `Categories/` are used by nothing. The folder alone would offer 22 options, 16 of them dead, and make the commonest type undefinable — including `Task`, which the task dashboard is built on. So the list is the union, ranked by use, with each row saying which source it came from. A datatype therefore keys on the category *name*, not a note_id. Categories are deliberately never edges: 113 notes sharing `Task` would be a phantom hub joining a third of the graph, the same trap that excluded non-`.md` embeds. Shapes are equal-area against the circle, because size is structural (decision 6) and a square drawn at the circle's radius carries 27% more ink — giving a category a shape would otherwise look like promoting every note in it. |
| 16 | **Status is a second visual axis, crossing focus** | `status:` says how far through a thing you are; focus says which region of your life you chose. They multiply rather than compete: exploring keeps full chroma, unexplored keeps its hue at 55% chroma and fades 5 L-points toward the background, explored drops to 10% chroma and half alpha. Measured contrast against the canvas runs 4.61 / 3.47 / 1.94 for priority and 1.86 / 1.63 / 1.40 for suppressed — monotonic in both themes, and the 0.38 alpha floor keeps even a suppressed explored note above invisibility and fully clickable. "Slightly lighter" is implemented as *toward the background*, up in light mode and down in dark: taken literally it would make an unexplored note louder than an exploring one on a dark canvas, which inverts the intent. A missing status is its own level rendering identically to exploring, because 92 of 314 notes never set the field and styling them as "not started" would assert something their author never did. |
| 17 | **Status is editable from the map, making ZoomIn read-write on one field** | The first reversal of a founding principle (§1), taken knowingly: cycling a node's status from its hover card is the whole loop the map exists to support, and bouncing to Obsidian to type a word breaks it. The blast radius is held down by making the write surgical rather than a YAML round-trip — re-serialising frontmatter would reorder keys and restyle quoting across the vault, turning one field edit into a diff on every note. So `write.py` splices a single line, preserves the note's own key casing, indentation and line endings, re-reads immediately before writing so an Obsidian edit is not clobbered, re-parses the result and abandons the write if it would not read back correctly, and replaces atomically. The static test that no vault module opens a file for writing now exempts exactly one module, and behavioural tests pin the byte-level guarantee. What cannot be solved is two editors on one file: last writer wins. |
| 18 | **`Parent:` replaces `Project:`, and having children is the whole criterion for parenthood** | The vault moved its hierarchy key, and ZoomIn had gone nearly blind to it: 202 notes carry `Parent:`, only 2 still carry `Project:`, so the tree the app drew had collapsed to a handful of associative links. The rename is also a widening — anything can be a parent, not just a note declaring `categories: [[Projects]]`. Self-declared type is out; being pointed at is in. On the reference vault this yields 21 parents against the old rule's ~20, so the sidebar stays readable and the two rules mostly agree on the same notes anyway. No fallback to `Project:` was added: a shim would silently re-attach the two stragglers (`Projects/Prepay Anomaly.md`, `References/Hobbies.md`) and hide the inconsistency instead of surfacing it. "Projects" survives as the user-facing word in the sidebar and the slots, because that is what these things are in the user's head; `parents()` is what the tree calls them. |
| 19 | **Node size is 1 + sqrt(direct children), not in-degree** | Size answers "how much hangs off this". In-degree answered "how often is this mentioned", which let a note linked from a dozen daily notes outweigh one that actually organises a dozen others — and after decision 18 it stopped tracking structure at all, maxing at 3 against 26 direct children for the biggest parent, flattening the map to near-uniform dots. The square root holds the tail: 293 of 314 notes have no children, so linear scaling would put a 26x node beside a crowd of 1s. Parents get no separate size bonus any more — one child already doubles a note against a leaf, and the old `PROJECT_SIZE_BOOST` plus the renderer's 1.18x radius nudge were the same claim made twice. Subtree size still exists and still ranks the sidebar; it is a different question from what the map draws. |
| 20 | **A status change cascades to the whole subtree, set rather than cycled** | "Work is explored" with Prepay's children still exploring is a contradiction, and marking them by hand one at a time was the chore the click exists to remove. The clicked note cycles; every descendant is then *set* to the result, so a parent and its subtree always agree. Subtree rather than direct children because the trees are shallow (depth 2, largest subtree 40) and the semantics are transitive — a done parent has no undone parts. Each file is written atomically but the set is not a transaction; a failure part-way says how far it got and a second click finishes. The symmetric case (cycling a parent to *exploring* marks forty notes in progress) is semantically odd but is the rule as asked; worth revisiting if it bites. |
| 21 | **Links follow the quieter of their two ends; unexplored recedes a clear step** | An explored note had gone grey while its line to its parent stayed coloured, keeping it in a picture the node itself had left — the line is part of the note. Links now take the quieter of both endpoints in both focus and status, and explored links sit below suppressed ones (0.07 vs 0.10 alpha): done is quieter than not-chosen. Unexplored alpha dropped from 0.92/0.82/0.62 to 0.74/0.64/0.48 across priority/normal/suppressed so "not started" is unmistakably behind "in progress"; ordering stays monotonic in both themes. |
| 22 | **Filters are collapsible sections with All/None each; the hover card is gated by zoom** | Two filters (datatype, status) in one popover as foldable groups. Each header carries its own All · None when open; folded, it carries only "n hidden" — a collapsed filter silently removing half the map is the worst kind of quiet. A global Clear appears only while something is hidden, so the resting state has no extra controls. Zoomed out, only parents earn the hover card; other nodes show just their canvas label, because at that zoom the map is about regions and the card kept landing on dots the pointer only brushed. Everything gets the card from `NOTE_ZOOM` — the level at which a single note is what you are looking at. |
| 23 | **An in-focus explored parent link gets its own grey, above both the suppressed floor and a plain mention** | Decision 21's flattening treated every explored link alike (0.07, same as a plain suppressed line), which erased the distinction between "done and out of your priorities" and "done but still structurally organising a priority region" — a note a parent actually organised is a stronger claim than a passing mention, even once it's finished. A hierarchy edge whose child is explored but not itself suppressed now renders at 0.32: above the plain suppressed grey (0.10, "not as light as the other regular edges") and a little above the ordinary associative-mention baseline (0.26). The quietest combination — explored AND suppressed — is untouched at 0.07, and so is every associative (non-hierarchy) link regardless of status; only the parent edge itself was ever the complaint. Ordering across the hierarchy family stays monotonic: exploring 0.6 > unexplored 0.36 > explored-in-focus 0.32 > plain-suppressed 0.10 > explored-suppressed 0.07. |
| 24 | **Unexplored node opacity drops again, past decision 21's first cut** | Still too close to exploring at a glance. Alpha falls from 0.74/0.64/0.48 to 0.60/0.52/0.42 (priority/normal/suppressed) — kept a further step above the explored floor at every tier (0.60 vs 0.50, 0.52 vs 0.45, 0.42 vs 0.38) so "not started" never reads quieter than "done". Measured contrast against the canvas: exploring 7.0/4.5/3.0, unexplored 3.7/2.6/2.1, explored 2.7/2.1/1.8 — a visibly wider gap from exploring than before, ordering intact in both themes. |
| 25 | **Labels are gated by status: only exploring (and no-status) notes ever get one** | A canvas label is a claim on the reader's attention, and an unexplored or explored note earning one at depth simply restates decision 10's original complaint — zooming in to read a wall of names for work that has not started or is already finished is exactly the clutter labels-by-zoom was meant to prevent. The gate sits ahead of the zoom check in `_shouldLabel`, so it applies to parents and leaves alike; hover is untouched; the slotted project's always-on label is untouched (it is a landmark regardless of status, the same exception decision 10 already carved out). NO_STATUS keeps labelling like EXPLORING, matching decision 16's "NO_STATUS renders like EXPLORING" rule rather than opening a third behaviour. |
| 26 | **A priority project's exploring descendants get their own collapsible list; domain member lists start collapsed** | The exploring list answers "what should I actually touch today" for the one project you slotted, without opening the graph — `/api/priorities` now returns, per priority project, the subtree notes currently `exploring`, sorted by label. It is read-only like the domain member list it mirrors; filing still happens in the domain dialog. Domain member lists in the sidebar now start collapsed on every fresh load rather than remembering only what was explicitly folded shut — with real domain counts (5, 20+ projects), an all-expanded sidebar was a wall of names before you had chosen to look at any of them. |
| 27 | **Unexplored labels return at a second, deeper zoom tier; exploring-list rows carry the note's real shape and colour; centerOnNode actually reaches the threshold it promises** | Three fixes converging on the same idea: the labelling rule from decisions 10/25 should be a ladder, not a cliff. Unexplored notes get their canvas label back, but only past `UNEXPLORED_ZOOM` (4.4, one more doubling past `NOTE_ZOOM`'s 2.2) — exploring work is what you're doing and earns its name first; unexplored is what's next, and waits for one further deliberate scroll. Explored notes are unaffected — decision 25's "never, regardless of zoom" stands, since no amount of zooming turns finished work back into something worth naming. The sidebar's exploring list (decision 26) drew every entry as the same anonymous grey dot despite datatypes existing precisely to make a task visually distinct from a meeting; `/api/priorities` now resolves each entry's shape the same way `build_payload` does for the map, and the sidebar draws it solid-filled in the priority project's own domain hue, so a row and its node read as the same object. `row()` gained an optional `dotIcon` so this didn't require forking the list renderer. Last, `centerOnNode` was found to be zooming to a fixed 2.0 — a hair under `NOTE_ZOOM` (2.2) — so a clicked note's promised label silently never appeared; it now computes the exact threshold that note's status and role actually require (`_labelZoomFor`, mirroring `_shouldLabel`) and lands just past it, verified against a real unexplored note landing at 4.55, past 4.4. |
| 28 | **The task dashboard: priorities become to-dos, and the map gets a second tab** | The graph answers "where am I"; the dashboard answers "what do I do next". A *task* is a note filed `categories: Task` and nothing else — 119 on the reference vault — because an Entry or an Idea is something you wrote, not something you check off. Three lists: the slotted project's exploring tasks (boxed and bordered in its domain's hue, so the region of the map you are inside is the region the list is inside), every exploring task under a priority domain, and a vault-wide feed of tasks with a `deadline:`. Checking a box writes `status: Explored` through the same surgical writer and cascade as the hover card; the row stays for the session, struck through, so a mis-click is one more click to undo — the next refresh drops it. Manual order lives in `task_order`, keyed on note_id so a rename keeps its place, and per list so the focus box and the domain list order independently; whatever has no saved position follows in a stable, path-hashed shuffle rather than reshuffling every visit. The deadline feed is the calendar's order — red within a day or overdue, yellow within a week, grey beyond — and is deliberately not draggable: that order is not the user's to rearrange. Explored tasks are left out of the feed; a finished task's deadline is moot. `deadline:` is read only, never written, and one straggler note using `Due:` is left alone rather than shimmed. |
| 29 | **Domain hues are spaced by perceptual measurement, not hsl degrees; seven is the ceiling of one hue circle** | School (hsl 210) and Career (190) read as the same blue. Measured in OKLCH, whose hue angle is close to perceptually uniform, the live palette's tightest pairs were 35° (Life Admin/Fun, orange/gold), 37° (School/Career) and 46° (Creativity/Data Science) — against a theoretical best of ~51° for seven colours. The fix is not a better seventh hue (the best single swap reached 47°) but re-spacing all of them: a coordinate search maximising the smallest OKLCH gap, with each domain held within ±30 hsl degrees of where it was so "School is blue" stays true, lands every pair at 48–49° (`204, 20, 121, 256, 48, 321, 178`). The eighth hue sits in the widest remaining gap, 30° from Data Science — tellable, not clean; the user has seven domains and the cap is eight. This is as far as hue alone goes: the renderer already spends chroma on status and lightness on focus, so if seven-way distinctness still isn't enough the next channel is a small per-domain lightness offset, not more hues. |
| 30 | **A task due within a week leaves the priority-domain list to the deadline feed** | The feed already lights up every undone task due within `YELLOW_WITHIN` (7) days, red or yellow; listing the same task again, quietly, under its domain was repeated information. `domain_task_paths` now takes `today` and drops what `near_deadline()` says the feed would light — a helper defined through `tier()` rather than a second comparison, so the two lists cannot disagree about where "near" ends (7 days out excluded, 8 kept, overdue excluded). Grey-tier and undated tasks stay, because nothing else is drawing attention to them. The focus box is deliberately untouched: a slotted project's to-dos are a complete checklist, not an attention feed. |
| 31 | **The dashboard is two working columns and a narrow deadline aside; columns scroll on their own; domains filter by chip** | Three equal columns with one page scroll meant a long domain list carried the deadline feed off the bottom of the screen, and gave "by the way, this is due Thursday" the same width as the list you actually work. Now each column is its own scroll container (heading — and the chips — pinned), and deadlines are a 248px aside ruled off to the right, where a row within a week takes the tier's colour across the whole box rather than just the day count; below 1100px the columns stack and share one scroll again, since three independently scrolling boxes in a single narrow column is worse than a long page. The domain column's explanatory hint is replaced by one chip per priority domain carrying its task count; pressing one drains its rows from the list and its hue from the chip — suppression, in the map's own language — and the rows stay in the DOM so a drag order saved while a domain is hidden still includes it. The choice is per-viewer and lives in localStorage like the other folds. |
| 32 | **The dashboard speaks in an instrument-panel voice: a lit focus panel, tracked mono eyebrows, a condensed display face, and a ring checkbox in the row's own colour** | The first cut looked like three lists. The ask was "a control center for getting work done", so the visual language now encodes state in form: the slotted project is a *panel*, washed top-to-bottom in its domain's hue (`color-mix` of the hue into `--surface`, 20% → 6% → 0) rather than framed by a border, because a wash reads as a place you are inside and a border reads as a box around a list. Its eyebrow is uppercase mono at 0.14em tracking — "PRODUCTIVITY · 4 OPEN" — the way a panel labels a gauge, and the project name is set in Avenir Next Condensed at 30px: macOS ships it, the app is macOS-only and works offline (decision 2), so a bundled face beats a webfont that would fall back silently on a bad connection; condensed reads as a panel label and is unmistakably not the SF body text. The checkbox is drawn, not native: an 18px ring (20px in the aside) in `--tick`, which is the row's domain hue in the working lists and the tier colour in the deadline aside — the native square in accent blue matched nothing around it, and a red row carrying a blue box was the specific complaint. Hover swells it 10% and tints the well; the tick pops in on a slight overshoot; both are off under `prefers-reduced-motion`. In the aside the ring moves to the right edge as the row's one action, and the title/meta stack on the left. Layout: the priority-domain list now sits *under* the focus panel in one working column (panel capped at half the height, each region scrolling on its own), so the panel spans the full width and its tasks flow into 300px columns — a wide panel with one skinny list inside it was two-thirds empty. |
| 33 | **Focus mode: one note under a lens, entered from a ⌘O palette, with the sidebar as its dossier** | The map answers "where am I"; focus answers "what is *this*, and what is it wired to". Obsidian's quick switcher (⌘O) is the door, because the hand already knows it, plus a magnifier beside Fit-all. Under the lens everything outside the note and its immediate neighbours (both directions) drops to a grey ghost at alpha 0.16 — deliberately far below the 0.38 suppression floor, because "not chosen this week" and "not the thing being looked at right now" must not read alike — while the neighbourhood's links come up to 0.9 alpha in the subject's hue, every one of them arrowed (associative links included: in focus the question is which way a connection runs), and every neighbour is labelled whatever the zoom or its status, and nothing else is, so the names on screen are exactly the connections. The subject wears a halo (a soft disc and a ring, scale-corrected) and reads at full priority strength regardless of the slots; domain labels step back to 28%. The camera frames the neighbourhood symmetric about the subject, at the 80th-percentile extent rather than the maximum — one mention from across the map would otherwise set the zoom for a hub whose twenty-nine children sit beside it — clamped to 1.4–4.6. The sidebar's three panels step aside for a dossier: category and domain as a mono eyebrow, the name in the display face, description, then a ledger of Status · Parent · Domain · Datatype · Deadline (the first four editable, Domain derived and read-only), an Open-in-Obsidian button, and the links split "points to" / "pointed at by", each hierarchy edge tagged parent/child from the subject's side; clicking a link moves the lens. The hue washes the top of the sidebar, the same hue the halo wears. Escape leaves; the camera stays where you were looking. The palette itself is its own module (`search.js`) with a small contract, so the parent picker is the same palette with a different title. |
| 34 | **The writer widens from one field to four — `Parent:`, `categories:`, `deadline:` join `status:` — through one primitive and one endpoint** | Focus mode asks three questions of one note — where does it belong, what is it, when is it due — and §1's bar for writing is that editing a note's place from the map is the loop the map exists for; bouncing to Obsidian for these breaks it the same way it broke for status. Rather than three new writers, the status writer became one entry-splicing primitive (`set_entry`) with a renderer per field, so four fields share exactly one code path and therefore exactly one guarantee. Each is written in the one form the vault was measured to use: `Parent: "[[Stem]]"` (229 of 229 bare stems; the path form only if a stem is ambiguous, and none is today), a one-item two-space block list under `categories:` in that category's own bare-or-wikilinked habit (Task/Idea/Reference always bare, Meetings/Projects always linked, Entry split 29/11 — so the rule is the majority form, falling back to "has a `Categories/` note"), an unquoted ISO `deadline:`. Clearing leaves an empty key, which is what the vault does (30 empty `Parent:`, 47 empty `categories:`). `POST /api/note/edit` is the second and only other endpoint that writes — one place for every future "just one more field" to make its case — and it rescans only for a parent change, since that alone moves structure; a category or deadline is patched in memory like status. Re-parenting a note under its own descendant is refused (409) rather than written and untangled later. The static test that only `write.py` opens a file for writing is unchanged; the count of writable keys is now the whole list in §1. |
| 35 | **Clicking a node focuses it; Obsidian is one button further** | Since v1 a click opened the note in Obsidian. With a lens available that is the wrong first answer: a click is "tell me about this", and leaving the app is the rarer act. Click now enters focus mode (phantoms included — they have neighbours), and Open in Obsidian sits at the top of the dossier. Clicking the subject again re-frames it. |
| 36 | **Project-ness has three sources — a per-note ruling, a project datatype, and children — ruled in that order, and the two new ones are app state** | Decision 18's rule (a project is what something names in `Parent:`) is right for the vault but blind both ways: it cannot see a project nothing hangs off yet (`Training LLMs Homework 1`, filed `Projects` with no children — the only such note today, as it happens), and it cannot un-see a junk-drawer hub that has some. So a category can be flagged as a project datatype, and a note's dossier can rule it in or out regardless. Precedence is ruling > flag > tree, the same shape as `effective_domain` (an explicit row beats a derived answer), and the tree layer stays pure: `build_hierarchy` receives the two reconciled sets. Both new sources are app state, not frontmatter, because §1 fixes the written fields at four and each of those is a fact about the note; "ZoomIn treats this as a project" is the app's opinion, of a piece with domain filing, and keyed on `note_id` beside it. A ruling would be sticky, so the dossier's single button ("Make a project" / "Remove from projects") clears the ruling whenever the answer it wants is what the automatic sources already give, and writes one only when it disagrees — the override table holds only disagreements, and a removed parent returns the moment you flip it back. (`/api/note` reports `automatic` for this; the reason is no longer shown — one button was the ask.) Ruling a note out does not unparent its children: they still say `Parent:` and still inherit its domain through the chain; it only leaves the Projects list, and if it held the project slot the slot is cleared and recorded. Size is untouched (decision 6): a declared project with no children stays leaf-sized, but earns the project label tier and the always-on hover card. A project datatype need not have a shape, which made the datatype table's shape nullable (migration 6); a shapeless flagged category never wins a note's shape over a shaped one. |
| 37 | **The focus camera frames every lit neighbour, with no quantile and no zoom floor** | Decision 33 fitted the neighbourhood at its 80th-percentile extent and clamped the zoom to 1.4–4.6, so that one body mention from across the map could not set the zoom for a hub. Both the trim and the floor cut *children*: a lens on a parent with 29 children spread ±600 units landed at the 1.4 floor with the outer fifth off screen — and a click on a node is, before anything else, the question "what hangs off this", which a partial list answers wrong. A first cut framed children in full and kept the quantile and floor for the parent and mentions; it was simplified to one rule: every lit neighbour is on screen, whichever direction its edge runs, because under the lens the lit nodes *are* the answer and one that is off screen is an answer withheld. So the farthest neighbour on each axis sets the extent, there is no floor, and only the 4.6 ceiling remains (a two-node neighbourhood is not a wall of pixels; the subject is unmistakably the subject). The pad became 56 *screen* pixels rather than 120 map units, because what it protects is drawn in screen pixels — a neighbour's centred label at 10–13px would keep its dot and lose half its name on the very edge. Measured on synthetic neighbourhoods at 1100×800 (`focusOn` driven under Node with a stubbed renderer): 29 children at ±600 go from 1.40 (children cut) to 0.57, all on screen; 3 children at ±1500 from 1.40 to 0.26; a tight 5-child hub from 3.93 to 3.01; a leaf with one near neighbour sits at the 4.6 ceiling. The rule's stated cost: a single mention 3000 units away takes that 29-child hub to 0.16, because the mention is lit and lit means shown — the far neighbour is no longer one scroll away, it is on screen and everything else is small. Labels are unaffected: in focus mode the neighbourhood is named at any zoom (decision 33), so a subtree framed at 0.3 still reads, though a hub's labels collide there (a known loose end). |
| 38 | **ZoomIn becomes an Obsidian plugin (v3); the pywebview app is frozen at `d936f70`; the plugin is TypeScript built with esbuild, reversing decision 2** | Every surface the app has — the map, the dashboard, the lens — is a view *of* the vault, and the vault already lives inside a program with a graph engine, a metadata cache, a file watcher, rename tracking, a quick switcher and a theme. Standing beside it as a second process cost a scan (~90 ms, but manual), a hand-written link resolver (§3, three rules Obsidian already applies), a `note_id` table reserved for a rename recovery Obsidian does natively, a token-guarded loopback server, and the pywebview window that could not open an `obsidian://` link for three versions. Inside it, `metadataCache` replaces `vault/scanner|parse|resolve|mask.py` outright, `vault.on('rename')` replaces minted identity, `metadataCache.on('changed')` replaces the refresh button, and `openFile` replaces the deep link. The views become workspace leaves (a graph leaf, a tasks leaf, a panel leaf in the right sidebar that is also the dossier), which the user can split and arrange as they do every other view, and the dossier can follow the note open in the editor — the one integration a standalone app can never have. The cost is a port: ~1,700 lines of pure Python (`graph/`, `state/`, `tasks`) and ~900 lines of endpoint rules move to TypeScript, and the 239-test suite is re-expressed in vitest against a stubbed `obsidian`. The renderer (`graph.js`), the palette and the CSS carry over nearly unchanged. Decision 2 (no build step, vendored UMD) is reversed knowingly: Node is now installed, the plugin ecosystem is TypeScript + esbuild → `main.js`, and the typed API catches the kind of mistake (`focus === PRIORITY` for domain members, `textContent` into an icon button) that cost turns in v2. A hand-concatenated CommonJS `main.js` was possible and was not chosen. The Python app stays runnable and receives no more features; `plugin/` lives in this repository so this log stays the product's one record. Two more founding rules are reversed by the plugin's nature and get their own rows when they land: app state inside the vault's config folder (§1's "no dotfolder") and how the four fields are written (decisions 17/34). |
| 39 | **App state lives in the vault's config folder as the plugin's `data.json`, split from what is per-device** | §1's "no dotfolder inside the vault" was a promise about the vault as the user's text: nothing of ours among their notes. A plugin cannot keep the letter of it — Obsidian loads it from `.obsidian/plugins/zoomin/` and hands it `loadData`/`saveData` for exactly this — but the spirit survives untouched: nothing is written to a note that §1 does not already allow, no file is created among the notes, and `data.json` sits where every other plugin's state does, inside the folder Obsidian already owns. The gain is that the state now travels with the vault: domains, assignments and tombstones, slots and the whole slot history, datatypes, project rulings and task order are one JSON object that Obsidian Sync or the vault's own git carries to the next machine, where the Python app's SQLite file under Application Support never went anywhere. Two things are deliberately kept *out* of it, in Obsidian's per-vault local storage instead: node positions, because a layout settled on a 27-inch display is the wrong map on a laptop and a synced one would fight itself; and the panel's folds and filters, which are a viewer's convenience and not a fact about the vault. The migration script writes positions into `data.json` once — it is the only file it can write — and the plugin moves them to local storage on first load and drops the key. The SQLite migration ladder becomes a `version` field and an `upgrade()` step, append-only as before; notes are keyed by path rather than a minted id, because `vault.on('rename')` now rewrites the keys the moment a note moves, which is what `note_id` had been reserved to enable. The store saves after every mutation, coalesced to one write per 400 ms, so a run of clicks in the dialog is one file write and one sync. |
| 40 | **The four fields are written through Obsidian's `processFrontMatter`, not a spliced line; the guarantee becomes "an edit indistinguishable from the properties editor"** | Decisions 17 and 34 wrote one line of the file under a byte-level guarantee — only the named entry changes, the note's own key spelling, indentation and line endings survive, the result is re-parsed before it is saved, the replacement is atomic — because a YAML round-trip would have reordered keys and restyled quoting across the vault. Inside Obsidian the trade-off changed and the user chose the other side: `app.fileManager.processFrontMatter` parses the block, takes the new value, and serialises it with the same writer the properties editor uses. That is ten lines against the splicer's three hundred and its tests, and it inherits Obsidian's concurrency — the write goes through the app's own file layer, so a note open in an editor is updated in place rather than clobbered, which the splicer's re-read-before-write could only approximate for the *saved* case. What is given up is the byte-level claim: on a note whose block Obsidian would serialise differently (the 46 list-valued `status:` notes, a key quoted by hand, an unusual order) the diff is wider than the one line, though it is the diff Obsidian itself would have made. What is kept is the scope — the same four keys and nothing else, the list in §1 unchanged — and the *values*: each field is still rendered in the form the vault was measured to use (`[[Stem]]` for a parent, which Obsidian quotes; a one-item list under `categories:` in that category's bare-or-linked habit, counted over the notes; an ISO date; a capitalised status) and clearing sets the key to `null` so it stays an empty key rather than a deleted line. The value renderers are pure and tested; the write path is the same one function per field over one `process()` interface, with the model's cascade, loop refusal, ambiguous-stem path and in-memory patch carried over unchanged. Confirmed in Obsidian the day the question was written: a `null` serialises as `Parent:` with nothing after it, exactly the vault's own empty form, so clearing keeps the key rather than dropping the line. |
| 41 | **The three surfaces are workspace leaves — a map, a dashboard, a panel — and the dossier is a mode of the panel that can follow the note open in the editor** | The app had one window with a tab strip and a sidebar that the lens borrowed; Obsidian's workspace already knows how to open, split, and arrange views, so ZoomIn registers three leaf types (`zoomin-graph`, `zoomin-tasks`, `zoomin-panel`) instead of reimplementing any of that. The tab strip disappears: map and dashboard can sit side by side, which the strip never allowed, and the narrow layout follows the *leaf's* width by container query, since a split pane is the common narrow case and a viewport breakpoint cannot see it. The panel lives in the right sidebar like Outline or Backlinks and carries priorities, domains and projects — and, while a note is under the lens, that note's dossier instead. Because the plugin lives where the editing happens, the dossier can go further than the app's ever did: it follows the note open in the editor (a setting, default on), so opening a note lights its lens and shows its ledger without a click in the map. The follower is deliberately *not* an explicit focus: it never opens a leaf, and it only moves a lens the map already shows, so browsing the vault cannot rearrange the workspace. Explicit focus — a node click, the palette, a command — opens what it needs and centres the camera. Entering focus is one synchronous render: the app fetched `/api/note` after the lens landed and had to guard the second paint; the cache already has every field, so the dossier reads the model and is done. |
| 42 | **The active-file follower defers its camera move when the map leaf cannot be measured, and lands it when the leaf is shown or opened** | Navigating from the editor flung the map to near-zero zoom whenever the map leaf sat in a background tab: `clientWidth` is 0 in a hidden leaf, the `|| 1` fallback turned the viewport into one pixel, and dividing the neighbourhood's extent by it parked the camera at k ≈ 0.002 — "the graph zooms way out and loses its position". `focusOn` now refuses to compute from an unmeasured leaf, remembers the subject, and `resize()` flushes it, so navigating notes never costs the view you had; opening or revealing the map with the lens already on catches the camera up too, landing on the note the same way a click on its node would. |
| 43 | **Passive navigation moves the sidebar's tracker, not the dossier; the dossier answers only deliberate focus** | Decision 41's follower flipped the panel into a dossier on every note change, re-rendering a reading surface for the note already open beside it — the note is its own dossier, and the churn bought nothing. The follower now drives a tracker mode instead: the panel becomes the map itself (its own renderer over the same payload; two simulations at a few hundred nodes cost what one did to redraw, and only the big map ever saves positions), re-framed on the open note as you surf. A node click on the tracker hands you to the big map rather than the editor, keeping decision 35's rule that map clicks stay on the map layer. The dossier returns to what decision 33 made it: the answer to an explicit question. |
| 44 | **The tracker's node click opens the note in the editor's current tab, and the open note wears the lens** | Living with the tracker undid its first click rule within a session: from the sidebar, the map is how you move, and handing the click to the big map was one hop past the destination. Decision 35's "a click is tell me about this" was made on the big map, where the note is not already open beside you — the tracker is not that map (amending decision 43's first cut). The open note also gets the lens treatment — lit, its neighbourhood with it, everything else receding — so "where am I" is answered the map's own way. And the sections' head steps aside in tracker mode: it and the tracker's head stacked two "ZoomIn"s, the sections head being a sibling no earlier mode had needed to hide. |
| 45 | **The tracker is a reading companion: on the map or the dashboard the sections come back; a dashboard task opens in its own tab** | The tracker followed the editor but overstayed: arrive at the map — the very thing the sidebar map summarises — and it kept narrating. `active-leaf-change` now classifies the surface: a note brings the tracker, the map or the dashboard bring the sections, and anything else — the panel itself, other sidebars — changes nothing, or clicking the tracker would un-tracker it. The preference persists through the swaps; only the display yields. And a dashboard task opens in its own tab rather than landing on the map: the dashboard is the work list, and a task is a destination — decision 35's rule was about map nodes, not list rows. |
| 46 | **The map paints — and hit-tests — small nodes first, large last** | Clicking a large hub sometimes did nothing, or answered only at its dead centre. Hit-testing paints every node's pointer area onto a shadow canvas in array order and the last painter wins; the order was alphabetical by path, so a hub named "Agentic" painted before its leaves, and each leaf's hover floor (11 screen px = `11/scale` graph units — 22 units at overview zoom) ate into its disc. A 29-child hub draws at 12.8 units, so at overview zoom roughly the outer third of its visible area belonged to whoever painted last — a click there focused some invisible speck or nothing at all. Array order is now by radius, ascending: a large node's own disc always beats the floors of its neighbours, and drawing large-on-top is the z-order the map should have had anyway. |
| 47 | **The tracker re-frames when the engine settles, not when the data lands** | Set a parent on a parentless note and the tracker stared at an abyss: the structural reload framed the note at reload time, but the same reload reheats the layout, and the note drifts to its new place under its parent *after* the camera had already arrived — the centreAt coordinates were the address the node was leaving. The tracker therefore re-frames on engine settle, when the node has actually arrived, and a recenter button (locate-fixed, in the tracker's head) does the same on demand for the times exploring has carried the camera away. |

---

## 7. Known risks

Recorded honestly from research into prior art, because these are the ways apps in this
category actually die.

**The whole-vault graph is decorative past a few hundred notes.** This is close to consensus
about Obsidian's own graph view: past ~200 notes it becomes a hairball, and you can't
distinguish a hub from an ordinary note. The tools that stayed useful — ExcaliBrain,
TheBrain — won by being *local, hierarchical and deterministic* rather than global and
organic. **Implication: the default view should become the slotted regions, not the whole
vault. Zooming out to everything should be a deliberate gesture.** v1 renders everything
because that's what was asked for; this is the first thing to revisit.

**A compulsory weekly review is the most-abandoned step of the most successful productivity
system ever written.** GTD's weekly review commonly takes ~2 hours and is the step people
drop. If ZoomIn's review can't be done in five minutes, it will be the thing that kills the
app.

**Feature count is the leading indicator of death here.** Juggl died maintaining one
interactive graph engine. The roadmap has seven mechanics. They land one at a time, each
lived with before the next.

**No streaks. Ever.** Streak mechanics reliably produce streak-preservation displacing the
actual goal, and rage-quits after a single miss.

**The constraint is self-imposed and therefore breakable.** There is always
`rm ~/Library/Application Support/ZoomIn/state.db`. Any design premised on being
unbreakable is theatre — the value is in the *record*, not the *lock*.

**Evidence for the core mechanic is thinner than it looks.** There is no controlled study of
personal WIP limits; "start at 3" is folklore. The nearest real support is attention-residue
work (Leroy 2009), which supports *finishing or explicitly parking before switching* more
than it supports any particular number. Commitment-device effects are real but small, and
work best with money and an audience — neither of which a local single-user app has. Build
the mechanic, but hold the specific numbers loosely and instrument them.
