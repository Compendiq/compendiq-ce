#!/bin/sh
set -e

# Apply defaults for unset variables
export SEARXNG_LIMITER="${SEARXNG_LIMITER:-false}"
export SEARXNG_IMAGE_PROXY="${SEARXNG_IMAGE_PROXY:-false}"
export SEARXNG_SECRET_KEY="${SEARXNG_SECRET_KEY:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"

# Generate settings from template using Python's string.Template
# Only substitutes explicitly listed $VARIABLES to prevent accidental replacement
python3 -c "
import os, string
with open('/etc/searxng/settings.yml.template') as f:
    tmpl = string.Template(f.read())
result = tmpl.safe_substitute(
    SEARXNG_LIMITER=os.environ['SEARXNG_LIMITER'],
    SEARXNG_IMAGE_PROXY=os.environ['SEARXNG_IMAGE_PROXY'],
    SEARXNG_SECRET_KEY=os.environ['SEARXNG_SECRET_KEY'],
)
with open('/etc/searxng/settings.yml', 'w') as f:
    f.write(result)
"

# Hand off to the upstream SearXNG entrypoint
exec /usr/local/searxng/entrypoint.sh
