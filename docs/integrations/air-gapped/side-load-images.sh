#!/usr/bin/env bash
# side-load-images.sh — pack + load Compendiq images for air-gapped deploys.
#
# Usage:
#   # On the relay (internet-connected) host:
#   ./side-load-images.sh pack <version> <output.tar>
#     e.g. ./side-load-images.sh pack v0.4.0 compendiq-ce-v0.4.0.tar
#
#   # On the air-gapped host:
#   ./side-load-images.sh load <input.tar>
#     e.g. ./side-load-images.sh load compendiq-ce-v0.4.0.tar
#
# Packs the four Compendiq CE images at the requested version into a
# tarball; on the other side, loads them back into the local Docker
# daemon with the original tags so `docker compose up` finds them
# locally instead of trying GHCR.

set -euo pipefail

IMAGES=(
    "ghcr.io/compendiq/compendiq-ce-frontend"
    "ghcr.io/compendiq/compendiq-ce-backend"
    "ghcr.io/compendiq/compendiq-ce-searxng"
    "ghcr.io/compendiq/compendiq-ce-mcp-docs"
    # Third-party images the compose file pulls. Pin to the tags actually
    # used in docker/docker-compose.yml — update this list when those pin
    # versions change.
    "pgvector/pgvector:pg17"
    "redis:8-alpine"
)

usage() {
    cat >&2 <<EOF
Usage:
    $0 pack <version-tag> <output.tar>
    $0 load <input.tar>

Examples:
    $0 pack v0.4.0 compendiq-ce-v0.4.0.tar
    $0 load compendiq-ce-v0.4.0.tar
EOF
    exit 1
}

cmd=${1:-}
if [[ -z "$cmd" ]]; then usage; fi
shift

case "$cmd" in
    pack)
        [[ $# -eq 2 ]] || usage
        version=$1
        out=$2
        echo "→ Pulling Compendiq images at tag: $version"
        pulls=()
        for img in "${IMAGES[@]}"; do
            # Use the requested version tag for the Compendiq images; leave
            # the third-party pin-tag alone (they already embed a tag).
            if [[ "$img" == ghcr.io/compendiq/* ]]; then
                full="$img:$version"
            else
                full="$img"
            fi
            echo "  • $full"
            docker pull "$full"
            pulls+=("$full")
        done
        echo "→ Saving ${#pulls[@]} image(s) to $out ..."
        docker save -o "$out" "${pulls[@]}"
        size=$(du -h "$out" | awk '{print $1}')
        echo "✓ Packed $out ($size)"
        ;;
    load)
        [[ $# -eq 1 ]] || usage
        input=$1
        [[ -f "$input" ]] || { echo "error: not found: $input" >&2; exit 2; }
        echo "→ Loading images from $input ..."
        docker load -i "$input"
        echo "✓ Load complete. Loaded images:"
        docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' \
            | grep -E 'compendiq|pgvector|redis'
        ;;
    *)
        usage
        ;;
esac
