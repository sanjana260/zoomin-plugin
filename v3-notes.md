# ZoomIn v3 — Feature Log & Implementation Takeaways

> **About the commit hashes below:** they refer to the ZoomIn monorepo's
> history (branch `working-on-v2` in `sanjana260/ZoomIn`), from which this
> repository was split with `git subtree split`. This repository's own history
> begins at the scaffold; the hashes are the same work under different ids —
> use the commit *titles* to find them here.

v3 is the Obsidian plugin. Decision 38 in [design.md](design.md) is the *why*;
this file is the *what happened and what we learned*, one entry per commit, then
takeaways. The pywebview app is frozen at `d936f70` — [v2-notes.md](v2-notes.md)
is its closed record.

The plan being followed (phases, rulings, layout) was written on 2026-09-18 and
the rulings are summarised here so they survive the plan file:

| Ruling | |
|---|---|
| Toolchain | TypeScript + esbuild → `plugin/main.js`; Node installed via Homebrew |
| State | split: domains, assignments, slots + history, datatypes, rulings, task order → `data.json` (in the vault, syncs); positions + UI prefs → per-device local storage |
| Writes | `app.fileManager.processFrontMatter()`; the byte-level splicer is not ported |
| Views | graph and tasks as main-area leaves; a right-sidebar panel that is also the dossier; the dossier follows the active file (setting, default on) |
| Reading | `metadataCache`, not a ported scanner; notes keyed by path + `rename` events |
| Scope | desktop-only; personal install (manual / BRAT), community-review rules observed; no default hotkey |
| Testing | a generated synthetic vault (`plugin/scripts/make_test_vault.py`); real-vault measurements are the user's to run |

---

## Feature log

### Scaffold, toolchain, synthetic vault (`6673af0`)
`plugin/` in the sample-plugin shape: `manifest.json` (`id: zoomin`, desktop-only,
`minAppVersion` 1.5.0), `package.json`, `tsconfig.json` (ES2018, strict),
`esbuild.config.mjs` (CJS bundle, `obsidian`/electron/codemirror external),
`vitest.config.ts` aliasing `obsidian` to `tests/obsidian-stub.ts` so pure modules
and the model can be tested outside the app. `src/main.ts` registers one
placeholder graph view behind a ribbon icon and a command, proving the install
path. `scripts/make_test_vault.py` writes `<repo>/test-vault` (git-ignored,
`git init`ed so `git diff -U0` shows what the plugin wrote) with the
`test_api.py` tree, the `test_tasks.py` tasks at deadlines relative to today,
every trap the Python tests guarded (fenced / inline / math links, a `.base` and
an image embed, CRLF, a list-valued `status:`, empty keys, a `Due:` straggler,
an unused `Categories/` note, an excluded `Templates/` note), a 29-child hub for
the lens camera, and three filler parents. The plugin folder is symlinked into
the vault's `.obsidian/plugins/`. The frozen Python scanner was run over the
vault as a cross-check: 107 notes, 91 edges, 1 phantom, 8 parents, and neither
`Fenced.md` nor `Bases.md` yields a trap edge — the same numbers the plugin's
cache adapter has to reproduce in phase 1.

