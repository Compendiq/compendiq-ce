#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SEARXNG_SMOKE_IMAGE:-compendiq-searxng-fallback-smoke:${GITHUB_SHA:-local}}"

echo "Building current derived SearXNG image as ${IMAGE}"
docker build --pull --tag "${IMAGE}" "${SCRIPT_DIR}"

if ! output="$({
  docker run --rm \
    --network none \
    --entrypoint /usr/local/searxng/.venv/bin/python \
    "${IMAGE}" \
    -c '
from pathlib import Path
from searx.data.tracker_patterns import TRACKER_PATTERNS_FALLBACK, TrackerPatternsDB

source = "https://example.com/article?utm_source=offline-smoke&keep=1"
expected = "https://example.com/article?keep=1"
fallback = Path(TRACKER_PATTERNS_FALLBACK)
if not fallback.is_file():
    raise SystemExit(f"bundled fallback is missing: {fallback}")

cleaned = TrackerPatternsDB().clean_url(source)
if cleaned != expected:
    raise SystemExit(f"tracker cleanup mismatch: expected {expected!r}, got {cleaned!r}")

print(f"TRACKER_FALLBACK_PATH={fallback}")
print(f"TRACKER_CLEANUP_OK={cleaned}")
' 2>&1
})"; then
  printf '%s\n' "${output}" >&2
  echo "SearXNG offline fallback runtime smoke failed" >&2
  exit 1
fi

printf '%s\n' "${output}"
case "${output}" in
  *"remote rule lists unavailable; loading bundled baseline"*) ;;
  *)
    echo "SearXNG did not report loading the bundled fallback" >&2
    exit 1
    ;;
esac
case "${output}" in
  *"TRACKER_CLEANUP_OK=https://example.com/article?keep=1"*) ;;
  *)
    echo "SearXNG did not produce the expected observable tracker cleanup" >&2
    exit 1
    ;;
esac

echo "SearXNG offline fallback runtime smoke passed"
