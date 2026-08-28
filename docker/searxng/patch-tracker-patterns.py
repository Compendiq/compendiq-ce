#!/usr/bin/env python3
"""Add a bundled ClearURLs fallback to the upstream SearXNG loader."""

from __future__ import annotations

from pathlib import Path
import sys

IMPORT_ANCHOR = "import re\n"
IMPORT_REPLACEMENT = "import json\nimport re\n"

RULE_TYPE_ANCHOR = 'RuleType = tuple[str, list[str], list[str]]\n'
RULE_TYPE_REPLACEMENT = (
    RULE_TYPE_ANCHOR
    + '\nTRACKER_PATTERNS_FALLBACK = "/usr/local/share/compendiq/'
    + 'tracker-patterns-baseline.json"\n'
)

LOAD_ANCHOR = '''        if resp is None:
            log.error("TRACKER_PATTERNS: failed fetching ClearURL rule lists")
            return

        for rule in resp.json()["providers"].values():
'''
LOAD_REPLACEMENT = '''        if resp is not None and resp.status_code == 200:
            data = resp.json()
        else:
            log.warning(
                "TRACKER_PATTERNS: remote rule lists unavailable; loading bundled baseline %s",
                TRACKER_PATTERNS_FALLBACK,
            )
            with open(TRACKER_PATTERNS_FALLBACK, encoding="utf-8") as fallback:
                data = json.load(fallback)

        for rule in data["providers"].values():
'''


def replace_once(source: str, anchor: str, replacement: str, label: str) -> str:
    count = source.count(anchor)
    if count != 1:
        raise RuntimeError(
            f"upstream tracker_patterns.py changed: expected one {label}, found {count}"
        )
    return source.replace(anchor, replacement, 1)


def patch(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    source = replace_once(source, IMPORT_ANCHOR, IMPORT_REPLACEMENT, "import anchor")
    source = replace_once(
        source, RULE_TYPE_ANCHOR, RULE_TYPE_REPLACEMENT, "RuleType anchor"
    )
    source = replace_once(source, LOAD_ANCHOR, LOAD_REPLACEMENT, "fallback anchor")
    compile(source, str(path), "exec")
    path.write_text(source, encoding="utf-8")
    # The upstream image ships unchecked-hash bytecode, which Python may load
    # without comparing the edited source. Remove every cache for this module
    # so the patched source is compiled on first import.
    path.with_suffix(".pyc").unlink(missing_ok=True)
    for bytecode in (path.parent / "__pycache__").glob(f"{path.stem}.*.pyc"):
        bytecode.unlink()


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} TRACKER_PATTERNS_PY", file=sys.stderr)
        return 2
    try:
        patch(Path(sys.argv[1]))
    except (OSError, RuntimeError, SyntaxError) as exc:
        print(f"patch-tracker-patterns: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
