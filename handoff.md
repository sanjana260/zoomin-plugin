# ZoomIn plugin — Handoff

Orientation for an agent (or contributor) picking this repository up cold.
The user-facing README covers install and features; this covers how the code
is laid out, how to work on it safely, and what will bite you. Read this
first, then:

- **[design.md](design.md)** — the philosophy, the model, and the numbered
  **decisions log**. This is the *why*. Decisions 1–37 were earned by the
  macOS app this was ported from and still govern the plugin; 38–41 are the
  plugin era. Every non-obvious choice is there with its measurements. If
  you're about to change behaviour, find the decision that set it.
- **[v3-notes.md](v3-notes.md)** — the plugin's feature log, one entry per
  commit, plus implementation takeaways. This is the *what happened and what
  we learned*. The rulings table at the top is the port's shape on a page.

## What this is

An Obsidian plugin: the vault as a force-directed map of attention
(suppression, not hiding), a task dashboard, and a lens on one note with an
editable dossier. Ported from a frozen pywebview app of the same name; the
port's rationale is decision 38. The rules the app measured its way to are
kept as filters and pure functions — see `src/vault/snapshot.ts` and
`src/graph/`.

## Stack and layout

TypeScript + esbuild → `main.js`, no framework, `force-graph` (canvas)
bundled. Tests are vitest in jsdom with the `obsidian` module stubbed
(`tests/obsidian-stub.ts`) and Obsidian's element extensions polyfilled
(`tests/dom.ts`) — so the real views can be mounted and driven by clicks.

```
src/main.ts            wiring: views, commands, settings, store persistence,
                       vault/metadataCache events → model, focus mode
src/model.ts           the Session plus every endpoint rule the app had, minus
                       the HTTP. Owns the structural-vs-recolour decision
src/types.ts           Note, snapshot, payload, focus/status constants
src/vault/snapshot.ts  metadataCache → VaultSnapshot; the edge rules as filters
src/vault/categories.ts the frontmatter field readers
src/vault/write.ts     THE ONLY WRITER. Four fields over processFrontMatter
src/graph/             hierarchy, build (payload), tasks (dashboard), layout —
                       pure, tested
src/state/store.ts     domains/assignments/tombstones/slots/history/datatypes/
                       rulings/task order; persisted as data.json
src/state/local.ts     positions + UI prefs, per device
src/views/             renderer (force-graph adapter), graph-view, tasks-view,
                       panel-view (sidebar + dossier), modals, search, ui pieces
scripts/make_test_vault.py   the synthetic vault you develop against
scripts/migrate_state.py     only relevant to users of the frozen desktop app
```

## Build, test, verify

```bash
npm install
npm run build      # tsc strict, then esbuild → main.js
npm test           # 174 vitest tests
uv run python scripts/make_test_vault.py --fresh   # needs Python 3.13 + uv
```

`make_test_vault.py` writes `../test-vault/` (git-ignored, `git init`ed so
`git diff -U0` shows exactly what the plugin wrote) with the plugin symlinked
into `.obsidian/plugins/zoomin/`. Open that folder as a vault in Obsidian and
enable the plugin. **Never point the plugin at a vault you care about while
developing** — it writes `status:`, `Parent:`, `categories:`, `deadline:` to
notes, and nothing else. After a session that wrote anything, the four-key
diff is the whole contract:
`git -C ../test-vault diff -U0 | grep -iE '^[+-](status|Parent|categories|deadline):'`.

Visual verification is yours to do — a script cannot drive Obsidian. Each
change ends with: build, tests green, then open the vault and look.

## How data flows

`metadataCache` events (changed / deleted / rename, debounced 300 ms) →
`model.reload()` → rebuild snapshot, compare a structure key (node ids +
edges) with the last, and tell subscribers **structural** or recolour-only:
`setData` reloads the simulation, `applyFocus` only repaints. Getting this
wrong makes the map jump. Views never read the vault or the store directly;
they ask the model and subscribe to `change`. The dossier reads the model
synchronously — the cache already has every field, so it renders once.

## Conventions

- **Decisions** → `design.md`'s log (append, never renumber; one row per
  non-obvious call, with measurements). **Lessons** → `v3-notes.md`. **What
  changed** → the commit message. Commit messages are long-form and why-first,
  with the numbers that justified the change.
- Every visual constant in `src/views/renderer.ts` carries its measurement in
  a comment — change the number, update the comment.
- Markup is `createElement` all the way down (no `innerHTML`); styles are
  scoped under `.zoomin-*` and mapped onto Obsidian's theme tokens.
- Measure before designing: the vault contradicts its own conventions; the
  synthetic vault reproduces the traps that taught us that.

## Known loose ends

Label collision on big hubs under the lens; the eighth domain hue sits 30°
from the sixth; mobile is out (`isDesktopOnly`). The full list lives at the
end of `v3-notes.md` and in design.md's risks section.

## Release

`npm version patch` (runs `version-bump.mjs`, keeping `manifest.json` and
`versions.json` in step), push the tag — the workflow builds and attaches
`main.js`, `manifest.json`, `styles.css` to a draft release. Publish the
draft; BRAT and manual installs pick it up.
