"""Generate the synthetic vault the plugin is developed against.

The plugin writes to notes, so it is never pointed at the real vault before
cut-over. This vault reproduces every shape the Python tests cared about, in a
folder Obsidian can open as its own vault, with the plugin folder symlinked in:

  * the `test_api.py` tree — Work → Prepay → Aetna (which links a phantom,
    [[Ghost]]) and Chess, all filed `[[Projects]]`;
  * the `test_tasks.py` tasks — deadlines are written relative to today, so
    the dashboard's tiers (overdue / within a week / later) are all populated
    whenever the vault is regenerated;
  * the traps — a link inside a code fence and one in inline code (neither is
    an edge), a `.base` embed and an image embed (Trap 1: never edges), a
    CRLF-ended note, a list-valued `status:`, a `Categories/` folder with one
    note nobody uses, and an excluded `Templates/` note that links everything;
  * filler: three more parents with a dozen children each, mixed statuses
    and categories, and a few cross-links, so the forces have work to do.

Usage:

    uv run python plugin/scripts/make_test_vault.py [--fresh] [--dir PATH]

The default location is `<repo>/test-vault`, git-ignored, and it is `git init`ed
so `git diff -U0` shows exactly what the plugin changed. `--fresh` deletes and
recreates it. Open it in Obsidian with *Open folder as vault*, turn off
restricted mode when asked, and the plugin is already listed as enabled.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "plugin"
DEFAULT_DIR = REPO / "test-vault"


def frontmatter(**fields: object) -> str:
    """Render frontmatter in the forms the real vault uses (measured, decision 34)."""
    lines = ["---"]
    for key, value in fields.items():
        if value is None:
            lines.append(f"{key}:")
        elif isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {item}" for item in value)
        else:
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def note(
    parent: str | None = None,
    *,
    category: str | None = None,
    status: str | None = None,
    deadline: date | None = None,
    description: str | None = None,
    body: str = "",
) -> str:
    fields: dict[str, object] = {}
    if parent is not None:
        fields["Parent"] = f'"[[{parent}]]"'
    if category is not None:
        # Task / Idea / Reference are written bare; the rest as wikilinks — the
        # majority form per category on the real vault.
        bare = category in ("Task", "Idea", "Reference")
        fields["categories"] = [category if bare else f'"[[{category}]]"']
    if status is not None:
        fields["status"] = status
    if deadline is not None:
        fields["deadline"] = deadline.isoformat()
    if description is not None:
        fields["Description"] = description
    text = frontmatter(**fields) if fields else ""
    return text + body


def build(root: Path, today: date) -> dict[str, str]:
    """Every file in the vault, path → text. Deterministic."""
    d = lambda days: today + timedelta(days=days)  # noqa: E731
    files: dict[str, str] = {}

    # --- the test_api.py tree --------------------------------------------------
    files["Work.md"] = note(category="Projects", status="Exploring", description="Everything done for money.")
    files["Prepay.md"] = note("Work", category="Projects", status="Exploring")
    files["Aetna.md"] = note("Prepay", status="Exploring", body="See [[Ghost]] for the plan.\n")
    files["Chess.md"] = note(category="Projects", status="Exploring", description="Getting to 1500.")

    # --- the test_tasks.py tasks ------------------------------------------------
    files["Ship.md"] = note("Work", category="Task", status="Exploring")
    files["Memo.md"] = note("Work", category="Entry", status="Exploring")
    files["Done.md"] = note("Work", category="Task", status="Explored", deadline=d(-8))
    files["Opening.md"] = note("Chess", category="Task", status="Exploring", deadline=d(1))
    files["Castle.md"] = note("Chess", category="Task", status="Exploring")
    files["Loose.md"] = note(category="Task", status="Unexplored", deadline=d(4))
    files["Late.md"] = note(category="Task", status="Exploring", deadline=d(-17))
    files["Soon.md"] = note("Work", category="Task", status="Exploring", deadline=d(3))
    files["Later.md"] = note("Work", category="Task", status="Exploring", deadline=d(10))
    files["Week.md"] = note("Work", category="Task", status="Exploring", deadline=d(7))
    files["Beyond.md"] = note("Work", category="Task", status="Exploring", deadline=d(8))

    # --- traps --------------------------------------------------------------------
    files["Fenced.md"] = note(
        "Work",
        status="Exploring",
        body=(
            "A real link: [[Chess]].\n\n"
            "```\n[[NotALink]] inside a fence\n```\n\n"
            "And `[[AlsoNotALink]]` inline.\n\n"
            "$$ [[NorThis]] $$\n"
        ),
    )
    files["Bases.md"] = note(
        "Work",
        status="Exploring",
        body="![[Tasks.base]]\n\n![[Attachments/pic.png]]\n\n![[Memo]]\n",
    )
    files["Tasks.base"] = "filters:\n  and:\n    - file.hasTag(\"task\")\nviews:\n  - type: table\n    name: Tasks\n"
    files["Attachments/pic.png"] = ""  # written as bytes below
    files["Crlf.md"] = note("Work", category="Task", status="Exploring", body="Windows line endings.\n").replace("\n", "\r\n")
    files["Listed.md"] = frontmatter(Parent='"[[Chess]]"', status=["Exploring"]) + "A list-valued status.\n"
    files["Empty keys.md"] = frontmatter(Parent=None, categories=None, deadline=None) + "Every key present, every value empty.\n"
    files["Due.md"] = frontmatter(categories=["Task"], status="Exploring", Due=d(2).isoformat()) + "Uses `Due:`, which ZoomIn ignores.\n"

    # --- categories folder ----------------------------------------------------------
    for name in ("Task", "Projects", "Entry", "Meetings", "Idea", "Unused"):
        files[f"Categories/{name}.md"] = f"# {name}\n"

    # --- excluded scaffolding ----------------------------------------------------------
    files["Templates/Project template.md"] = (
        frontmatter(Parent='"[[Work]]"', categories=['"[[Projects]]"'])
        + "[[Work]] [[Chess]] [[Research]] [[Home]] [[Reading]]\n![[Tasks.base]]\n"
    )

    # --- filler: three more parents with children ----------------------------------------
    rng = random.Random(7)
    statuses = ["Exploring", "Exploring", "Unexplored", "Explored", None]
    categories = ["Task", "Task", "Idea", "Entry", "Meetings", "Reference", None]
    parents = {
        "Research": ("Reading papers and running things.", ["Attention", "Tokenisers", "Eval harness", "Reading group", "Lab notebook", "Scaling", "Data pipeline", "Compute budget", "Ablations", "Writeup", "Poster", "Reproduction"]),
        "Home": ("The flat and the people in it.", ["Lease", "Plants", "Kitchen", "Bike repair", "Insurance", "Dentist", "Taxes", "Birthday plan", "Groceries", "Laundry", "Bookshelf", "Move"]),
        "Reading": ("Books, in progress.", ["Middlemarch", "Gödel Escher Bach", "The Dispossessed", "Piranesi", "Notes on Camp", "Bluets", "Sapiens", "Dune", "Hyperion", "Solaris", "Ubik", "Kindred"]),
    }
    for parent, (blurb, children) in parents.items():
        files[f"{parent}.md"] = note(category="Projects", status="Exploring", description=blurb)
        for child in children:
            status = rng.choice(statuses)
            category = rng.choice(categories)
            deadline = d(rng.randint(-5, 20)) if category == "Task" and rng.random() < 0.4 else None
            cross = rng.choice(list(files)) if rng.random() < 0.3 else None
            body = f"Mentions [[{Path(cross).stem}]].\n" if cross and cross.endswith(".md") and "/" not in cross else ""
            files[f"{parent}/{child}.md"] = note(parent, category=category, status=status, deadline=deadline, body=body)

    # A subproject with its own children, to exercise inheritance and depth 2.
    files["Research/Eval harness.md"] = note("Research", category="Projects", status="Exploring")
    for child in ("Harness tests", "Harness docs", "Harness CI"):
        files[f"Research/{child}.md"] = note("Eval harness", category="Task", status="Exploring")

    # A parent with a lot of children, for the lens camera.
    files["Hub.md"] = note(category="Projects", status="Exploring", description="Twenty-nine children.")
    for index in range(29):
        files[f"Hub/Spoke {index + 1:02d}.md"] = note("Hub", category="Idea", status="Exploring")

    # Loose captures with no links at all, so the centering force has something to hold.
    for index in range(8):
        files[f"Daily/{(today - timedelta(days=index)).isoformat()}.md"] = f"Captured on day {index}.\n"

    return files


def write_vault(root: Path, fresh: bool) -> None:
    if fresh and root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    for rel, text in build(root, date.today()).items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".png"):
            path.write_bytes(b"\x89PNG\r\n\x1a\n")
        else:
            path.write_bytes(text.encode("utf-8"))

    config = root / ".obsidian"
    config.mkdir(exist_ok=True)
    (config / "app.json").write_text("{}\n")
    (config / "community-plugins.json").write_text(json.dumps(["zoomin"]) + "\n")
    plugins = config / "plugins"
    plugins.mkdir(exist_ok=True)
    link = plugins / "zoomin"
    if link.is_symlink() or link.exists():
        link.unlink()
    os.symlink(PLUGIN_DIR, link, target_is_directory=True)

    (root / ".gitignore").write_text(".obsidian/workspace.json\n.obsidian/plugins/zoomin/node_modules/\n")
    if not (root / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "add", "-A"], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "user.name=zoomin", "-c", "user.email=zoomin@localhost", "commit", "-q", "-m", "Synthetic vault"],
            cwd=root,
            check=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help=f"where to put the vault (default {DEFAULT_DIR})")
    parser.add_argument("--fresh", action="store_true", help="delete and recreate the vault")
    args = parser.parse_args()
    write_vault(args.dir, args.fresh)
    notes = sum(1 for p in args.dir.rglob("*.md") if ".obsidian" not in p.parts and ".git" not in p.parts)
    print(f"{args.dir}: {notes} notes; plugin symlinked at .obsidian/plugins/zoomin -> {PLUGIN_DIR}")


if __name__ == "__main__":
    main()
