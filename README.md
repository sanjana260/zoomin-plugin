# ZoomIn

An [Obsidian](https://obsidian.md) plugin that renders your vault as a map of
attention — a force-directed graph where the regions you have not prioritised
recede — with a task dashboard and a lens on one note. It is built around one
idea: attention is a fixed budget, and the map exists to help you spend it.

Three views, arrangeable like any other:

- **Map** — every note and link, hierarchy from `Parent:` frontmatter. Size says
  how much hangs off a note; priority and status speak in colour, never in
  geometry. Nothing is ever hidden — suppressed regions recede, and stay
  clickable.
- **Tasks** — the slotted project's exploring to-dos, the priority domains'
  lists, and a deadline feed tiered red/yellow/grey. Ticking a box writes
  `status:` to the note.
- **Panel** — priorities, domains, projects; and, while a note is under the
  lens, that note's dossier: status, parent, domain, datatype, deadline,
  project-ness — editable, so you rarely leave the map to answer "what is
  this, and what is it wired to". The dossier appears when you focus a note
  deliberately. The panel can also become the map itself — framed on the note
  you're reading and following it as you surf (a setting, on by default), so
  your place in the vault moves with you.

A task is a note filed `categories: Task`. Datatypes give a category a shape on
the map. Domains are groupings you name — they are not notes and the vault
never learns of them.

## Install

**Option A — BRAT** (easiest, and the way to get updates): install
[BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* and
give it this repository's URL.

**Option B — manual:** download `main.js`, `manifest.json` and `styles.css` from
the latest release, put them in `<your-vault>/.obsidian/plugins/zoomin/`, and
enable the plugin in Obsidian's community-plugin settings.

**Option C — build from source:**

```bash
git clone <this repository>
cd zoomin-plugin
npm install
npm run build
```

then copy `main.js`, `manifest.json` and `styles.css` as in option B. For
development, symlink the repo into a test vault instead:

```bash
uv run python scripts/make_test_vault.py --fresh
```

writes `../test-vault/` (a throwaway vault with the plugin already linked in),
which you open in Obsidian as its own vault. Develop against that, never
against a vault you care about — the plugin writes to notes.

Requires Node 18+ and a desktop Obsidian (macOS/Windows/Linux; the condensed
display face falls back gracefully off macOS).

## What it writes, and what it never does

Four frontmatter fields — `status:`, `Parent:`, `categories:`, `deadline:` —
each written through Obsidian's own frontmatter writer, so an edit is
indistinguishable from one made in the properties editor. Clearing a field
leaves the key with an empty value, as the vault's own empties do. No files are
created, no other keys are touched. Everything else the plugin knows — domains,
assignments, slots and their history, datatypes, project rulings, task order —
lives in the plugin's `data.json` and travels with the vault (node positions
and panel folds stay per-device).

## Development

Agent- or contributor-facing orientation lives in [handoff.md](handoff.md):
the layout, the build/test/verify loop, the safety rules, and the
conventions. The short version: `npm install && npm run build && npm test`,
develop only against the generated test vault, and record every non-obvious
decision in `design.md`'s log.

## Provenance

ZoomIn began as a standalone macOS app (pywebview + FastAPI) and was ported to
an Obsidian plugin; this repository is that plugin, split out of the [main
ZoomIn repository](https://github.com/sanjanamohan/zoomin), where `design.md`
carries the philosophy, the model and a numbered decisions log — the *why*
behind everything here. `scripts/migrate_state.py` is only relevant if you ran
the desktop app: it carries its state into this plugin's `data.json`.

## License

MIT