### Read-only map leaf (`2709ea1`)
The map arrives as a workspace leaf. `src/vault/snapshot.ts` reads the vault
from `metadataCache` behind a three-method `CacheSource` interface — markdown
files, a file's cache, Obsidian's own link resolution — and applies the rules
the Python scanner had measured its way to: `Parent:` is hierarchy (parsed
from the frontmatter *value*, not `frontmatterLinks`, so the rule does not
care how the property was quoted), every body link and embed is associative,
an embed or link whose target is not a markdown note is never an edge (Trap
1), categories are never edges, unresolved targets are phantoms, self-links
and duplicates collapse, root-level `Templates/`/`Attachments/` and sync
conflicts are skipped. `scanner.py`, `parse.py`'s link half, `resolve.py` and
`mask.py` (~520 lines) have no counterpart — Obsidian does that work.
`hierarchy.ts`, `build.ts` and `layout.ts` are line-for-line ports (the seed
hash is FNV-1a rather than blake2b, so never-placed notes land somewhere new
once); `renderer.ts` is `graph.js` as a class with every constant and its
comment intact, the theme read from `body.theme-dark` and refreshed on
`css-change`, the canvas font resolved from the host's computed style
(canvas cannot use a CSS variable), and a `destroy()` for the leaf's close.
`model.ts` is the `Session` without HTTP: `reload()` rebuilds the snapshot,
compares a structure key (node ids + edges) with the last one, and tells
subscribers whether the change was structural — so the view calls
`setData` only when the simulation genuinely needs reloading and
`applyFocus` otherwise, the same two-refresh discipline the app had, now
decided by the model rather than by which endpoint was hit. `main.ts`
builds once the workspace is ready and follows `metadataCache` `changed` /
`deleted` and `vault` `rename`, debounced 300 ms; there is no refresh
button. `styles.css` maps the app's tokens onto Obsidian's once at
`.zoomin-view` and keeps the original names beneath. Tests: `test_graph.py`
ported one for one (57 cases) and the snapshot rules and field readers (47)
against `tests/fake-cache.ts`, a `CacheSource` built from note specs the way
`assemble()` built one from strings. 104 pass.

### Panel leaf, persisted state, filters, hover card, migration (`261ff28`)
The sidebar becomes a leaf of its own — `zoomin-panel`, opened in the right
sidebar by "ZoomIn: Open panel" — carrying the priorities (with the exploring
list under each slotted project), the domains (with member lists, edit, star
and the two-click delete) and the ranked projects with their domain selects,
each row's label zooming the map (opening the map leaf first if it is not
there). The domain dialog and the datatypes dialog are `Modal`s wrapping the
same tree and category code; the settings dialog is a `PluginSettingTab`
(slot caps, and the follow-active-file toggle phase 5 will read). The map
leaf gains the two-section filter popover and the hover card; the card's
status chip is drawn but disabled until phase 3 can write.

