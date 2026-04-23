#!/usr/bin/env bash
# make-ca-bundle.sh — concatenate PEM files into a Node-compatible CA bundle.
#
# Usage:
#   ./make-ca-bundle.sh intermediate.pem root.pem > corp-ca-bundle.pem
#
# Order matters: list intermediates first and the root last. The script
# validates each file is a PEM-formatted certificate, strips BOM / CRLF,
# and emits a clean LF-terminated bundle to stdout.
#
# Exits non-zero if any input file is missing or not a recognisable PEM.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <intermediate.pem> [more.pem...] [root.pem]" >&2
    echo "Concatenates PEM files into a Node.js-compatible CA bundle on stdout." >&2
    exit 1
fi

for pem in "$@"; do
    if [[ ! -f "$pem" ]]; then
        echo "error: file not found: $pem" >&2
        exit 2
    fi
    if ! grep -q "^-----BEGIN CERTIFICATE-----" "$pem"; then
        echo "error: $pem does not contain a PEM certificate" >&2
        exit 3
    fi
done

for pem in "$@"; do
    # Strip BOM if present, normalise line endings to LF, trim trailing whitespace.
    sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$pem"
    # Ensure each file ends with a newline so the next -----BEGIN----- starts on its own line.
    tail -c1 "$pem" | read -r _ || echo
done

# Sanity: print the cert count on stderr so the caller can eyeball it.
count=$(grep -c "^-----BEGIN CERTIFICATE-----" "$@" | awk -F: '{s+=$NF} END {print s}')
echo "make-ca-bundle: wrote $count certificate(s) from $# file(s)" >&2
