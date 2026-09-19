# ZoomIn — Vault setup guide

This is the setup manual for the ZoomIn plugin. It is written for two readers
at once:

- **You, the human** — whether your vault is years old or you installed
  Obsidian five minutes ago. Start at [the idea](#1-the-idea) and read
  straight through, or jump to [setting up your vault](#14-setting-up-your-vault-step-by-step).
- **You, the agent** — setting up or converting a vault on someone's behalf.
  Everything you need to write correct frontmatter is in
  [the agent reference](#15-agent-reference), which is exact rather than
  gentle.

Install steps live in the [README](README.md); this file starts where that one
ends — the plugin is enabled, and the question is *what does my vault need to
look like for it to work well.*

---

## 1. The idea

ZoomIn renders your vault as a map of attention. Attention is a fixed budget:
only a few things can be priorities at once, and the map exists to help you
spend that budget honestly. Regions you have not prioritised don't disappear —
they recede, staying visible and clickable — while the regions you *have*
prioritised stay in full colour.

Three views, arrangeable like any Obsidian pane:

- **Map** — every note and link. Size says how much hangs off a note; priority
  and status speak in colour, never in geometry.
- **Tasks** — a dashboard: what you're working on per priority project, the
  priority domains' lists, and a deadline feed tiered red / yellow / grey.
- **Panel** (right sidebar) — your domains and projects; and, while a note is
  under the lens, that note's **dossier** — its fields, editable in place.
  The panel can also become the map itself, kept framed on the note you're
  reading, so your place in the vault moves as you surf.

The plugin reads your whole vault and writes almost nothing to it. That
division — *the vault holds the notes, the plugin holds your attention
decisions* — explains most of what follows.

## 2. What ZoomIn reads, and what it writes

**Reads:** every markdown note, its links, and a handful of frontmatter
fields. Root-level `Templates/` and `Attachments/` folders are skipped —
scaffolding, not thinking — as are sync-tool conflict copies.

**Writes:** exactly **four frontmatter fields**, each through Obsidian's own
frontmatter writer, so an edit is indistinguishable from one you made in the
properties editor. No files are ever created, no other keys are touched.

| Field | Written as | Example |
| --- | --- | --- |
| `status:` | capitalised word | `status: Exploring` |
| `Parent:` | one wikilink (Obsidian adds the quotes) | `Parent: "[[Work]]"` |
| `categories:` | a one-item list | `categories:` → `- Task` |
| `deadline:` | ISO date | `deadline: 2026-10-01` |

Clearing a field leaves the key with an empty value (`Parent:` with nothing
after it) rather than deleting the line.

**Everything else the plugin knows — your domains, which projects are filed
where, priority slots, category shapes — lives in the plugin's `data.json`**,
inside the vault's config folder. It syncs with the vault; the vault's notes
never learn of it. Node positions and panel folds are per-device.

This is the contract to internalise: **to set your vault up for ZoomIn, you
only ever touch those four fields** (or let the plugin touch them for you).
Domains and priorities are made in the plugin's UI, never as notes.

## 3. Frontmatter in sixty seconds

*If you've used Obsidian's properties editor, skip this section.*

Frontmatter (Obsidian calls it **properties**) is a block of `key: value`
pairs at the very top of a note, between two lines of `---`:

```markdown
---
status: Exploring
deadline: 2026-10-01
---

# My note body starts here
```

You can edit it as raw text as above, or through the **properties** UI at the
top of every note (click *Add property*). Both are the same thing; ZoomIn
reads either. It also writes through Obsidian's own writer, so an edit ZoomIn
makes shows up in the properties UI like any other.

A value can be a **link to another note** — `[[Work]]` is a wikilink to the
note titled *Work*. Inside frontmatter Obsidian usually shows it quoted:
`Parent: "[[Work]]"`. The quotes are Obsidian's, not part of the value.

## 4. How links work

The map is made of notes (nodes) and links (edges). Not every link in your
vault becomes an edge — ZoomIn applies a few deliberate rules.

### The two kinds of edge

**Hierarchy edges** come from one place only: the `Parent:` frontmatter field.
`A` saying `Parent: "[[B]]"` means *A lives under B*, and draws a solid,
directed edge with strong layout pull. These edges form the tree — the
backbone of the map, and the source of every project, subtree size, and
inheritance rule below.

**Associative edges** come from the note body: every `[[wikilink]]` and
markdown link, and every `![[embed]]` whose target is a note. These are thin
and neutral — the surprising cross-connections a map is supposed to reveal.

### What never becomes an edge

- **`categories:` values** — even wikilinked ones. A category is a property of
  a note, not a link between notes; a hundred notes saying `categories: Task`
  must not manufacture a hub.
- **Embeds of non-notes** — images, PDFs, `.base` files. (Embeds of *notes*
  are edges.)
- **A note linking to itself**, and duplicate links from one note to the same
  target.

### What happens to broken links

A link whose target doesn't exist yet becomes a **phantom** — a small, dim
node rendered beside whoever points at it. Phantoms are intentions not yet
written, and they are signal: an outline full of them is a to-write list. Do
not rush to fix them; the map shows them so you can see them.

### Resolution details (mostly Obsidian's own)

- Link targets resolve vault-wide, **case-insensitively**; `[[work]]` finds
  `Work.md`.
- With duplicate names, a vault-absolute path wins: `[[Work]]` means the same
  note everywhere in the vault, preferring the root copy.
- Aliases are not consulted for resolution: `[[Some Alias]]` is a phantom
  unless a *note* has that name. `[[Real Note|Alias]]` links to *Real Note*.
- Subpaths are stripped: `[[Work#Tuesday]]` is an edge to `Work`.
- Links into the root-level `Templates/` or `Attachments/` folders resolve,
  but the targets are excluded, so no edge is drawn.

## 5. `Parent:` — the tree

`Parent:` is the most structural field in the vault. It says where a note
sits:

```markdown
---
Parent: "[[Work]]"
---
```

- **One parent per note.** If a note somehow carries several, the first wins.
- The value must be a **wikilink**. A bare `Parent: Work` is not read.
- The target is usually a bare filename stem (`[[Work]]`); a pathed form
  (`[[Projects/Work]]`) also works and is what ZoomIn itself writes when a
  stem is ambiguous — two notes named `Work` in different folders.
- Notes with no `Parent:` sit at the top level of the map.
- The tree is **cycle-safe** — a hand-typoed loop won't hang the map — but
  ZoomIn will never *write* one: re-parenting a note under its own descendant
  is refused.

You rarely edit `Parent:` by hand. The dossier's **Parent** button re-files a
note (a parent change genuinely moves the structure); and the whole field is
plain frontmatter, so dragging files in Obsidian's file explorer does *not*
move it — the tree and the folder layout are independent opinions.

**What the tree gives you for free:** every note something else hangs off is
offered as a **project** (next section); sizes on the map show how much hangs
off each note; and a note inherits its ancestors' domain colour until it says
otherwise.

## 6. Projects

"Project" is the plugin's word for **a note you can file into a domain and
slot as a priority** — a region of the tree you can point at. Three sources
say a note is a project, and they rank:

1. **Your ruling** — set per-note in its dossier (*Project: yes/no*). A ruling
   wins over everything: you can declare a childless note a project, or rule
   out a hub you don't want offered.
2. **A project datatype** — a category flagged as a project kind in the
   *Edit datatypes* dialog. Every note carrying that category becomes a
   project. (A category called "Projects" is *not* special until you flag it.)
3. **The tree itself** — anything another note names in `Parent:`.

Ranking matters mostly so the dossier can explain itself ("project because it
has children", "declared a project"), and so flipping the answer clears a
ruling that has become redundant instead of stacking one on top of a rule
that already agrees.

The ranked list of projects is what the panel's **Projects** section shows,
biggest subtree first. The ranking decides what to offer first; it never
decides what belongs with what — that is what domains are for.

## 7. `categories:` — what a note is

`categories:` says what *kind* of note this is:

```markdown
---
categories:
  - Task
---
```

- Matching is **case-insensitive** and **accent-normalised**: `Task`, `task`
  and `TASK` are one category. `[[Task]]` (wikilinked) is the same category as
  bare `Task` — spell it either way; the plugin reduces a link to its target,
  and `Categories/Task` and `Task` land on one name.
- A note can carry **several** categories; the list order is respected (the
  first one with a datatype shape wins the shape).
- Categories are **never edges** (see §4) and **never inherited** — they
  belong to the note they're written on.
- The plugin never rewrites your spelling: a known category keeps the spelling
  your vault already uses most, and a brand-new one is written as you typed it.
- Optionally, keep one note per category in a root-level `Categories/` folder.
  It's not required — the census comes from what notes actually use — but a
  note there is treated as the vault declaring the official spelling.

### The `Task` category specifically

**A task is a note filed `categories: Task`. Nothing else is a to-do.** An
`Entry` or an `Idea` can be status `Exploring`, but it is something you wrote,
not something you can check off — it will never appear on the task dashboard.
This one category is what feeds all three dashboard lists (§13).

## 8. Datatypes — shapes and project flags (optional)

A **datatype** is one of your categories with an opinion attached, set in the
*Edit datatypes* dialog (also a command):

- a **shape** — circle, square, diamond, triangle (up or down), pentagon,
  hexagon, star, cross — drawn on the map, so `Meeting` dots read differently
  from `Reference` squares at any zoom; and/or
- the **project flag** — every note with that category counts as a project
  (§6).

The two are independent; a category can have either or both. A note's shape is
the first category in its list that has a shaped datatype.

## 9. `status:` — the lifecycle

`status:` says where a note is in its life. Three values, written capitalised:

```markdown
---
status: Exploring
---
```

| Value | Means |
| --- | --- |
| `Unexplored` | looked at, not started |
| `Exploring` | in motion |
| `Explored` | done |

- **No status is its own state.** A note with an empty or unrecognised
  `status:` is not assumed to be Unexplored — a third of a typical vault never
  sets the field, and the map refuses to restyle them on a claim their author
  never made. (It reads tolerantly, though: any capitalisation works, and a
  stray list value is taken as its first item.)
- **Status speaks in colour** on the map, and drives what the dashboard shows.
- **Clicking cycles it**: hover a node and click its status chip, run
  *ZoomIn: Cycle status of the active note*, or tick a checkbox on the
  dashboard. Unexplored → Exploring → Explored → round again; a note with no
  status enters at Unexplored.
- **Setting a status cascades down the tree.** Mark a project `Explored` and
  its whole subtree is set to `Explored` — "work is done" with children still
  Exploring would be a contradiction. This is a *set*, not a cycle, so a
  parent and its descendants always land on one status. A mis-click is undone
  the same way: untick, or cycle back, and the subtree follows again.

On the dashboard, "done" means `Explored` specifically — §13 lists what each
list shows.

## 10. `deadline:` — dates

```markdown
---
deadline: 2026-10-01
---
```

- One ISO date, `YYYY-MM-DD`. Anything else — words, empty values — is no
  deadline. Any note *can* carry one, but the dashboard's deadline feed only
  lists **tasks** (`categories: Task`).
- The feed sorts by date, most urgent first, and tiers:

| Tier | When | Meaning |
| --- | --- | --- |
| **Red** | overdue, today, or tomorrow | shouting |
| **Yellow** | within a week | asking |
| **Grey** | further out | present, not asking |

- **`Explored` tasks leave the feed** — a finished task's deadline is moot.
  Every other status stays, *including no status and `Unexplored`*: a deadline
  is exactly the thing that should drag an unstarted task into view.

## 11. Domains — groupings you name

A **domain** is a region of your life: *Work*, *Family*, *Side quests*. Three
properties define it:

- **Domains are not notes.** You create one in the panel (*New domain*), name
  it, and it exists in the plugin's `data.json` — the vault never learns of
  it, and ZoomIn will never create a note for it. "The things I do for money"
  is a real region of a life with no note behind it; that is exactly the thing
  domains are for.
- **Projects are filed into domains**, one domain per project. Assign from the
  panel's Projects rows or a domain's member list; assigning a project to a
  second domain *moves* it.
- **Filing cascades down the tree.** Every note under a filed project inherits
  its domain — that's what paints whole regions of the map in the domain's
  colour. A note (or project) with an explicit *unfiled* marking stops the
  inheritance: "deliberately not filed" beats an ancestor's domain.

Domains get colours by creation order — eight distinguishable hues. The name
is yours to edit or retire; nothing is auto-generated.

## 12. Priority slots — spending the budget

Starring a domain or a project (**star** button on its panel row) fills a
**priority slot**. Slots are hard-capped — by default **3 domain slots** and
**1 project slot** (adjustable in settings, but a cap you can widen the moment
it pinches is decoration; the friction is the point).

Filling a slot costs you the others, and that is the mechanic:

- With **no** priorities, the whole map reads as normal.
- Once **any** slot is filled, everything outside your priority regions
  **recedes** — desaturated, dimmed, still clickable. Nothing is ever hidden.
- A priority **project** lifts its whole subtree to full emphasis (a project
  slot names a region of the tree and says nothing about domains).
- A priority **domain** lifts everything that belongs to it — the projects
  filed under it, and every note that inherits their domain. A note marked
  *deliberately unfiled* (§11) stays receded.
- Priority is said in **colour only** — no node ever moves or resizes because
  you changed your mind about what matters.

## 13. The task dashboard

The **Tasks** view composes three lists live from the vault — there is nothing
to maintain. To be on it at all, a note must be a task (`categories: Task`).

1. **Focus** — one box per priority project, washed in its domain's colour,
   listing the **Exploring tasks anywhere in its subtree**. Alphabetical
   until you drag rows into an order, which is saved.
2. **Priority domains** — one list per starred domain: the Exploring tasks
   under every project filed there, deduplicated, minus anything already
   shouting in the deadline feed (a red- or yellow-tier task doesn't need to
   be listed twice). Shuffled stably — the same order every visit — until you
   drag rows.
3. **Deadline feed** — every task with a deadline that isn't `Explored`,
   sorted by date, tier-coloured per §10. This list is the calendar's; no
   manual ordering.

**Ticking a box** writes `status: Explored` — cascading to the subtree, like
any status set. Unticking writes `status: Exploring`. The row strikes through
in place until the next refresh, so a mis-click is undone by unticking.

The practical setup rule: **a task shows up where you want it when it has the
right category *and* the right status.** `categories: Task` puts it in the
plugin's universe; `status: Exploring` puts it on the work lists; `status:
Unexplored` + a deadline puts it in the feed; `status: Explored` takes it off
the board.

## 14. Setting up your vault, step by step

*Starting from any vault — or from an empty one.*

1. **Install and enable the plugin** (README). Click the ribbon icon to open
   the map, and *ZoomIn: Open panel / Open tasks* for the other views.
2. **Build the tree with `Parent:`.** For each note that belongs under another,
   add `Parent: "[[Above]]"` — or just pick a note in the map and set Parent
   from its dossier. Even a dozen links turns a flat soup into a shaped map;
   you can grow the tree forever.
3. **Mark your to-dos**: `categories: Task` on notes that are check-off-able
   things.
4. **Give work a status**: `status: Exploring` on what's in motion. Leave the
   rest alone — no status is a legitimate state.
5. **Add `deadline:`** to tasks that have real dates. The feed does the rest.
6. **Create domains in the panel** and file projects under them. Watch the map
   take on colour.
7. **Star one project** (and up to three domains). Watch everything else
   recede. That recession is the whole point — move the star when your
   attention moves.
8. *Optional:* flag a category as a project datatype or give categories shapes
   in *Edit datatypes*; keep a `Categories/` folder of one note per category.

Everything above survives being undone: fields clear, domains retire, slots
empty, and no note was ever created or deleted by the plugin.

## 15. Agent reference

For an agent setting up or converting a vault: the exact rules the plugin's
reader applies. When in doubt, mimic the forms in §2 — they are what the
plugin itself writes.

### Field contract

| Key (exact spelling) | Read form | Written form | Notes |
| --- | --- | --- | --- |
| `Parent` | `"[[Stem]]"` or `"[[Folder/Stem]]"` | one wikilink, bare stem unless ambiguous | **capital P**; must be a wikilink — a bare value is ignored; first of several wins; target must be a `.md` note |
| `status` | `Unexplored` / `Exploring` / `Explored` | capitalised word | case-insensitive on read; a list's first item is used; unrecognised → treated as no status |
| `categories` | bare name or `[[Name]]`, in a YAML list | one-item list | case-insensitive, accent-normalised; `Categories/Name` ≡ `Name`; a category is never a link/edge |
| `deadline` | `YYYY-MM-DD` | ISO date | anything else is ignored; a list's first item is used |
| `Description` / `description` | read either | **never written** | shown in the dossier |

Keys are **case-sensitive**: `parent:` or `Due:` are invisible to the plugin.

### Edge rules the map applies

- `Parent:` → hierarchy edge (the tree). Every body wikilink, markdown link,
  and `.md` embed → associative edge.
- Never edges: `categories:` values, embeds of non-notes (images, PDFs,
  `.base`), self-links, duplicates, links resolving into root-level
  `Templates/` or `Attachments/`.
- Unresolved link targets become phantom nodes — expected and fine. Do not
  create placeholder notes to "fix" them unless the user wants those notes.
- Inline `#tags` and `tags:` frontmatter are not read.
- Notes in root-level `Templates/`/`Attachments/` and sync-conflict copies are
  excluded entirely.

### Minimal working setup

A project with two tasks, one due:

```markdown
---
Parent: "[[Work]]"
categories:
  - "[[Projects]]"
---
```

```markdown
---
Parent: "[[Work]]"
categories:
  - Task
status: Exploring
---
```

```markdown
---
Parent: "[[Work]]"
categories:
  - Task
status: Unexplored
deadline: 2026-10-01
---
```

(The `[[Projects]]` category only makes the parent a project if that category
is flagged as a project datatype — or simply because the tasks hang off it,
which is the tree rule and needs no configuration at all.)

### Checklist

1. **Tree first**: `Parent:` links from children to parents. Every parent
   becomes an offered project automatically.
2. **Then tasks**: `categories: Task`; `status: Exploring` for work in motion;
   ISO `deadline:` where dates exist.
3. **Then stop writing.** Domains, filing, priority slots, datatypes and
   rulings are *plugin state*, created through the panel — not frontmatter,
   and not `data.json` edits. If the user has asked for specific domains,
   hand them a list to enter in the panel; don't try to script the plugin's
   state file.
4. **Verify**: nothing you wrote should show up as unexpected map structure —
   categories as hubs (they must stay bare-property values), `Parent:` values
   that don't resolve (they become phantoms), or notes under `Templates/`.

### Cautions

- Never write a `Parent:` loop (a note under its own descendant). The plugin
  refuses to write one; your YAML shouldn't contain one either.
- Don't set `status: Unexplored` on a whole vault "for completeness" — no
  status is its own, intentional state and the map distinguishes it.
- Don't wikilink categories *or* bare them inconsistently *within one
  category* if you can help it: both are read as the same category, but the
  plugin preserves each category's dominant habit when it writes, and a 50/50
  split makes that choice arbitrary.
- The plugin writes through Obsidian's frontmatter writer; if you are editing
  the same files concurrently (rather than before/after), expect the usual
  last-writer-wins of any two editors.

## 16. Where everything lives

| Thing | Lives in | Syncs with the vault? |
| --- | --- | --- |
| The four fields | note frontmatter | yes — they're in the notes |
| Domains, project filing, priority slots, slot history, datatypes, project rulings, dashboard task order | `.obsidian/plugins/zoomin/data.json` | yes |
| Node positions, panel folds and filters | per-device local storage | no — by design; your layout is yours |

If you ever uninstall ZoomIn, the vault keeps the four fields as ordinary
frontmatter and loses nothing else. That is deliberate.
