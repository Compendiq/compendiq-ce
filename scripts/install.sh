#!/usr/bin/env bash
# =============================================================================
# AtlasMind — One-Command Docker Installer
# https://github.com/diinlu/atlasmind
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/diinlu/atlasmind/main/scripts/install.sh | bash
#   curl ... | bash -s -- --dir /opt/atlasmind --port 9090
#   bash install.sh --dir /opt/atlasmind --port 9090 --version 1.2.0
#
# Options:
#   --dir DIR          Installation directory  (default: $HOME/atlasmind)
#   --port PORT        Frontend port           (default: 8080)
#   --version TAG      Image tag               (default: latest)
#   --help             Show this help message
#
# Environment variables (all optional, overridden by CLI flags):
#   INSTALL_DIR        Installation directory  (default: $HOME/atlasmind)
#   ATLASMIND_PORT     Frontend port           (default: 8080)
#   ATLASMIND_VERSION  Image tag               (default: latest)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers — disabled when stdout is not a terminal or NO_COLOR is set
# ---------------------------------------------------------------------------
setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    RESET='\033[0m'
  else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
  fi
}

# ---------------------------------------------------------------------------
# Logging — use %b to interpret escape sequences from color variables
# ---------------------------------------------------------------------------
info()  { printf '%b[info]%b  %s\n' "$BLUE" "$RESET" "$*"; }
ok()    { printf '%b[ok]%b    %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%b[warn]%b  %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err()   { printf '%b[error]%b %s\n' "$RED" "$RESET" "$*" >&2; }
die()   { err "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
banner() {
  printf '\n'
  printf '%b%b' "$CYAN" "$BOLD"
  printf '    _   _   _           __  __ _           _\n'
  printf '   / \\ | |_| | __ _ ___|  \\/  (_)_ __   __| |\n'
  printf '  / _ \\| __| |/ _` / __| |\\/| | | '"'"'_ \\ / _` |\n'
  printf ' / ___ \\ |_| | (_| \\__ \\ |  | | | | | | (_| |\n'
  printf '/_/   \\_\\__|_|\\__,_|___/_|  |_|_|_| |_|\\__,_|\n'
  printf '%b\n' "$RESET"
  printf '%b  AI-powered knowledge base management%b\n\n' "$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
  fi

  if ! docker info >/dev/null 2>&1; then
    die "Docker daemon is not running. Please start Docker and try again."
  fi

  ok "Docker is installed and running"
}

check_docker_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is required (docker compose, not docker-compose). Update Docker or install the compose plugin."
  fi

  ok "Docker Compose v2 is available"
}

check_openssl() {
  if ! command -v openssl >/dev/null 2>&1; then
    die "openssl is required to generate secrets. Install it and try again."
  fi
}

# ---------------------------------------------------------------------------
# Secret generation
# ---------------------------------------------------------------------------
generate_secret() {
  local length="$1"
  openssl rand -base64 "$length" | tr -d '/+=' | head -c "$length"
}

# ---------------------------------------------------------------------------
# Detect WSL
# ---------------------------------------------------------------------------
is_wsl() {
  if [ -f /proc/version ]; then
    grep -qi microsoft /proc/version 2>/dev/null && return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Try to open a URL in the user's browser
# ---------------------------------------------------------------------------
try_open_browser() {
  local url="$1"

  # Skip on WSL — the browser is on the Windows side and xdg-open often fails
  if is_wsl; then
    return 0
  fi

  if command -v open >/dev/null 2>&1; then
    open "$url" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Write .env file
# ---------------------------------------------------------------------------
write_env() {
  local env_file="$1"

  # Only generate secrets on first install — preserve existing .env
  if [ -f "$env_file" ]; then
    warn ".env already exists — keeping existing secrets"
    return 0
  fi

  check_openssl

  local jwt_secret
  local pat_key
  local pg_password
  local redis_password
  local timestamp

  jwt_secret="$(generate_secret 48)"
  pat_key="$(generate_secret 48)"
  pg_password="$(generate_secret 24)"
  redis_password="$(generate_secret 24)"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  info "Generating cryptographically secure secrets..."

  cat > "$env_file" <<ENVEOF
# =============================================================================
# AtlasMind — Auto-generated environment file
# Generated on ${timestamp}
# =============================================================================

# --- Required Secrets (auto-generated, do NOT share) ---
JWT_SECRET=${jwt_secret}
PAT_ENCRYPTION_KEY=${pat_key}

# --- PostgreSQL ---
POSTGRES_USER=kb_user
POSTGRES_PASSWORD=${pg_password}
POSTGRES_DB=kb_creator

# --- Redis ---
REDIS_PASSWORD=${redis_password}

# --- LLM Provider (configure after install via Setup Wizard) ---
# LLM_PROVIDER=ollama
# OLLAMA_BASE_URL=http://host.docker.internal:11434
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_API_KEY=

# --- Misc ---
# LOG_LEVEL=info
ENVEOF

  chmod 600 "$env_file"
  ok "Secrets generated and written to .env"
}

# ---------------------------------------------------------------------------
# Write docker-compose.yml
# ---------------------------------------------------------------------------
write_compose() {
  local compose_file="$1"
  local version="${ATLASMIND_VERSION:-latest}"
  local port="${ATLASMIND_PORT:-8080}"

  # Always overwrite compose file — it is declarative and versioned
  info "Writing docker-compose.yml (frontend on port ${port})..."

  # Use quoted heredoc to prevent shell expansion — the compose file uses
  # ${VAR} syntax for Docker Compose variable interpolation, not shell.
  # We inject version/port via sed afterwards.
  cat > "$compose_file" <<'COMPOSEEOF'
# =============================================================================
# AtlasMind — Production Docker Compose
# Generated by install.sh — safe to regenerate (secrets are in .env)
# =============================================================================

services:
  frontend:
    image: diinlu/atlasmind-frontend:__VERSION__
    ports:
      - "__PORT__:8081"
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8081/"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - frontend

  backend:
    image: diinlu/atlasmind-backend:__VERSION__
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      NODE_ENV: production
      BACKEND_PORT: "3051"
      POSTGRES_URL: postgresql://${POSTGRES_USER:-kb_user}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-kb_creator}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
      PAT_ENCRYPTION_KEY: ${PAT_ENCRYPTION_KEY:?PAT_ENCRYPTION_KEY is required}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
      LLM_PROVIDER: ${LLM_PROVIDER:-ollama}
      OPENAI_BASE_URL: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      EMBEDDING_MODEL: ${EMBEDDING_MODEL:-nomic-embed-text}
      LLM_BEARER_TOKEN: ${LLM_BEARER_TOKEN:-}
      LLM_AUTH_TYPE: ${LLM_AUTH_TYPE:-bearer}
      LLM_VERIFY_SSL: ${LLM_VERIFY_SSL:-true}
      FRONTEND_URL: http://localhost:__PORT__
      DEFAULT_LLM_MODEL: ${DEFAULT_LLM_MODEL:-}
      QUALITY_MODEL: ${QUALITY_MODEL:-}
      QUALITY_CHECK_INTERVAL_MINUTES: ${QUALITY_CHECK_INTERVAL_MINUTES:-60}
      QUALITY_BATCH_SIZE: ${QUALITY_BATCH_SIZE:-5}
      SUMMARY_MODEL: ${SUMMARY_MODEL:-}
      SUMMARY_CHECK_INTERVAL_MINUTES: ${SUMMARY_CHECK_INTERVAL_MINUTES:-60}
      SUMMARY_BATCH_SIZE: ${SUMMARY_BATCH_SIZE:-5}
      SYNC_INTERVAL_MIN: ${SYNC_INTERVAL_MIN:-15}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      CONFLUENCE_VERIFY_SSL: ${CONFLUENCE_VERIFY_SSL:-true}
      ATTACHMENTS_DIR: /app/data/attachments
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    volumes:
      - attachments-data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3051/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    networks:
      - frontend
      - backend

  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-kb_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-kb_creator}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-kb_user} -d ${POSTGRES_DB:-kb_creator}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - backend

  redis:
    image: redis:8-alpine
    command: >
      redis-server
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --requirepass ${REDIS_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "REDISCLI_AUTH=${REDIS_PASSWORD} redis-cli ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - backend

volumes:
  postgres-data:
  attachments-data:

networks:
  frontend:
  backend:
    internal: true
COMPOSEEOF

  # Replace placeholders with actual values
  sed "s|__VERSION__|${version}|g; s|__PORT__|${port}|g" "$compose_file" > "${compose_file}.tmp"
  mv "${compose_file}.tmp" "$compose_file"

  ok "docker-compose.yml written"
}

# ---------------------------------------------------------------------------
# Pull images
# ---------------------------------------------------------------------------
pull_images() {
  info "Pulling latest images (this may take a few minutes)..."
  docker compose pull
  ok "Images pulled"
}

# ---------------------------------------------------------------------------
# Start services
# ---------------------------------------------------------------------------
start_services() {
  info "Starting AtlasMind..."
  docker compose up -d
  ok "Containers started"
}

# ---------------------------------------------------------------------------
# Wait for the backend health check
# ---------------------------------------------------------------------------
wait_for_health() {
  local max_wait=60
  local waited=0
  local check_interval=3

  info "Waiting for AtlasMind to become healthy (max ${max_wait}s)..."

  # The backend is on an internal network — use docker compose exec to reach it
  while [ "$waited" -lt "$max_wait" ]; do
    if docker compose exec -T backend node -e \
      "fetch('http://127.0.0.1:3051/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      printf '\n'
      ok "AtlasMind is healthy"
      return 0
    fi
    sleep "$check_interval"
    waited=$((waited + check_interval))
    printf '%b.%b' "$DIM" "$RESET"
  done

  printf '\n'
  warn "Health check timed out after ${max_wait}s — the service may still be starting."
  warn "Check logs with: cd ${INSTALL_DIR} && docker compose logs -f"
  return 1
}

# ---------------------------------------------------------------------------
# Success banner
# ---------------------------------------------------------------------------
success_banner() {
  local port="${ATLASMIND_PORT:-8080}"
  local dir="${INSTALL_DIR}"

  printf '\n'
  printf '%b%bAtlasMind is ready!%b\n\n' "$GREEN" "$BOLD" "$RESET"
  printf '  Open %b%bhttp://localhost:%s%b to start the setup wizard.\n\n' "$CYAN" "$BOLD" "$port" "$RESET"
  printf '  %bInstallation directory:%b %s\n' "$DIM" "$RESET" "$dir"
  printf '  %bStop:%b    cd %s && docker compose down\n' "$DIM" "$RESET" "$dir"
  printf '  %bUpdate:%b  cd %s && docker compose pull && docker compose up -d\n' "$DIM" "$RESET" "$dir"
  printf '  %bLogs:%b    cd %s && docker compose logs -f\n' "$DIM" "$RESET" "$dir"
  printf '  %bRemove:%b  curl -fsSL https://raw.githubusercontent.com/diinlu/atlasmind/main/scripts/uninstall.sh | bash\n' "$DIM" "$RESET"
  printf '\n'
}

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
usage() {
  setup_colors
  printf '%bUsage:%b\n' "$BOLD" "$RESET"
  printf '  bash install.sh [OPTIONS]\n'
  printf '  curl -fsSL .../install.sh | bash -s -- [OPTIONS]\n\n'
  printf '%bOptions:%b\n' "$BOLD" "$RESET"
  printf '  --dir DIR          Installation directory  (default: $HOME/atlasmind)\n'
  printf '  --port PORT        Frontend port           (default: 8080)\n'
  printf '  --version TAG      Docker image tag        (default: latest)\n'
  printf '  --help             Show this help message\n\n'
  printf '%bEnvironment variables (overridden by CLI flags):%b\n' "$BOLD" "$RESET"
  printf '  INSTALL_DIR        Installation directory\n'
  printf '  ATLASMIND_PORT     Frontend port\n'
  printf '  ATLASMIND_VERSION  Image tag\n'
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing — CLI flags override environment variables
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ -n "${2:-}" ] || die "--dir requires a value"
        INSTALL_DIR="$2"; shift 2 ;;
      --port)
        [ -n "${2:-}" ] || die "--port requires a value"
        ATLASMIND_PORT="$2"; shift 2 ;;
      --version)
        [ -n "${2:-}" ] || die "--version requires a value"
        ATLASMIND_VERSION="$2"; shift 2 ;;
      --help|-h)
        usage ;;
      *)
        die "Unknown option: $1 (use --help for usage)" ;;
    esac
  done
}

# =============================================================================
# Main
# =============================================================================
main() {
  setup_colors
  parse_args "$@"
  banner

  # ---- Pre-flight ----
  check_docker
  check_docker_compose

  # ---- Install directory (CLI flag > env var > default) ----
  INSTALL_DIR="${INSTALL_DIR:-${HOME}/atlasmind}"
  info "Install directory: ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # ---- Generate config ----
  write_env "${INSTALL_DIR}/.env"
  write_compose "${INSTALL_DIR}/docker-compose.yml"

  # ---- Pull & start ----
  pull_images
  start_services

  # ---- Health check ----
  if wait_for_health; then
    success_banner
    try_open_browser "http://localhost:${ATLASMIND_PORT:-8080}"
  else
    printf '\n'
    info "AtlasMind containers are running but the health check timed out."
    info "Try visiting http://localhost:${ATLASMIND_PORT:-8080} in a minute."
    printf '\n'
  fi
}

main "$@"