`state/store.ts` is `priorities.py` over a plain object: same methods, same
tombstone and sweep rules, minted uuids, `SlotFull`, the slot history — plus
`rename()`, which every path-keyed row follows when Obsidian reports a note
moved. `main.ts` persists it as `data.json` under a `store` key beside
`settings`, coalesced to one write per 400 ms; `state/local.ts` keeps
positions and the panel's folds, filters and collapses in Obsidian's
per-vault local storage (decision 39). `model.ts` grew every endpoint rule
from `app.py`: ranked projects with lineage, domain views with inherited
members, the category census (union of `Categories/` and use, labelled by
the folder's spelling or the commonest one), priorities with exploring
descendants, and the mutations — create/rename/delete domain, assign,
datatype shape and flag, project rulings that clear a dangling slot,
slots against the caps. Errors are thrown `Error`s the views turn into a
`Notice`.

`scripts/migrate_state.py` reads the app's `state.db` (v6, read-only) and
`config.toml` and writes `data.json` with the store, the caps as settings,
and positions under a `positions` key the plugin imports into local storage
on first load and then drops from the file. Verified against a database
built with the frozen Python `Store`; its output is a test fixture.
Tests: 31 model/store cases ported from `test_api.py`'s state behaviour.
135 pass.

### Writes: status, Parent, categories, deadline through processFrontMatter (`647a1e5`)
The plugin writes to the vault. `src/vault/write.ts` is the one module that
does: four functions over a two-method `FrontmatterWriter` (`process(path,
edit)`), which in the app is `app.fileManager.processFrontMatter` and in
tests a fake that edits the spec's frontmatter object. Decision 40 records
the trade: Obsidian's serialiser instead of the splicer, "indistinguishable
from the properties editor" instead of "only this line". The value renderers
are pure and keep the measured forms — `[[Stem]]`, a one-item list in the
category's own bare-or-linked habit, an ISO date, a capitalised status — and
clearing sets `null`, which the user still has to confirm serialises as an
empty key in the real vault.

`model.setStatus(path, status?)` cycles (or sets) and cascades to the whole
subtree as a set, patching each note in memory as it goes and reporting how
far it got if a write fails; `model.editNote(path, field, value)` handles
`parent` (loop refused, ambiguous stem written as a path, then a re-read —
the structure moved), `category` (known spelling wins, form by majority,
patched in memory and project-ness re-derived) and `deadline` (validated
before anything is written). The hover card's status chip is live, and
"ZoomIn: Cycle status of the active note" is a command. A cascade that
rewrote a subtree says so in a Notice. 16 write tests; 151 pass.

### Tasks leaf (`010e434`)
`graph/tasks.ts` is `tasks.py` ported: a task is `categories: Task` and
nothing else; the three lists (a slotted project's exploring tasks, the
priority domains' exploring tasks with near-deadlines left to the feed by the
feed's own `YELLOW_WITHIN` boundary, and the tiered deadline feed that skips
done work); the stable hash shuffle (FNV now, blake2b before — the order is
different from the app's, and equally arbitrary); `applyOrder` for the saved
manual order. `model.tasks(today)` composes the dashboard, taking the clock
as an argument; the view re-asks on `window` focus, so the tiers roll over
when the user comes back after midnight rather than at the next fetch.

`views/tasks-view.ts` is the dashboard as a leaf: the focus box washed in its
domain's hue with the mono eyebrow and condensed title, the priority-domain
list with one chip per domain (hidden rows stay in the DOM so a saved drag
order keeps them), the 248px deadline aside with tier-coloured rows and the
ring checkbox, native DnD scoped per list saving through
`model.saveTaskOrder` (a focus list must belong to a slotted project).
Ticking writes `status: Explored` — a set, cascading to the subtree — with
the same optimistic strikethrough as the app: the row stays until the next
render (the view holds the one render its own write triggers), so a
mis-click is undone by unticking. The narrow layout is a container query on
the leaf, not a viewport media query — a split pane is the common narrow
case, and the old `max-width` breakpoint could not see it.

### Focus mode: the palette, the lens, the dossier (`00880ec`)
Clicking a node, the magnifier on the map, or "ZoomIn: Focus on note…" puts
one note under the lens and turns the panel into its dossier. The palette is
`views/search-modal.ts`, search.js ported with its ranking intact — prefix >
word-start > anywhere > subsequence, a sub hit a ladder below any label hit,
ties to the shorter label, empty query showing the first forty in the order
given (parents first, biggest first) — rather than Obsidian's
`FuzzySuggestModal`, whose ranking is its own and which the parent picker
depends on. The lens is the renderer's `setFocus`/`focusOn`, unchanged. The
dossier is a mode of the panel (`DossierRenderer`): eyebrow and wash in the
node's hue, the ledger (Status · Parent · Domain · Datatype · Deadline ·
Project) with the same one-button project flip that clears a redundant
ruling, links split points-to / pointed-at by the model's `neighbours` —
computed from the edges, so the dossier works with the map leaf closed. All
of it reads the model synchronously; the "render twice, guard by id" dance
the app needed for `/api/note` is gone. "Open" opens the note in the editor
(`openFile`), which is the pywebview deep-link saga reduced to one call.

The dossier also follows the note open in the editor (setting, default on):
`active-leaf-change` enters focus for the file — non-explicit, meaning it
never opens a leaf and only moves a lens the map already shows. Escape
leaves the lens unless a dialog owns it; a click on empty canvas does too;
the back link does. `model.note(path)` (get_note + the project verdict) and
`model.neighbours` are tested against the tiny vault.

Also here: the task lists' drag reorder — the domain list's handlers had
never been attached (the focus lists wire their own per render), and a drop
now re-renders from the saved order rather than trusting the DOM it just
moved.

### Priority stars everywhere, and the dossier ghost (`f5a41e3`)
Two fixes from living with it. Starring a project was only reachable inside
an expanded domain's member list — the model path worked (the app had the
same reachability problem) but the Projects section, the one place that
lists every project, had no star. It does now; every project row stars
directly. And "Back to the map" left the dossier rendered below the returning
sections: the panel's `dossier` field had never pointed at the element the
DossierRenderer built, so exit hid nothing. Hide goes through the renderer
now, and a headless mount test drives the real panel in jsdom — naming a
domain, filing and starring a project from both places, the slot summary,
the dashboard's focus box, and the dossier leaving nothing behind.

