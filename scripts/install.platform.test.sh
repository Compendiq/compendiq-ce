#!/usr/bin/env bash
# Exercise the real installer generator and Compose parser for both daemon
# defaults. No containers, networks or volumes are created.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
# install.sh normally invokes main; load the same generator without starting a stack.
eval "$(sed 's/^main "\$@"//' "$SCRIPT_DIR/install.sh")"
setup_colors
export POSTGRES_PASSWORD=disposable REDIS_PASSWORD=disposable
export JWT_SECRET=disposable-test-secret PAT_ENCRYPTION_KEY=disposable-test-key
for host in linux/amd64 linux/arm64; do
  for tag in dev latest 0.9.1; do
    export DOCKER_DEFAULT_PLATFORM="$host" COMPENDIQ_VERSION="$tag"
    write_compose "$TEST_DIR/docker-compose.yml"
    docker compose --project-name epic1826-platform-test -f "$TEST_DIR/docker-compose.yml" config --format json > "$TEST_DIR/config.json"
    node - "$TEST_DIR/config.json" "$tag" "$host" <<'NODE'
const fs = require('fs');
const [file, tag, host] = process.argv.slice(2);
const { services } = JSON.parse(fs.readFileSync(file, 'utf8'));
const expected = tag === 'dev' || tag === 'latest' ? 'linux/amd64' : undefined;
for (const name of ['frontend', 'backend', 'mcp-docs', 'searxng']) {
  if (services[name].platform !== expected || services[name].image !== `ghcr.io/compendiq/compendiq-ce-${name}:${tag}`)
    throw new Error(`${host} ${tag} ${name}: ${JSON.stringify(services[name])}`);
}
for (const name of ['postgres', 'redis']) {
  if (services[name].platform !== undefined) throw new Error(`${host} ${tag}: ${name} is pinned`);
}
console.log(`PASS simulated ${host} tag ${tag}: four image selections; data tier unpinned`);
NODE
  done
done
