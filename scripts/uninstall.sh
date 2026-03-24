#!/usr/bin/env bash
# =============================================================================
# AtlasMind — Uninstaller
#
# Usage:
#   bash scripts/uninstall.sh
#   bash scripts/uninstall.sh --dir /opt/atlasmind
#
# Options:
#   --dir DIR            Installation directory (default: $HOME/atlasmind)
#   --yes                Skip interactive prompts (same as ATLASMIND_CONFIRM=yes)
#   --help               Show this help message
#
# Environment variables (all optional, overridden by CLI flags):
#   INSTALL_DIR          Installation directory (default: $HOME/atlasmind)
#   ATLASMIND_CONFIRM    Set to "yes" to skip interactive prompts
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
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
# Logging
# ---------------------------------------------------------------------------
info()  { printf '%b[info]%b  %s\n' "$BLUE" "$RESET" "$*"; }
ok()    { printf '%b[ok]%b    %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%b[warn]%b  %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err()   { printf '%b[error]%b %s\n' "$RED" "$RESET" "$*" >&2; }
die()   { err "$@"; exit 1; }

# ---------------------------------------------------------------------------
# Prompt helper (defaults to No)
# ---------------------------------------------------------------------------
confirm() {
  local prompt="$1"
  local reply

  # Auto-confirm if env var is set
  if [ "${ATLASMIND_CONFIRM:-}" = "yes" ]; then
    return 0
  fi

  # Non-interactive — default to abort
  if [ ! -t 0 ]; then
    err "Non-interactive shell detected. Run this script directly (not piped) or set ATLASMIND_CONFIRM=yes."
    exit 1
  fi

  printf '%b%s [y/N]%b ' "$YELLOW" "$prompt" "$RESET"
  read -r reply
  case "$reply" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ -n "${2:-}" ] || die "--dir requires a value"
        INSTALL_DIR="$2"; shift 2 ;;
      --yes|-y)
        ATLASMIND_CONFIRM="yes"; shift ;;
      --help|-h)
        printf 'Usage: bash uninstall.sh [--dir DIR] [--yes] [--help]\n'
        printf '  --dir DIR   Installation directory (default: $HOME/atlasmind)\n'
        printf '  --yes       Skip interactive prompts\n'
        printf '  --help      Show this help message\n'
        exit 0 ;;
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

  INSTALL_DIR="${INSTALL_DIR:-${HOME}/atlasmind}"

  printf '\n%b%bAtlasMind Uninstaller%b\n\n' "$CYAN" "$BOLD" "$RESET"

  # ---- Validate ----
  if [ ! -d "$INSTALL_DIR" ]; then
    die "Installation directory not found: ${INSTALL_DIR}"
  fi

  if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    die "No docker-compose.yml found in ${INSTALL_DIR} — is this an AtlasMind installation?"
  fi

  info "Installation directory: ${INSTALL_DIR}"

  # ---- Confirm ----
  if ! confirm "This will stop and remove all AtlasMind containers. Continue?"; then
    info "Aborted."
    exit 0
  fi

  # ---- Stop containers ----
  info "Stopping containers..."
  cd "$INSTALL_DIR"

  if docker compose ps --quiet 2>/dev/null | grep -q .; then
    docker compose down
    ok "Containers stopped and removed"
  else
    ok "No running containers found"
  fi

  # ---- Optionally remove volumes (data) ----
  printf '\n'
  if confirm "Remove all data (database, attachments)? This cannot be undone!"; then
    info "Removing Docker volumes..."
    docker compose down -v 2>/dev/null || true
    ok "Volumes removed"
  else
    info "Keeping data volumes — you can remove them later with: docker volume prune"
  fi

  # ---- Remove installation directory ----
  printf '\n'
  if confirm "Remove installation directory (${INSTALL_DIR})?"; then
    cd "$HOME"
    rm -rf "$INSTALL_DIR"
    ok "Installation directory removed"
  else
    info "Keeping installation directory"
  fi

  printf '\n%b%bAtlasMind has been uninstalled.%b\n\n' "$GREEN" "$BOLD" "$RESET"
}

main "$@"