That mount needed Obsidian's HTMLElement extensions (`createEl` that appends,
`empty`, `toggle`, `show`/`hide`, `isShown`) polyfilled in `tests/dom.ts` and
a fuller `ItemView` stub; jsdom is the test environment now, so views can be
driven by clicks from here on.

### Parity lint, docs, cut-over (`a6175ee`)
Phase 6. The review lint, run over `plugin/src`: no `innerHTML`/`outerHTML`/
`insertAdjacentHTML` anywhere; no `console.*`, no `require`, no `fs`, no
Node builtins; no hardcoded `.obsidian` (nothing writes a path — files are
written through Obsidian's own APIs, which is both the review rule and the
point); commands are sentence-case and plugin-namespaced by Obsidian; every
style rule is scoped under `.zoomin-*`, so nothing leaks into the editor and
community themes can recolour the chrome through the mapped tokens
(`--background-*`, `--text-*`, `--font-interface`) without touching the map.
`isDesktopOnly` stands; the macOS-bundled condensed display face falls back
to the system stack elsewhere.

`handoff.md` opens with a plugin-era box — build/test, the synthetic-vault
rule, the cut-over command — and below it the frozen app's documentation
stands as the record it is. `README.md` leads with the plugin: build, copy
`main.js`/`manifest.json`/`styles.css` into
`.obsidian/plugins/zoomin/`, enable, migrate. Decision 41 records the leaf
topology and the following dossier.

Cut-over checklist, for when the user is ready:
1. `npm run build`; copy the three files into the real vault's
   `.obsidian/plugins/zoomin/`.
2. `uv run python plugin/scripts/migrate_state.py --out <vault>/.obsidian/plugins/zoomin/data.json`.
3. Enable; check the panel against the app's sidebar (7 domains, priorities,
   7 datatypes, the rulings) and the census line against the vault.
4. `git -C <vault> status` before and after the first session; the four-key
   diff is the whole contract.

### Parity lint, docs, cut-over (`a6175ee`)
Phase 6. The review lint, run over `plugin/src`: no `innerHTML`/`outerHTML`/
`insertAdjacentHTML` anywhere; no `console.*`, no `require`, no `fs`, no
Node builtins; no hardcoded `.obsidian` (nothing writes a path — files go
through Obsidian's own APIs, which is both the review rule and the point);
commands are sentence-case and plugin-namespaced by Obsidian; every style
rule is scoped under `.zoomin-*`, so nothing leaks into the editor and
community themes recolour the chrome through the mapped tokens
(`--background-*`, `--text-*`, `--font-interface`) without touching the map.
`isDesktopOnly` stands; the macOS-bundled condensed display face falls back
to the system stack elsewhere.

`handoff.md` opens with a plugin-era box — build/test, the synthetic-vault
rule, the cut-over command — and below it the frozen app's documentation
stands as the record it is. `README.md` leads with the plugin: build, copy
`main.js`/`manifest.json`/`styles.css` into `.obsidian/plugins/zoomin/`,
enable, migrate. Decision 41 records the leaf topology and the following
dossier.

Cut-over checklist, for when the user is ready:
1. `npm run build`; copy the three files into the real vault's
   `.obsidian/plugins/zoomin/`.
2. `uv run python plugin/scripts/migrate_state.py --out <vault>/.obsidian/plugins/zoomin/data.json`.
3. Enable; check the panel against the app's sidebar (7 domains, priorities,
   7 datatypes, the rulings) and the census line against the vault.
4. `git -C <vault> status` before and after the first session; the four-key
   diff is the whole contract.

