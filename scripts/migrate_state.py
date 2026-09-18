"""Carry the pywebview app's state into the plugin's data.json. Run once, at cut-over.

Reads the app's SQLite store (schema version 6) and its config, and writes the
JSON the plugin loads:

  * domains, in creation order (which is hue order), retired ones included so
    the slot history still refers to something;
  * assignments, tombstones included, keyed by note *path* — the app keyed
    them on a minted note_id, which the plugin no longer needs because
    Obsidian reports renames;
  * slots and the whole slot history;
  * datatypes (shape and project flag) and per-note project rulings;
  * manual task order per list;
  * slot caps, as settings;
  * node positions, under a `positions` key the plugin imports into its
    per-device storage on first load and then drops from the file — positions
    are the one thing that must not sync between machines (decision 39).

Rows naming a note the app never saw (a note table miss) are skipped and
counted. Nothing is written to the database.

Usage:

    uv run python plugin/scripts/migrate_state.py [--db PATH] [--config PATH] \
        [--out <vault>/.obsidian/plugins/zoomin/data.json]

With no --out the JSON goes to stdout. The defaults are the app's real files
under ~/Library/Application Support/ZoomIn/ — they are opened read-only.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tomllib
from pathlib import Path

APP_DIR = Path.home() / "Library" / "Application Support" / "ZoomIn"
STORE_VERSION = 1


def read_config(path: Path) -> dict:
    try:
        with open(path, "rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def migrate(db_path: Path, config_path: Path) -> tuple[dict, dict[str, int]]:
    uri = f"file:{db_path}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version < 6:
        sys.exit(f"{db_path} is schema version {version}; run the app once to bring it to 6 first")

    skipped = {"assignments": 0, "slots": 0, "overrides": 0, "task_order": 0}
    paths = {row["note_id"]: row["path"] for row in connection.execute("SELECT note_id, path FROM note")}

    domains = [
        {
            "id": row["domain_id"],
            "name": row["name"],
            "createdAt": row["created_at"],
            "retiredAt": row["retired_at"],
        }
        for row in connection.execute("SELECT domain_id, name, created_at, retired_at FROM domain ORDER BY created_at, rowid")
    ]

    assignments: dict[str, str | None] = {}
    for row in connection.execute("SELECT note_id, domain_id FROM domain_project"):
        path = paths.get(row["note_id"])
        if path is None:
            skipped["assignments"] += 1
            continue
        assignments[path] = row["domain_id"]

    slots = []
    for row in connection.execute("SELECT kind, domain_id, note_id, since FROM slot ORDER BY since, slot_id"):
        if row["kind"] == "domain":
            key = row["domain_id"]
        else:
            key = paths.get(row["note_id"])
            if key is None:
                skipped["slots"] += 1
                continue
        slots.append({"kind": row["kind"], "key": key, "since": row["since"]})

    history = [
        {"ts": row["ts"], "kind": row["kind"], "action": row["action"], "key": row["occupant_path"]}
        for row in connection.execute("SELECT ts, kind, action, occupant_path FROM slot_history ORDER BY seq")
        if row["occupant_path"] is not None
    ]

    datatypes = [
        {
            "id": row["datatype_id"],
            "name": row["name"],
            "shape": row["shape"],
            "isProject": bool(row["is_project"]),
            "createdAt": row["created_at"],
        }
        for row in connection.execute("SELECT datatype_id, name, shape, is_project, created_at FROM datatype ORDER BY created_at, rowid")
    ]

    overrides: dict[str, bool] = {}
    for row in connection.execute("SELECT note_id, is_project FROM project_override"):
        path = paths.get(row["note_id"])
        if path is None:
            skipped["overrides"] += 1
            continue
        overrides[path] = bool(row["is_project"])

    task_order: dict[str, list[str]] = {}
    for row in connection.execute("SELECT list_key, note_id FROM task_order ORDER BY list_key, position"):
        path = paths.get(row["note_id"])
        if path is None:
            skipped["task_order"] += 1
            continue
        task_order.setdefault(row["list_key"], []).append(path)
    # A focus list's key names its project by path already; nothing to translate.

    positions = {row["node_id"]: [row["x"], row["y"]] for row in connection.execute("SELECT node_id, x, y FROM node_position")}

    config = read_config(config_path)
    settings = {
        "domainSlots": int(config.get("domain_slots", 3)),
        "projectSlots": int(config.get("project_slots", 1)),
        "followActiveFile": True,
    }

    data = {
        "settings": settings,
        "store": {
            "version": STORE_VERSION,
            "domains": domains,
            "assignments": assignments,
            "slots": slots,
            "slotHistory": history,
            "datatypes": datatypes,
            "projectOverrides": overrides,
            "taskOrder": task_order,
        },
        "positions": positions,
    }
    return data, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=APP_DIR / "state.db")
    parser.add_argument("--config", type=Path, default=APP_DIR / "config.toml")
    parser.add_argument("--out", type=Path, default=None, help="data.json to write (default: stdout)")
    args = parser.parse_args()

    data, skipped = migrate(args.db, args.config)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)

    store = data["store"]
    live = sum(1 for d in store["domains"] if d["retiredAt"] is None)
    summary = (
        f"{live} live domains ({len(store['domains'])} incl. retired), {len(store['assignments'])} assignments, "
        f"{len(store['slots'])} slots, {len(store['slotHistory'])} history rows, {len(store['datatypes'])} datatypes, "
        f"{len(store['projectOverrides'])} rulings, {sum(len(v) for v in store['taskOrder'].values())} ordered tasks, "
        f"{len(data['positions'])} positions"
    )
    dropped = {k: v for k, v in skipped.items() if v}
    if dropped:
        summary += f"; skipped rows naming unknown notes: {dropped}"
    print(summary, file=sys.stderr)


if __name__ == "__main__":
    main()
