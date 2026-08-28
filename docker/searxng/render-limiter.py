#!/usr/bin/env python3
"""Render SearXNG's limiter config with a validated trusted-proxy list."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile

DEFAULT_TRUSTED_PROXIES = ("127.0.0.0/8", "::1")
TRUSTED_PROXIES_BLOCK = re.compile(
    r"^trusted_proxies = \[\n(?:^  .*\n)*?^\]\n",
    flags=re.MULTILINE,
)


def trusted_proxies_from_env() -> list[str]:
    configured = os.environ.get("SEARXNG_TRUSTED_PROXIES", "").strip()
    if not configured:
        return list(DEFAULT_TRUSTED_PROXIES)

    raw_entries = configured.split(",")
    if any(not entry.strip() for entry in raw_entries):
        raise ValueError("invalid trusted proxy: empty entry")

    proxies: list[str] = []
    for raw_entry in raw_entries:
        entry = raw_entry.strip()
        try:
            network = ipaddress.ip_network(entry, strict=False)
        except ValueError as exc:
            raise ValueError(f"invalid trusted proxy {entry!r}: {exc}") from exc
        normalized = network.with_prefixlen
        if normalized not in proxies:
            proxies.append(normalized)
    return proxies


def render(source: Path, output: Path) -> None:
    template = source.read_text(encoding="utf-8")
    proxies = trusted_proxies_from_env()
    replacement = "trusted_proxies = [\n" + "".join(
        f"  {json.dumps(proxy)},\n" for proxy in proxies
    ) + "]\n"
    rendered, count = TRUSTED_PROXIES_BLOCK.subn(replacement, template)
    if count != 1:
        raise RuntimeError(
            f"expected one trusted_proxies block in {source}, found {count}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=output.parent, delete=False
    ) as temporary:
        temporary.write(rendered)
        temporary_path = Path(temporary.name)
    temporary_path.replace(output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("/usr/local/share/compendiq/limiter.toml"),
    )
    parser.add_argument(
        "--output", type=Path, default=Path("/etc/searxng/limiter.toml")
    )
    args = parser.parse_args()

    try:
        render(args.source, args.output)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"render-limiter: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