### The standalone plugin repository (`6c64262`)
`plugin/` split out into its own repository with
`git subtree split -P plugin -b plugin-export`, cloned `--no-local
--single-branch` (a plain local clone hardlinks the whole object store —
including unreachable junk from a long-discarded commit — and shipped 38 MiB
where the packed history is 272 KB). Eight plugin-era commits, rewritten so
`plugin/` is the root; `main.js`, `data.json` and the generated vault are
ignored there. It gained what the monorepo had supplied by context: a README
(BRAT / manual / from-source install, what the plugin writes), an MIT license,
and a tag-driven release workflow that attaches the three files Obsidian
expects as a draft. `make_test_vault.py` finds its roots by walking up now, so
it works in either layout. The flow going forward: changes land in the
monorepo's `plugin/`; publish with `git subtree push --prefix plugin <url>
main`.

### The follower lands the camera, and the dossier names its children (`d7a047b`)
Two from living with the map and the editor open together. Navigating the
editor — a link, or the search panel — flung the map to near-zero zoom
whenever the map leaf sat in a background tab: the active-file follower calls
`focusOn` on every `active-leaf-change`, and `focusOn` computed its zoom from
the host's `clientWidth`, which is 0 in a hidden leaf. The `|| 1` fallback
turned "no pixels" into "one pixel", and the neighbourhood's extent divided by
it parked the camera at k ≈ 0.002 — the graph "zooms way out and loses its
position". `focusOn` now refuses to compute from an unmeasured host, remembers
the subject, and `resize()` flushes it once the leaf is shown; `onOpen` also
catches the camera up, not just the lens highlight, so opening the map with
the focus already on lands on the note. And the dossier's links section gains
a **Direct children** list ahead of "Points to" / "Pointed at by" — the
`Parent:` relation by name through the new `model.childrenOf`, direct only (a
grandchild is not a child). The two raw lists stay the full link set the map
draws, so the "Links N" count and the sections cannot disagree; children rows
carry no tag, because the section title already says what every row is.

---

## Implementation takeaways

**`git clone <local-path>` hardlinks the entire object store.** A repo that
once held a fat accidental commit will ship that fat commit to every
file-path clone, refs or no refs. `--no-local` packs only what is reachable
from the branch you asked for: 38 MiB became 272 KB.

**Obsidian's `createEl` appends.** A polyfill that builds and returns the
element produces a view whose every query is null — and the failure looks
like a selector bug, not a builder bug. If a mounted view is empty, check
that the builder attached before blaming the code under test.

**A view must not re-render on the model change its own write just
emitted**, or the optimistic row vanishes before the user sees it land. Hold
the render across the await and release it in `finally`.

**`new Date()` is an argument, not a global.** `tasks(today)` takes the
clock so tests can pin dates around 2026-09-13 like the Python ones did, and
the view can refresh the tiers on focus instead of waiting for a fetch.

**Obsidian's `el.toggle()` sets `style.display`, not a class**, so a
sibling selector like `.group:not(.is-hidden) + .group` cannot see it. When a
rule depends on two elements both being shown, set a class from the code that
knows.

**`processFrontMatter` is not the only thing that makes app state feel
native: `saveData` coalescing matters.** The Python store wrote SQLite per
call; a JSON file per click would be a sync event per click. Debounce the
save, not the mutation.

**A `\u0000` escape in a string passed through the file-writing tool became
a real NUL byte.** The harness's write tool decoded it. `grep` then treats
the file as binary, exactly as the v2 handoff warned; `python -c
"open(f,'rb').read().count(0)"` is the check, and a plain `"\n"` is a fine
separator for a composite key.

**Obsidian's frontmatter cache gives YAML *values*, not YAML text.** `- "[[Projects]]"`
arrives as the string `[[Projects]]`; the quotes were syntax. A test written
with the quotes inside the string was testing a value the cache never
produces. The reader strips a surviving pair anyway, because it costs
nothing.

**Canvas `ctx.font` cannot take `var(--font-interface)`.** Read
`getComputedStyle(element).fontFamily` once the element is attached, and
again on `css-change`; fall back to the system stack before that.

**force-graph 1.51 is a class with bundled types**; `d3Force("link")`
returns a generic `ForceFn` and needs a cast to reach `.distance()` /
`.strength()`. Custom forces are plain functions with an `initialize`
property, as before.

**A hidden Obsidian leaf measures 0×0 — and camera math that divides by it
still runs.** The `|| 1` guard against divide-by-zero converted "no pixels"
into "one pixel" and produced an absolute zoom of nothing. Where a computation
needs the viewport, refuse to compute without it and let the resize handler
land the deferred result.

**Node was already on the machine by the time the scaffold started — under
`/opt/homebrew/bin`, which the harness's first shell did not have on `PATH`.**
`which node` said no; `ls /opt/homebrew/bin/node` said yes. Check the Homebrew
prefix before concluding a tool is absent.
